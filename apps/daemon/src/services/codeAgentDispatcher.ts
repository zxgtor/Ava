import type {
  AvaCodeAgentDispatchResult,
  AvaCodeAgentEvent,
  AvaCodeAgentId,
  AvaCodeAgentProfile,
  AvaCodeAgentSelection,
  AvaCodeAgentSendMessageRequest,
  AvaCodeAgentSession,
  AvaCodeAgentSessionListResult,
  AvaCodeAgentTaskKind,
  AvaCodeAgentTaskRequest,
} from '@ava/contracts'
import { probeCodeAgents, type CodeAgentProbeResult } from './codeAgentProbe'

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

const sessions = new Map<string, AvaCodeAgentSession>()

export function listCodeAgentProfiles(): AvaCodeAgentProfile[] {
  return CODE_AGENT_PROFILES
}

export async function dispatchCodeAgentTask(raw: AvaCodeAgentTaskRequest): Promise<AvaCodeAgentDispatchResult> {
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
  return {
    session,
    candidates,
    status: 'assigned',
    reason: `Assigned task to ${selected.agent.name}.`,
  }
}

export function listCodeAgentSessions(): AvaCodeAgentSessionListResult {
  return {
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  }
}

export async function sendCodeAgentSessionMessage(raw: AvaCodeAgentSendMessageRequest): Promise<AvaCodeAgentSession> {
  if (!raw || typeof raw !== 'object') throw new Error('session message request is required.')
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  if (!sessionId) throw new Error('sessionId is required.')
  if (!message) throw new Error('message is required.')
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown code agent session: ${sessionId}`)

  const event = createEvent(sessionId, 'message_queued', message)
  const next: AvaCodeAgentSession = {
    ...session,
    status: session.status === 'created' ? 'running' : session.status,
    events: [...session.events, event],
    updatedAt: Date.now(),
  }
  sessions.set(sessionId, next)
  return next
}

export async function stopCodeAgentSession(sessionId: unknown): Promise<AvaCodeAgentSession> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId is required.')
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown code agent session: ${sessionId}`)
  const event = createEvent(session.sessionId, 'stopped', `Stopped ${session.selected.agent.name} session.`)
  const next: AvaCodeAgentSession = {
    ...session,
    status: 'stopped',
    events: [...session.events, event],
    updatedAt: Date.now(),
  }
  sessions.set(session.sessionId, next)
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

function createEvent(sessionId: string, type: AvaCodeAgentEvent['type'], message: string): AvaCodeAgentEvent {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    type,
    message,
    createdAt: Date.now(),
  }
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
