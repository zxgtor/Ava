import type {
  AvaCodeAgentCompletionEvidence,
  AvaCodeAgentDispatchResult,
  AvaCodeAgentEvent,
  AvaCodeAgentId,
  AvaCodeAgentProcessInfo,
  AvaCodeAgentProfile,
  AvaCodeAgentSelection,
  AvaCodeAgentSendMessageRequest,
  AvaCodeAgentSession,
  AvaCodeAgentSessionListResult,
  AvaCodeAgentTaskKind,
  AvaCodeAgentTaskRequest,
} from '@ava/contracts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { probeCodeAgents, type CodeAgentProbeResult } from './codeAgentProbe'
import { userDataFile } from './runtimePaths'

export interface CodeAgentDriver {
  id: AvaCodeAgentId
  name: string
  detect(): Promise<CodeAgentProbeResult | undefined>
  startSession(input: AvaCodeAgentTaskRequest): Promise<AvaCodeAgentSession>
  send(sessionId: string, message: string): Promise<AvaCodeAgentEvent>
  stop(sessionId: string): Promise<AvaCodeAgentEvent>
}

const CODE_AGENT_PROFILES: AvaCodeAgentProfile[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    strengths: ['feature', 'debug', 'refactor', 'research'],
    fallbackRank: 1,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    strengths: ['scaffold', 'feature', 'debug', 'refactor'],
    fallbackRank: 2,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    strengths: ['research', 'design', 'debug'],
    fallbackRank: 3,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    strengths: ['feature', 'debug', 'refactor'],
    fallbackRank: 4,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    command: 'openclaw',
    strengths: ['feature', 'debug'],
    fallbackRank: 5,
  },
]

interface CodeAgentAdapter {
  id: AvaCodeAgentId
  buildInvocation(session: AvaCodeAgentSession): CodeAgentInvocation
}

const CODE_AGENT_ADAPTERS: Record<AvaCodeAgentId, CodeAgentAdapter> = {
  'claude-code': {
    id: 'claude-code',
    buildInvocation: session => ({
      command: 'claude',
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--permission-mode',
        'auto',
        '--append-system-prompt',
        'You are running under Ava Code Agent Supervisor. Use tools when needed. Do not claim completion without changed files, validation results, and remaining risks.',
        session.taskPackage,
      ],
      cwd: session.task.workingDirectory || process.cwd(),
    }),
  },
  codex: {
    id: 'codex',
    buildInvocation: session => ({
      command: 'codex',
      args: [
        'exec',
        '--cd',
        session.task.workingDirectory || process.cwd(),
        '--sandbox',
        'danger-full-access',
        '--ask-for-approval',
        'never',
        '--color',
        'never',
        '--json',
        session.taskPackage,
      ],
      cwd: session.task.workingDirectory || process.cwd(),
    }),
  },
  gemini: {
    id: 'gemini',
    buildInvocation: session => ({
      command: 'gemini',
      args: [
        '--prompt',
        session.taskPackage,
        '--skip-trust',
        '--approval-mode',
        'yolo',
        '--yolo',
        '--output-format',
        'stream-json',
      ],
      cwd: session.task.workingDirectory || process.cwd(),
    }),
  },
  opencode: {
    id: 'opencode',
    buildInvocation: session => ({
      command: 'opencode',
      args: [
        'run',
        '--dir',
        session.task.workingDirectory || process.cwd(),
        '--format',
        'json',
        '--dangerously-skip-permissions',
        session.taskPackage,
      ],
      cwd: session.task.workingDirectory || process.cwd(),
    }),
  },
  openclaw: {
    id: 'openclaw',
    buildInvocation: session => ({
      command: 'openclaw',
      args: [
        '--no-color',
        'agent',
        '--message',
        session.taskPackage,
      ],
      cwd: session.task.workingDirectory || process.cwd(),
    }),
  },
}

const sessions = new Map<string, AvaCodeAgentSession>()
const runningProcesses = new Map<string, ChildProcessWithoutNullStreams>()
let sessionsLoaded = false
const MAX_PERSISTED_SESSIONS = 200

export function listCodeAgentProfiles(): AvaCodeAgentProfile[] {
  return CODE_AGENT_PROFILES
}

export async function dispatchCodeAgentTask(raw: AvaCodeAgentTaskRequest): Promise<AvaCodeAgentDispatchResult> {
  ensureSessionsLoaded()
  const request = normalizeTaskRequest(raw)
  const probes = await probeCodeAgents()
  const candidates = selectCodeAgentCandidates(request, probes)
  const selected = candidates.find(item => item.probe?.status === 'ready')

  if (!selected) {
    return {
      candidates,
      status: 'blocked',
      reason: request.preferredAgentId
        ? `Preferred code agent "${request.preferredAgentId}" is not ready, and no fallback code agent is available.`
        : 'No ready code agent is available on this workspace.',
    }
  }

  const session = createSession(request, selected)
  sessions.set(session.sessionId, session)
  persistSessions()
  const nextSession = request.startImmediately === true
    ? await startCodeAgentSession(session.sessionId)
    : session
  return {
    session: nextSession,
    candidates,
    status: 'assigned',
    reason: `Assigned task to ${selected.agent.name}.`,
  }
}

export function listCodeAgentSessions(): AvaCodeAgentSessionListResult {
  ensureSessionsLoaded()
  return {
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  }
}

export async function startCodeAgentSession(sessionId: unknown): Promise<AvaCodeAgentSession> {
  ensureSessionsLoaded()
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId is required.')
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown code agent session: ${sessionId}`)
  if (runningProcesses.has(sessionId)) return session
  if (session.status === 'completed' || session.status === 'failed' || session.status === 'stopped') return session

  const invocation = buildAgentInvocation(session)
  const starting = updateSession(sessionId, current => ({
    ...current,
    status: 'starting',
    process: {
      command: invocation.command,
      args: safeProcessArgs(current, invocation),
      cwd: invocation.cwd,
    },
    events: [
      ...current.events,
      createEvent(sessionId, 'starting', `Starting ${current.selected.agent.name}: ${formatCommand(invocation.command, invocation.args)}`),
    ],
    updatedAt: Date.now(),
  }))

  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    runningProcesses.set(sessionId, child)
    const startedAt = Date.now()
    updateSession(sessionId, current => ({
      ...current,
      status: 'running',
      process: {
        ...(current.process ?? {
          command: invocation.command,
          args: safeProcessArgs(current, invocation),
          cwd: invocation.cwd,
        }),
        pid: child.pid,
        startedAt,
      },
      events: [
        ...current.events,
        createEvent(sessionId, 'started', `Started ${current.selected.agent.name} process${child.pid ? ` pid ${child.pid}` : ''}.`),
      ],
      updatedAt: startedAt,
    }))

    child.stdout.on('data', chunk => appendProcessEvent(sessionId, 'stdout', chunk))
    child.stderr.on('data', chunk => appendProcessEvent(sessionId, 'stderr', chunk))
    child.on('error', error => {
      runningProcesses.delete(sessionId)
      updateSession(sessionId, current => ({
        ...current,
        status: 'failed',
        process: {
          ...processInfoFor(current, invocation),
          exitedAt: Date.now(),
        },
        events: [
          ...current.events,
          createEvent(sessionId, 'failed', summarizeProcessError(error)),
        ],
        updatedAt: Date.now(),
      }))
    })
    child.on('close', (exitCode, signal) => {
      runningProcesses.delete(sessionId)
      const now = Date.now()
      updateSession(sessionId, current => ({
        ...applyCompletionGate(current, invocation, exitCode, signal, now),
      }))
    })

    if (session.task.timeoutMs && Number.isFinite(session.task.timeoutMs) && session.task.timeoutMs > 0) {
      setTimeout(() => {
        const processForSession = runningProcesses.get(sessionId)
        if (!processForSession) return
        processForSession.kill()
        updateSession(sessionId, current => ({
          ...current,
          status: 'failed',
          events: [
            ...current.events,
            createEvent(sessionId, 'failed', `Code agent timed out after ${session.task.timeoutMs}ms.`),
          ],
          updatedAt: Date.now(),
        }))
      }, session.task.timeoutMs).unref()
    }

    return sessions.get(sessionId) ?? starting
  } catch (error) {
    return updateSession(sessionId, current => ({
      ...current,
      status: 'failed',
      events: [
        ...current.events,
        createEvent(sessionId, 'failed', summarizeProcessError(error)),
      ],
      updatedAt: Date.now(),
    }))
  }
}

export async function sendCodeAgentSessionMessage(raw: AvaCodeAgentSendMessageRequest): Promise<AvaCodeAgentSession> {
  ensureSessionsLoaded()
  if (!raw || typeof raw !== 'object') throw new Error('session message request is required.')
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  if (!sessionId) throw new Error('sessionId is required.')
  if (!message) throw new Error('message is required.')
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown code agent session: ${sessionId}`)

  const processForSession = runningProcesses.get(sessionId)
  const event = processForSession?.stdin?.writable
    ? createEvent(sessionId, 'message_sent', message)
    : createEvent(sessionId, 'message_queued', message)
  if (processForSession?.stdin?.writable) {
    processForSession.stdin.write(`${message}\n`)
  }
  const next: AvaCodeAgentSession = {
    ...session,
    status: session.status === 'created' ? 'running' : session.status,
    events: [...session.events, event],
    updatedAt: Date.now(),
  }
  sessions.set(sessionId, next)
  persistSessions()
  return next
}

export async function stopCodeAgentSession(sessionId: unknown): Promise<AvaCodeAgentSession> {
  ensureSessionsLoaded()
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId is required.')
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown code agent session: ${sessionId}`)
  const processForSession = runningProcesses.get(session.sessionId)
  if (processForSession) {
    processForSession.kill()
    runningProcesses.delete(session.sessionId)
  }
  const event = createEvent(session.sessionId, 'stopped', `Stopped ${session.selected.agent.name} session.`)
  const next: AvaCodeAgentSession = {
    ...session,
    status: 'stopped',
    events: [...session.events, event],
    updatedAt: Date.now(),
  }
  sessions.set(session.sessionId, next)
  persistSessions()
  return next
}

function normalizeTaskRequest(raw: AvaCodeAgentTaskRequest): AvaCodeAgentTaskRequest {
  if (!raw || typeof raw !== 'object') throw new Error('code agent task request is required.')
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (!goal) throw new Error('goal is required.')
  return {
    goal,
    workingDirectory: typeof raw.workingDirectory === 'string' && raw.workingDirectory.trim() ? raw.workingDirectory.trim() : undefined,
    taskKind: normalizeTaskKind(raw.taskKind, goal),
    preferredAgentId: normalizeAgentId(raw.preferredAgentId),
    constraints: Array.isArray(raw.constraints) ? raw.constraints.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [],
    validationCommands: Array.isArray(raw.validationCommands) ? raw.validationCommands.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [],
    startImmediately: typeof raw.startImmediately === 'boolean' ? raw.startImmediately : undefined,
    timeoutMs: typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : undefined,
  }
}

function normalizeTaskKind(input: unknown, goal: string): AvaCodeAgentTaskKind {
  const allowed = new Set<AvaCodeAgentTaskKind>(['scaffold', 'feature', 'debug', 'refactor', 'research', 'design', 'unknown'])
  if (typeof input === 'string' && allowed.has(input as AvaCodeAgentTaskKind)) return input as AvaCodeAgentTaskKind
  const lower = goal.toLowerCase()
  if (/\b(debug|fix|error|bug|failed|failing)\b/.test(lower) || /修复|调试|错误/.test(goal)) return 'debug'
  if (/\b(refactor|clean up|rename|split|move)\b/.test(lower) || /重构|拆分|移动/.test(goal)) return 'refactor'
  if (/\b(research|compare|investigate|study)\b/.test(lower) || /研究|比较|调查/.test(goal)) return 'research'
  if (/\b(design|ui|ux|layout|mockup)\b/.test(lower) || /设计|界面|布局/.test(goal)) return 'design'
  if (/\b(create|scaffold|new app|vite|initialize)\b/.test(lower) || /创建|初始化|新建/.test(goal)) return 'scaffold'
  if (/\b(add|implement|build|feature)\b/.test(lower) || /添加|实现|功能/.test(goal)) return 'feature'
  return 'unknown'
}

function normalizeAgentId(input: unknown): AvaCodeAgentId | undefined {
  return typeof input === 'string' && CODE_AGENT_PROFILES.some(item => item.id === input)
    ? input as AvaCodeAgentId
    : undefined
}

function selectCodeAgentCandidates(request: AvaCodeAgentTaskRequest, probes: CodeAgentProbeResult[]): AvaCodeAgentSelection[] {
  const probeById = new Map(probes.map(item => [item.id, item]))
  return CODE_AGENT_PROFILES
    .map(agent => scoreAgent(agent, request, probeById.get(agent.id)))
    .sort((a, b) => b.score - a.score || a.agent.fallbackRank - b.agent.fallbackRank)
}

function scoreAgent(agent: AvaCodeAgentProfile, request: AvaCodeAgentTaskRequest, probe?: CodeAgentProbeResult): AvaCodeAgentSelection {
  const reasons: string[] = []
  let score = 0

  if (probe?.status === 'ready') {
    score += 100
    reasons.push('installed-and-ready')
  } else if (probe?.status === 'error') {
    score -= 30
    reasons.push('probe-error')
  } else {
    score -= 60
    reasons.push('not-installed')
  }

  if (request.preferredAgentId === agent.id) {
    score += 80
    reasons.push('explicit-user-choice')
  } else if (request.preferredAgentId) {
    score -= 10
  }

  if (request.taskKind && agent.strengths.includes(request.taskKind)) {
    score += 35
    reasons.push(`matches-${request.taskKind}`)
  }

  score += Math.max(0, 12 - agent.fallbackRank * 2)

  return {
    agent,
    score,
    reasons,
    probe: probe
      ? {
          status: probe.status,
          version: probe.version,
          error: probe.error,
        }
      : undefined,
  }
}

function createSession(task: AvaCodeAgentTaskRequest, selected: AvaCodeAgentSelection): AvaCodeAgentSession {
  const now = Date.now()
  const sessionId = `code_agent_${now}_${Math.random().toString(36).slice(2, 8)}`
  const taskPackage = buildTaskPackage(task, selected)
  const events = [
    createEvent(sessionId, 'selected', `Selected ${selected.agent.name}: ${selected.reasons.join(', ') || 'best available agent'}.`),
    createEvent(sessionId, 'task_packaged', 'Created code agent task package.'),
  ]
  return {
    sessionId,
    status: 'created',
    selected,
    task,
    taskPackage,
    events,
    createdAt: now,
    updatedAt: now,
  }
}

function sessionsStorePath(): string {
  return userDataFile('code-agent-sessions.json')
}

function ensureSessionsLoaded(): void {
  if (sessionsLoaded) return
  sessionsLoaded = true
  const path = sessionsStorePath()
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: AvaCodeAgentSession[] }
    for (const session of raw.sessions ?? []) {
      if (!session?.sessionId) continue
      const restored: AvaCodeAgentSession = session.status === 'running' || session.status === 'starting'
        ? {
            ...session,
            status: 'failed',
            events: [
              ...session.events,
              createEvent(session.sessionId, 'failed', 'Daemon restarted while this code-agent session was running. Session cannot be resumed automatically.'),
            ],
            updatedAt: Date.now(),
          }
        : session
      sessions.set(restored.sessionId, restored)
    }
  } catch (error) {
    console.warn('[code-agent-dispatcher] failed to load persisted sessions:', error)
  }
}

function persistSessions(): void {
  try {
    const path = sessionsStorePath()
    mkdirSync(dirname(path), { recursive: true })
    const payload = {
      version: 1,
      sessions: [...sessions.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_PERSISTED_SESSIONS),
    }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    console.warn('[code-agent-dispatcher] failed to persist sessions:', error)
  }
}

function createEvent(sessionId: string, type: AvaCodeAgentEvent['type'], message: string): AvaCodeAgentEvent {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    type,
    message,
    createdAt: Date.now(),
  }
}

function updateSession(sessionId: string, updater: (session: AvaCodeAgentSession) => AvaCodeAgentSession): AvaCodeAgentSession {
  const current = sessions.get(sessionId)
  if (!current) throw new Error(`Unknown code agent session: ${sessionId}`)
  const next = updater(current)
  sessions.set(sessionId, next)
  persistSessions()
  return next
}

function appendProcessEvent(sessionId: string, type: 'stdout' | 'stderr', chunk: Buffer): void {
  updateSession(sessionId, current => ({
    ...current,
    events: [
      ...current.events,
      createEvent(sessionId, type, normalizeProcessChunk(chunk)),
    ],
    updatedAt: Date.now(),
  }))
}

function normalizeProcessChunk(chunk: Buffer): string {
  const text = chunk.toString('utf8').replace(/\r\n/g, '\n').trimEnd()
  if (text.length <= 8_000) return text
  return `${text.slice(0, 8_000)}\n...[truncated ${text.length - 8_000} chars]`
}

function processInfoFor(
  session: AvaCodeAgentSession,
  invocation: CodeAgentInvocation,
): AvaCodeAgentProcessInfo {
  return {
    command: invocation.command,
    args: safeProcessArgs(session, invocation),
    cwd: invocation.cwd,
    ...session.process,
  }
}

function safeProcessArgs(session: AvaCodeAgentSession, invocation: CodeAgentInvocation): string[] {
  return invocation.args.map(arg => {
    if (arg === session.taskPackage) return '[task-package]'
    if (arg.length > 500) return `${arg.slice(0, 160)}...[redacted ${arg.length - 160} chars]`
    return arg
  })
}

function applyCompletionGate(
  session: AvaCodeAgentSession,
  invocation: CodeAgentInvocation,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  now: number,
): AvaCodeAgentSession {
  const completion = evaluateCompletionEvidence(session, exitCode)
  const stopped = session.status === 'stopped'
  const nextStatus: AvaCodeAgentSession['status'] = stopped
    ? 'stopped'
    : completion.exitOk && completion.missingSignals.length === 0
      ? 'completed'
      : completion.exitOk
        ? 'blocked'
        : 'failed'

  return {
    ...session,
    status: nextStatus,
    process: {
      ...processInfoFor(session, invocation),
      exitedAt: now,
      exitCode,
      signal,
    },
    completion,
    events: [
      ...session.events,
      createEvent(session.sessionId, 'exit', `Process exited with code ${exitCode ?? 'null'}${signal ? ` and signal ${signal}` : ''}.`),
      ...(stopped ? [] : [completionEvent(session, nextStatus, completion)]),
    ],
    updatedAt: now,
  }
}

function completionEvent(
  session: AvaCodeAgentSession,
  status: AvaCodeAgentSession['status'],
  completion: AvaCodeAgentCompletionEvidence,
): AvaCodeAgentEvent {
  if (status === 'completed') {
    return createEvent(session.sessionId, 'completed', `${session.selected.agent.name} completed with required evidence: ${completion.requiredSignals.join(', ') || 'exit-ok'}.`)
  }
  if (status === 'blocked') {
    return createEvent(session.sessionId, 'blocked', `Process exited successfully, but completion gate is missing evidence: ${completion.missingSignals.join(', ')}.`)
  }
  return createEvent(session.sessionId, 'failed', `${session.selected.agent.name} failed. ${completion.summary}`)
}

function evaluateCompletionEvidence(session: AvaCodeAgentSession, exitCode: number | null): AvaCodeAgentCompletionEvidence {
  const output = session.events
    .filter(event => event.type === 'stdout' || event.type === 'stderr')
    .map(event => event.message)
    .join('\n')
  const lower = output.toLowerCase()
  const exitOk = exitCode === 0
  const changedFilesMentioned = /\b(changed files?|modified files?|files changed|created files?|updated files?|wrote|patched|edited)\b/i.test(output)
    || /\b(git diff|git status|created|modified|updated|patched|edited)\b/i.test(output)
    || /变更文件|修改文件|已修改|已创建|写入/.test(output)
  const validationMentioned = /\b(validation|validated|typecheck|test(?:s|ed)?|build(?:s|ed)?|lint|npm run|pytest|tsc|passed|failed)\b/i.test(output)
    || /验证|测试|构建|类型检查|通过|失败/.test(output)
  const finalReportMentioned = /\b(final report|summary|what changed|changed files|validation result|remaining risks?|status)\b/i.test(output)
    || /最终报告|总结|变更|验证结果|剩余风险|状态/.test(output)
  const requiredSignals = requiredCompletionSignals(session)
  const missingSignals = requiredSignals.filter(signal => {
    if (signal === 'exit-ok') return !exitOk
    if (signal === 'changed-files') return !changedFilesMentioned
    if (signal === 'validation') return !validationMentioned
    if (signal === 'final-report') return !finalReportMentioned
    return !lower.includes(signal)
  })

  return {
    exitOk,
    changedFilesMentioned,
    validationMentioned,
    finalReportMentioned,
    requiredSignals,
    missingSignals,
    summary: missingSignals.length
      ? `Missing completion evidence: ${missingSignals.join(', ')}.`
      : 'Completion evidence satisfied.',
  }
}

function requiredCompletionSignals(session: AvaCodeAgentSession): string[] {
  const kind = session.task.taskKind ?? 'unknown'
  if (kind === 'research') return ['exit-ok', 'final-report']
  if (session.task.validationCommands?.length) return ['exit-ok', 'changed-files', 'validation', 'final-report']
  if (kind === 'debug' || kind === 'refactor' || kind === 'feature' || kind === 'scaffold' || kind === 'design') {
    return ['exit-ok', 'changed-files', 'validation', 'final-report']
  }
  return ['exit-ok', 'final-report']
}

type CodeAgentInvocation = {
  command: string
  args: string[]
  cwd?: string
}

function buildAgentInvocation(session: AvaCodeAgentSession): CodeAgentInvocation {
  return CODE_AGENT_ADAPTERS[session.selected.agent.id].buildInvocation(session)
}

function formatCommand(command: string, args: string[]): string {
  const preview = [command, ...args.map(arg => arg.length > 80 ? `${arg.slice(0, 80)}...` : arg)]
  return preview.join(' ')
}

function summarizeProcessError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 500) ?? 'Code agent process failed.'
}

function buildTaskPackage(task: AvaCodeAgentTaskRequest, selected: AvaCodeAgentSelection): string {
  return [
    `Agent: ${selected.agent.name}`,
    `Task kind: ${task.taskKind ?? 'unknown'}`,
    task.workingDirectory ? `Working directory: ${task.workingDirectory}` : 'Working directory: not specified',
    '',
    'Goal:',
    task.goal,
    '',
    'Constraints:',
    ...(task.constraints?.length ? task.constraints.map(item => `- ${item}`) : ['- Follow Ava supervisor instructions. Do not mark complete without validation evidence.']),
    '',
    'Validation:',
    ...(task.validationCommands?.length ? task.validationCommands.map(item => `- ${item}`) : ['- Report changed files and validation performed.']),
    '',
    'Completion contract:',
    '- Ask Ava/user only when required information is missing.',
    '- Return changed files, commands run, validation results, and remaining risks.',
  ].join('\n')
}
