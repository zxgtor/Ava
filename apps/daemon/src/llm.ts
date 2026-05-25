// ─────────────────────────────────────────────
// Main-process LLM client.
// Runs in Node, so no CORS, no cert issues.
// Exposes: streamChat() → emits text / tool-call parts to renderer via IPC.
// ─────────────────────────────────────────────

import { dirname, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'
import { mcpSupervisor, type CallToolError, type CallToolResult, type McpToolDescriptor } from './services/mcpSupervisor'
import { pluginManager, type PluginSkill, type PluginState } from './services/pluginManager'
import { previewValue, toolAuditLog, type ToolAuditCommandInvocation } from './services/toolAuditLog'
import { builtInTools } from './services/builtInTools'
import { runtimeEnvironmentPrompt } from './services/runtimeEnvironment'
import { OpenAiAdapter } from './adapters/openai'
import { AnthropicAdapter } from './adapters/anthropic'
import { LlmAdapter } from './adapters/base'
import { classifyToolError } from './services/toolErrorClassifier'
import { compactToolResultForContext, type PersistedToolResultRef } from './services/toolResultStore'
import { duplicateToolResultPatch, toolRuntime } from './services/toolRuntime'
import { madeStepProgress } from './shared/agentProgressPolicy'
import { buildCapabilityIndex, routeMcpTools, routeSkills } from './services/capabilityRouter'
import { capabilityStats } from './services/capabilityStats'
import { windowsEnvironmentDriver } from './services/windowsEnvironmentDriver'
import type { RuntimeEventTarget } from './services/runtimeEventTarget'

export type LlmMessagePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmMessagePart[]
  taskId?: string
  toolCallId?: string
  toolCalls?: ToolCallCandidate[]
}

export interface ModelProvider {
  id: string
  name: string
  type: 'local' | 'cloud' | 'aggregator'
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: string[]
  defaultModel: string
  reasoningMode?: 'auto' | 'off' | 'on'
}

export interface LlmAttempt {
  providerId: string
  providerName: string
  model: string
  ok: boolean
  status?: number
  error?: string
}

export type ToolCallFormat = 'openai' | 'hermes' | 'none'
export type ToolCallStatus = 'pending' | 'running' | 'ok' | 'error' | 'aborted'
export type AssistantRunPhase =
  | 'connecting'
  | 'waiting_first_token'
  | 'generating'
  | 'tool_running'
  | 'fallback'
  | 'completed'
  | 'error'
  | 'aborted'

export type RuntimeStreamEvent =
  | { type: 'text_delta'; streamId: string; taskId?: string; text: string }
  | { type: 'reasoning_delta'; streamId: string; taskId?: string; text: string }
  | { type: 'run_status'; streamId: string; taskId?: string; phase: AssistantRunPhase; providerId?: string; providerName?: string; model?: string }
  | { type: 'tool_call_started'; streamId: string; taskId?: string; partIndex: number; part: ToolCallPart }
  | { type: 'tool_result'; streamId: string; taskId?: string; partIndex: number; partId?: string; patch: Partial<ToolCallPart> }
  | { type: 'task_plan_update'; streamId: string; taskId?: string; phase: 'started' | 'advanced' | 'completed' | 'blocked'; plan: TaskExecutionPlan; validation?: TaskExecutionValidation; stepTitle?: string; error?: string }
  | { type: 'error'; streamId: string; taskId?: string; message: string }

export interface ToolCallPart {
  type: 'tool_call'
  taskId?: string
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolCallStatus
  result?: unknown
  persistedOutput?: PersistedToolResultRef
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface StreamChatArgs {
  streamId: string
  messages: LlmMessage[]
  providers: ModelProvider[]
  activeTaskId?: string
  activeTaskPlan?: TaskExecutionPlan
  activeFolderPath?: string
  taskAllowedDirs?: string[]
  activeCommandInvocation?: ToolAuditCommandInvocation
  temperature?: number
  toolFormatMap?: Record<string, ToolCallFormat>
  pluginStates?: Record<string, PluginState>
  activeStepRequiredTools?: string[]
  activeStepRole?: TaskStepRole
  activeStepToolLoopBudget?: number
  finalReportReadBudget?: number
  routedMcpToolNames?: string[]
}

export type TaskExecutionStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type TaskExecutionPlanStatus = 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'aborted'

export interface TaskExecutionValidation {
  devServerChecked: boolean
  consoleChecked: boolean
  screenshotChecked: boolean
  buildChecked: boolean
}

export interface TaskExecutionEvidence {
  toolName: string
  toolCallId: string
  status: ToolCallStatus
  timestamp: number
  summary?: string
  processId?: string
  command?: string
  exitCode?: number | null
  persistedOutputPath?: string
}

export interface TaskExecutionStep {
  id: string
  title: string
  status: TaskExecutionStepStatus
  requiredTools: string[]
  completionSignals: string[]
  attempts: number
  lastError?: string
  lastToolSummary?: string
  lastProcessId?: string
  lastCommand?: string
  lastExitCode?: number | null
  lastRecoveredAt?: number
  evidence?: TaskExecutionEvidence[]
  dependsOn?: string[]
  subtasks?: TaskExecutionStep[]
  workflowType?: 'scaffold' | 'feature' | 'debug' | 'refactor' | 'research'
  role?: TaskStepRole
}

export interface TaskExecutionPlan {
  taskId: string
  status: TaskExecutionPlanStatus
  goal: string
  workingDirectory: string
  kind: 'coding-design'
  currentStepId?: string
  steps: TaskExecutionStep[]
  validation: TaskExecutionValidation
  architectureConstraints?: string
  createdAt: number
  updatedAt: number
}

export interface StreamStepArgs extends StreamChatArgs {
  messages: LlmMessage[]
  tools: McpToolDescriptor[]
  toolFormatHint?: ToolCallFormat
  hiddenReasoningBudgetChars?: number
}

export interface StreamChatResult {
  fullContent: string
  parts: Array<{ type: 'text'; text: string } | ToolCallPart>
  provider: ModelProvider
  model: string
  attempts: LlmAttempt[]
  fallbackUsed: boolean
  toolCallsIssued: number
  loopRounds: number
  detectedToolFormat: ToolCallFormat
  stopReason?: 'output_limit' | 'tool_loop_limit' | 'server_disconnected' | 'raw_command_no_tool'
  /**
   * Set when runToolLoop exited because a tool listed in
   * activeStepRequiredTools succeeded. This is the runtime's authoritative
   * signal — the orchestrator must trust it even if the accumulated parts
   * stream looks stale (IPC ordering, etc).
   */
  successfulRequiredTool?: string
}

export interface ToolCallCandidate {
  id: string
  name: string
  args: Record<string, unknown>
}

export type TaskStepRole =
  | 'inspect'
  | 'scaffold'
  | 'install'
  | 'feature'
  | 'preview'
  | 'console'
  | 'screenshot'
  | 'repair'
  | 'validate'
  | 'final_report'

export interface ToolCallAccumulator {
  id?: string
  name?: string
  argsText: string
}

export interface StreamStepResult {
  visibleText: string
  toolCalls: ToolCallCandidate[]
  model: string
  detectedToolFormat: ToolCallFormat
  finishReason?: string
  hiddenReasoningChars?: number
  hiddenReasoningExceeded?: boolean
}

interface ActiveStream {
  controller: AbortController
  aborted: boolean
}

const activeStreams = new Map<string, ActiveStream>()

const ANTHROPIC_API_VERSION = '2023-06-01'
const ANTHROPIC_MAX_TOKENS = 4096
const DEFAULT_TOOL_LOOP = 25
// Hard ceiling — only a runaway-safety net. Real stops should come from
// the smart-budget heuristics: unrecoverable_repeat (3× identical error)
// or no_progress (no successful tool call in STAGNATION_WINDOW). As long
// as the model keeps making progress every few rounds, we let the loop
// keep going up to this ceiling.
const MAX_TOOL_LOOP = 500
const WINDOWS_PATH_RE = /[A-Za-z]:\\[^\s"'`<>|?*，。；：、]+/g
const WINDOWS_DRIVE_SCOPE_RE = /\b[A-Za-z]:\\?(?![^\s"'`<>|?*])/g
const TOOL_INTENT_RE =
  /\b(read|open|inspect|check|list|search|find|scan|write|create|edit|modify|delete|run|execute|call|use tool|tool call)\b|读取|打开|检查|查看|列出|搜索|查找|扫描|写入|创建|编辑|修改|删除|运行|执行|调用工具|使用工具/i
const CONTINUATION_TOOL_INTENT_RE =
  /\b(continue|retry|resume|again|previous|last|same|unfinished|interrupted|pick up|keep going|carry on)\b|继续|重试|恢复|再试|刚才|上次|之前|同一个|未完成|中断|接着/i
const REASONING_INTENT_RE =
  /\b(debug|diagnose|trace|root cause|why|architecture|architect|design|plan|strategy|refactor|migrate|compare|tradeoff|risk|review|analyze|complex|investigate|fix|implement)\b|为什么|原因|诊断|排查|调试|架构|设计|计划|方案|重构|迁移|比较|权衡|风险|审查|分析|复杂|调查|修复|实现/i
const SIMPLE_CHAT_RE =
  /\b(what is|how to|do you know|explain|summarize|translate|tell me|can this|does this|support)\b|是什么|怎么|如何|解释|总结|翻译|支持吗|知道/i
const RAW_COMMAND_ONLY_RE =
  /^(?:dir|ls|pwd|cat|touch|mkdir|mv|cp|npm|npx|pnpm|yarn|bun|bunx|node|git|python|python3|py|pip|pip3|pytest|rg|dotnet|vite|tsc|deno|uv|uvx|powershell|pwsh)(?:\s+[^\r\n]+)?$/i
const ACTION_PROMISE_WITHOUT_TOOL_RE =
  /\b(?:i will|i'll|let's|let me|first step|first,? i|now i|i need to|start by|begin by|check current|need to check|need to confirm)\b[\s\S]{0,240}\b(?:check|inspect|list|read|run|create|install|start|verify|look|view|initialize|launch)\b|我(?:将|会|需要|先|现在)[\s\S]{0,120}(?:检查|查看|读取|运行|创建|安装|启动|验证|初始化)|第一步|让我们先|请允许我查看/i
const FINAL_REPORT_READ_TOOL_NAMES = new Set(['file.read_text', 'file.list_dir', 'git.diff', 'project.validate'])

/**
 * Tools that stay exposed even when a step has a narrow requiredTools set.
 * Lets the model do safe inspection without burning loop budget on tools
 * that wouldn't count toward step completion anyway.
 */
const ALWAYS_ALLOWED_CORE_TOOLS = new Set<string>([
  'file.read_text',
  'file.list_dir',
  'file.stat',
  'project.map',
  'project.detect',
  'search.ripgrep',
])

export function isToolAllowedForActiveStep(toolName: string, activeStepRequiredTools?: string[]): boolean {
  if (!activeStepRequiredTools || activeStepRequiredTools.length === 0) return true
  const needsPreviewRuntime = activeStepRequiredTools.some(tool =>
    tool === 'preview.console' || tool === 'preview.screenshot' || tool === 'preview.open',
  )
  if (needsPreviewRuntime && (toolName === 'devserver.start' || toolName === 'devserver.status')) return true
  return activeStepRequiredTools.includes(toolName) || ALWAYS_ALLOWED_CORE_TOOLS.has(toolName)
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

export function anthropicMessagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/messages$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function getAdapter(providerId: string): LlmAdapter {
  if (providerId === 'anthropic') {
    return new AnthropicAdapter()
  }
  // Default to OpenAI-compatible for everything else (local models, groq, deepseek, etc)
  return new OpenAiAdapter()
}

export function makeDeltaPusher(onChunk: (text: string) => void) {
  let fullContent = ''
  let seenFirstVisible = false

  const push = (delta: string) => {
    let text = delta
    if (!seenFirstVisible) {
      text = text.replace(/^[\s\u3000]+/, '')
      if (text) seenFirstVisible = true
      if (!text) return
    }
    fullContent += text
    onChunk(text)
  }

  return {
    push,
    get fullContent() { return fullContent },
  }
}

function toolKey(providerId: string, model: string): string {
  return `${providerId}:${model}`
}

function latestUserRequest(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      const c = messages[i].content
      if (typeof c === 'string') return c
      return c.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
    }
  }
  return ''
}

function compactMessagesText(messages: LlmMessage[], maxChars = 12_000): string {
  const chunks: string[] = []
  for (let i = messages.length - 1; i >= 0 && chunks.join('\n').length < maxChars; i -= 1) {
    const message = messages[i]
    if (message.role === 'tool') continue
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (!content.trim()) continue
    chunks.push(`${message.role}: ${content.slice(0, 2000)}`)
  }
  return chunks.reverse().join('\n').slice(-maxChars)
}

function extractPathScopes(text: string): string[] {
  const scopes = new Set<string>()
  for (const match of text.matchAll(WINDOWS_PATH_RE)) {
    scopes.add(match[0].replace(/[),.;:，。；：、]+$/, '').toLowerCase())
  }
  for (const match of text.matchAll(WINDOWS_DRIVE_SCOPE_RE)) {
    scopes.add(match[0].replace(/\\?$/, ':').toLowerCase())
  }
  return Array.from(scopes)
}

function pathArgFromToolCall(toolCall: ToolCallCandidate): string | null {
  const raw = toolCall.args.path ?? toolCall.args.root ?? toolCall.args.dir ?? toolCall.args.directory
  return typeof raw === 'string' ? raw : null
}

function isPathWithinScope(path: string, scope: string): boolean {
  const p = path.toLowerCase()
  const s = scope.toLowerCase()
  if (/^[a-z]:$/.test(s)) return p === `${s}\\` || p === s || p.startsWith(`${s}\\`)
  return p === s || p.startsWith(`${s}\\`)
}

function validateToolAgainstCurrentTask(toolCall: ToolCallCandidate, currentTask: string): string | null {
  if (!toolCall.name.startsWith('filesystem.')) return null
  const path = pathArgFromToolCall(toolCall)
  if (!path) {
    const task = currentTask.toLowerCase()
    const isAllowedDirsQuery = /allowed directories|allowlist|whitelist|白名单|允许目录|可访问目录/.test(task)
    if (toolCall.name === 'filesystem.list_allowed_directories' && !isAllowedDirsQuery) {
      return `Blocked filesystem tool call "${toolCall.name}" because it is not required by the latest user request.`
    }
    return null
  }

  const scopes = extractPathScopes(currentTask)
  if (scopes.length === 0) return null
  if (scopes.some(scope => isPathWithinScope(path, scope))) return null

  return `Blocked stale filesystem tool call. The requested path "${path}" is outside the latest user request scope: ${scopes.join(', ')}.`
}

function shouldExposeTools(currentTask: string, activeCommandInvocation?: ToolAuditCommandInvocation, forceToolExposure = false): boolean {
  if (forceToolExposure) return true
  if (activeCommandInvocation) return true
  if (extractPathScopes(currentTask).length > 0) return true
  if (CONTINUATION_TOOL_INTENT_RE.test(currentTask)) return true
  return TOOL_INTENT_RE.test(currentTask)
}

function allowedFilesystemDirs(): string[] {
  return mcpSupervisor
    .listServers()
    .flatMap(server => server.allowedDirs ?? [])
    .filter(dir => typeof dir === 'string' && dir.trim().length > 0)
}

function taskScopedAllowedDirs(activeFolderPath?: string, taskAllowedDirs?: string[]): string[] {
  const dirs = new Set<string>()
  for (const dir of allowedFilesystemDirs()) {
    if (dir?.trim()) dirs.add(resolvePath(dir))
  }
  for (const dir of [activeFolderPath, ...(taskAllowedDirs ?? [])]) {
    if (!dir?.trim()) continue
    const resolved = resolvePath(dir)
    dirs.add(resolved)
    // Low-risk scaffold flow: allow commands in the target folder's parent so
    // tools can create the target directory, then continue inside it.
    dirs.add(dirname(resolved))
  }
  return Array.from(dirs)
}

function listAvailableTools(
  currentTask: string,
  activeCommandInvocation?: ToolAuditCommandInvocation,
  forceToolExposure = false,
  activeStepRequiredTools?: string[],
  routedMcpToolNames?: string[],
): McpToolDescriptor[] {
  if (!shouldExposeTools(currentTask, activeCommandInvocation, forceToolExposure)) return []
  const builtIns = builtInTools.listTools()
  const mcpTools = mcpSupervisor.listAllTools()
  const exposedBuiltIns = !activeStepRequiredTools || activeStepRequiredTools.length === 0
    ? builtIns
    : builtIns.filter(tool => isToolAllowedForActiveStep(tool.name, activeStepRequiredTools))
  const routedMcpSet = routedMcpToolNames ? new Set(routedMcpToolNames) : null
  const requiredToolSet = new Set(activeStepRequiredTools ?? [])
  const stepAllowsTool = (toolName: string) => !activeStepRequiredTools?.length || isToolAllowedForActiveStep(toolName, activeStepRequiredTools)
  const exposedMcp = routedMcpSet
    ? mcpTools.filter(tool => (routedMcpSet.has(tool.name) || requiredToolSet.has(tool.name)) && stepAllowsTool(tool.name))
    : (!activeStepRequiredTools || activeStepRequiredTools.length === 0)
      ? mcpTools
      : mcpTools.filter(tool => isToolAllowedForActiveStep(tool.name, activeStepRequiredTools))
  return [...exposedBuiltIns, ...exposedMcp]
}

/**
 * Models discovered to emit only reasoning_content (no visible content / tool
 * calls) when reasoning is on. We force reasoning off for these for the rest
 * of the process lifetime, regardless of what the auto-rules would otherwise
 * pick. The flag is set by the runToolLoop bail-out below — the user should
 * never have to configure this manually.
 */
const reasoningBrokenModels = new Set<string>()

function reasoningBrokenKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

function markReasoningBroken(providerId: string, model: string): void {
  const key = reasoningBrokenKey(providerId, model)
  if (reasoningBrokenModels.has(key)) return
  reasoningBrokenModels.add(key)
  console.warn(
    `[reasoning-detect] ${key} produced only hidden reasoning with no visible content — auto-disabling reasoning for this model in this process.`,
  )
}

function isReasoningBroken(providerId: string, model: string): boolean {
  return reasoningBrokenModels.has(reasoningBrokenKey(providerId, model))
}

function chooseReasoningMode(
  provider: ModelProvider,
  currentTask: string,
  toolsExposed: boolean,
  activeStepRole?: TaskStepRole,
): 'off' | 'on' {
  if (provider.reasoningMode === 'off') return 'off'
  if (provider.reasoningMode === 'on') return 'on'
  if (isReasoningBroken(provider.id, provider.defaultModel)) return 'off'
  if (
    toolsExposed &&
    /<tool_call\b|exactly\s+(?:this\s+)?(?:one\s+)?tool\s+call|call\s+(?:mcp\s+)?tool\b/i.test(currentTask)
  ) {
    return 'off'
  }
  if (
    activeStepRole === 'scaffold' ||
    activeStepRole === 'install' ||
    activeStepRole === 'preview' ||
    activeStepRole === 'console' ||
    activeStepRole === 'screenshot' ||
    activeStepRole === 'final_report'
  ) {
    return 'off'
  }
  if (activeStepRole === 'repair' || activeStepRole === 'validate') return 'on'
  if (REASONING_INTENT_RE.test(currentTask)) return 'on'
  if (toolsExposed && !SIMPLE_CHAT_RE.test(currentTask)) return 'on'
  return 'off'
}

function chooseHiddenReasoningBudgetChars(mode: 'off' | 'on', currentTask: string, toolsExposed: boolean): number {
  if (mode === 'off') return 0
  if (REASONING_INTENT_RE.test(currentTask) || toolsExposed) return 10_000
  return 4_000
}

function isInlineThinkingOnly(text: string): boolean {
  if (!text) return false
  if (!/<(?:think|thinking|antThinking)\b/i.test(text)) return false
  const stripped = stripInlineThinkingMarkup(text).trim()
  return stripped.length === 0
}

function stripInlineThinkingMarkup(text: string): string {
  return text
    .replace(/<(?:think|thinking|antThinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking|antThinking)>/gi, '')
    .replace(/<(?:think|thinking|antThinking)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/(?:think|thinking|antThinking)>/gi, '')
}

function withFinalizePrompt(messages: LlmMessage[]): LlmMessage[] {
  const instruction: LlmMessage = {
    role: 'system',
    content: [
      'The previous attempt used hidden reasoning but produced no visible final answer.',
      'Do not continue hidden reasoning.',
      'Answer the latest user request directly in visible content now.',
      'If a tool is needed, call only the necessary tool; otherwise provide the final answer.',
    ].join(' '),
  }
  return [instruction, ...messages]
}

function looksLikeRawCommandInsteadOfTool(text: string): boolean {
  const cleaned = cleanRawCommandText(text)
  if (!cleaned || cleaned.length > 240 || cleaned.includes('\n\n')) return false
  const lines = cleaned.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.length > 0 && lines.length <= 3 && lines.every(line => RAW_COMMAND_ONLY_RE.test(line))
}

function extractTrailingRawCommand(text: string): { prefixText: string; commandLine: string } | null {
  const cleaned = cleanRawCommandText(text)
  if (!cleaned || cleaned.length > 2_000) return null
  const lines = cleaned.split(/\r?\n/)
  let commandIndex = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) {
      commandIndex = i
      break
    }
  }
  if (commandIndex < 0) return null
  const commandLine = lines[commandIndex].trim()
  if (!RAW_COMMAND_ONLY_RE.test(commandLine)) return null
  const prefixText = lines.slice(0, commandIndex).join('\n').trim()
  return { prefixText, commandLine }
}

function cleanRawCommandText(text: string): string {
  return text.trim().replace(/^```(?:\w+)?\s*|\s*```$/g, '').trim()
}

function splitShellWords(commandLine: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < commandLine.length; i += 1) {
    const char = commandLine[i]
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}

function rawCommandToShellToolCall(rawText: string, cwd?: string): ToolCallCandidate | null {
  if (!cwd) return null
  const trailing = extractTrailingRawCommand(rawText)
  if (!trailing) return null
  const words = splitShellWords(trailing.commandLine)
  const command = words[0]
  if (!command) return null
  return {
    id: `raw_shell_${Date.now()}`,
    name: 'shell.run_command',
    args: {
      command,
      args: words.slice(1),
      cwd,
    },
  }
}

function actionPromiseToToolCall(rawText: string, cwd?: string): ToolCallCandidate | null {
  if (!cwd || !looksLikeActionPromiseWithoutTool(rawText)) return null
  const cleaned = cleanRawCommandText(rawText)
  const mkdirMatch = cleaned.match(/\bmkdir\s+([A-Za-z]:\\[^\r\n"'`<>|?*]+)/i)
  if (mkdirMatch?.[1]) {
    return {
      id: `auto_create_dir_${Date.now()}`,
      name: 'file.create_dir',
      args: {
        path: mkdirMatch[1].trim(),
      },
    }
  }

  if (/\bnpm\s+create\s+vite@latest\b|vite\s+project|initialize\s+(?:the\s+)?(?:vite|react)|初始化.*vite/i.test(cleaned)) {
    return {
      id: `auto_vite_scaffold_${Date.now()}`,
      name: 'shell.run_command',
      args: {
        command: 'npm',
        args: ['create', 'vite@latest', '.', '--', '--template', 'react'],
        cwd,
      },
    }
  }

  if (/\bnpm\s+install\b|install\s+(?:the\s+)?(?:necessary\s+)?dependencies|安装.*依赖/i.test(cleaned)) {
    return {
      id: `auto_npm_install_${Date.now()}`,
      name: 'shell.run_command',
      args: {
        command: 'npm',
        args: ['install'],
        cwd,
      },
    }
  }

  const wantsProjectInspection =
    /\b(package\.json|directory structure|current state|project state|current directory|files?|dependencies|installed|inspect|check|list|read|look at|view)\b|检查|查看|读取|获取|目录|文件|依赖|项目状态|项目结构/i.test(cleaned)
  if (!wantsProjectInspection) return null
  return {
    id: `auto_project_map_${Date.now()}`,
    name: 'project.map',
    args: {
      cwd,
      maxDepth: 4,
      maxFiles: 250,
    },
  }
}

const CWD_TOOL_NAMES = new Set([
  'project.detect',
  'project.map',
  'project.validate',
  'search.ripgrep',
  'git.status',
  'git.diff',
  'devserver.start',
  'devserver.stop',
  'devserver.status',
  'process.start',
  'process.status',
  'process.logs',
  'process.wait',
  'process.kill',
  'shell.run_command',
])

const TOOL_NAME_ALIASES: Record<string, string> = {
  file_read: 'file.read_text',
  file_read_text: 'file.read_text',
  file_read_file: 'file.read_text',
  read_file: 'file.read_text',
  read_text_file: 'file.read_text',
  file_write: 'file.write_text',
  file_write_text: 'file.write_text',
  write_file: 'file.write_text',
  file_list: 'file.list_dir',
  file_list_dir: 'file.list_dir',
  list_dir: 'file.list_dir',
  file_create_dir: 'file.create_dir',
  file_mkdir: 'file.create_dir',
  mkdir: 'file.create_dir',
  create_dir: 'file.create_dir',
  file_patch: 'file.patch',
  file_stat: 'file.stat',
  shell_exec: 'shell.run_command',
  shell_execute: 'shell.run_command',
  run_command: 'shell.run_command',
  process_start: 'process.start',
  process_status: 'process.status',
  process_logs: 'process.logs',
  process_wait: 'process.wait',
  process_kill: 'process.kill',
}

function normalizeToolCallName(name: string): string {
  const normalized = name.trim().replace(/\./g, '_').replace(/_\d+$/g, '').toLowerCase()
  return TOOL_NAME_ALIASES[normalized] ?? name
}

function expandToolCallAliases(toolCall: ToolCallCandidate): ToolCallCandidate[] {
  const normalizedName = toolCall.name.trim().replace(/\./g, '_').replace(/_\d+$/g, '').toLowerCase()
  if (normalizedName === 'file_read_multiple_files' || normalizedName === 'read_multiple_files') {
    const rawPaths = Array.isArray(toolCall.args.paths) ? toolCall.args.paths : []
    const paths = rawPaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    if (paths.length > 0) {
      return paths.map((path, index) => ({
        id: `${toolCall.id}_read_${index + 1}`,
        name: 'file.read_text',
        args: {
          path,
          ...(typeof toolCall.args.maxChars === 'number' ? { maxChars: toolCall.args.maxChars } : {}),
        },
      }))
    }
  }

  const name = normalizeToolCallName(toolCall.name)
  if (name === toolCall.name) return [toolCall]
  return [{ ...toolCall, name }]
}

function isAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function normalizeToolCallsForContext(toolCalls: ToolCallCandidate[], activeFolderPath?: string): ToolCallCandidate[] {
  return toolCalls.flatMap(expandToolCallAliases).map(call => {
    if (call.name === 'file.create_dir' && typeof call.args.path !== 'string' && activeFolderPath) {
      return { ...call, args: { ...call.args, path: activeFolderPath } }
    }
    if (!CWD_TOOL_NAMES.has(call.name) || typeof call.args.cwd === 'string') return call

    const pathArg = typeof call.args.path === 'string' ? call.args.path.trim() : ''
    const cwd = pathArg && isAbsolutePathLike(pathArg)
      ? pathArg
      : activeFolderPath

    if (!cwd) return call

    const args = { ...call.args, cwd }
    if (call.name.startsWith('project.') && 'path' in args) delete args.path
    return { ...call, args }
  })
}

function cwdArg(toolCall: ToolCallCandidate): string | null {
  return typeof toolCall.args.cwd === 'string' && toolCall.args.cwd.trim()
    ? toolCall.args.cwd.trim()
    : null
}

function sameResolvedPath(a: string, b: string): boolean {
  return resolvePath(a).toLowerCase() === resolvePath(b).toLowerCase()
}

function autoCreatableTaskDir(path: string, args: StreamChatArgs): boolean {
  if (!args.activeTaskId) return false
  const candidates = [
    args.activeFolderPath,
    ...(args.taskAllowedDirs ?? []),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return candidates.some(candidate => sameResolvedPath(path, candidate))
}

async function ensureTaskWorkingDirectory(
  toolCall: ToolCallCandidate,
  args: StreamChatArgs,
): Promise<(CallToolResult | CallToolError) | null> {
  if (!CWD_TOOL_NAMES.has(toolCall.name)) return null
  const cwd = cwdArg(toolCall)
  if (!cwd || existsSync(resolvePath(cwd)) || !autoCreatableTaskDir(cwd, args)) return null

  return builtInTools.callTool('file.create_dir', { path: cwd }, {
    activeFolderPath: args.activeFolderPath,
    allowedDirs: taskScopedAllowedDirs(args.activeFolderPath, args.taskAllowedDirs),
  })
}

async function callToolSafely(input: {
  toolCall: ToolCallCandidate
  builtInTool: { serverId: string; rawName: string } | null
  resolvedMcpTool?: { serverId: string; rawName: string } | null
  args: StreamChatArgs
}): Promise<CallToolResult | CallToolError> {
  try {
    const preflight = input.builtInTool
      ? await ensureTaskWorkingDirectory(input.toolCall, input.args)
      : null
    if (preflight && (!preflight.ok || preflight.isError)) return preflight

    if (input.builtInTool) {
      return builtInTools.callTool(input.toolCall.name, input.toolCall.args, {
        activeFolderPath: input.args.activeFolderPath,
        allowedDirs: taskScopedAllowedDirs(input.args.activeFolderPath, input.args.taskAllowedDirs),
      })
    }

    if (input.resolvedMcpTool && windowsEnvironmentDriver.canHandleTool(input.toolCall.name)) {
      const result = await windowsEnvironmentDriver.act({
        type: 'mcp_tool',
        name: input.toolCall.name,
        args: input.toolCall.args,
      })
      return result.ok
        ? { ok: true, content: result.content, isError: result.isError }
        : { ok: false, error: result.error ?? 'Windows environment action failed', aborted: result.aborted }
    }

    return mcpSupervisor.callTool({
      namespacedName: input.toolCall.name,
      rawArgs: input.toolCall.args,
    })
  } catch (err) {
    return { ok: false, error: `Tool runtime error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function toolRecoveryMessage(toolCall: ToolCallCandidate, error: string): string {
  const classified = classifyToolError(error)
  return [
    `Tool recovery required for ${toolCall.name}.`,
    `Error kind: ${classified.kind}.`,
    `Error: ${classified.message}`,
    classified.path ? `Related path: ${classified.path}` : '',
    `Recovery instruction: ${classified.recoveryHint}`,
    'Continue the current task step with a corrected tool call, or explain the exact blocker if user confirmation is required.',
  ].filter(Boolean).join('\n')
}

function looksLikeValidationToolCommand(args: Record<string, unknown>): boolean {
  const command = typeof args.command === 'string' ? args.command.toLowerCase() : ''
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  const joined = argv.join(' ').toLowerCase()
  if (command === 'tsc') return true
  if (command === 'npm' || command === 'pnpm' || command === 'yarn' || command === 'bun') {
    return /\b(run\s+)?(build|typecheck|test|lint)\b/.test(joined)
  }
  if (command === 'npx' || command === 'bunx') {
    return /\b(tsc|vite\s+build|eslint|vitest|jest|playwright)\b/.test(joined)
  }
  return /\b(build|typecheck|test|lint|tsc|vite\s+build)\b/.test(joined)
}

function looksLikeStrongValidationToolCommand(args: Record<string, unknown>): boolean {
  const command = typeof args.command === 'string' ? args.command.toLowerCase() : ''
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  const joined = `${command} ${argv.join(' ').toLowerCase()}`
  return /\b(build|test|vite\s+build|next\s+build|astro\s+build)\b/.test(joined)
}

function processWaitResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  return record.status === 'exited' && record.exitCode === 0
}

function pathArgEndsWithPackageJson(args: Record<string, unknown>): boolean {
  return typeof args.path === 'string' && args.path.replace(/\\/g, '/').toLowerCase().endsWith('/package.json')
}

function isPackageEvidenceTool(toolCall: ToolCallCandidate): boolean {
  if (toolCall.name === 'file.read_text' || toolCall.name === 'file.stat') return pathArgEndsWithPackageJson(toolCall.args)
  return toolCall.name === 'project.detect' || toolCall.name === 'project.map'
}

function isFeatureEditTool(name: string): boolean {
  return name === 'file.write_text' || name === 'file.patch'
}

function isFeatureVerificationTool(name: string): boolean {
  return name === 'project.map' ||
    name === 'project.detect' ||
    name === 'file.stat' ||
    name === 'file.read_text' ||
    name === 'file.list_dir'
}

function requiredToolSatisfiedForStep(
  args: StreamChatArgs,
  toolCall: ToolCallCandidate,
  result: CallToolResult | CallToolError,
): boolean {
  if (!args.activeStepRequiredTools?.length || !args.activeStepRequiredTools.includes(toolCall.name)) return false
  if (!result.ok || result.isError) return false

  if (args.activeStepRole === 'validate') {
    if (toolCall.name === 'project.validate') return true
    if (toolCall.name === 'shell.run_command') return looksLikeStrongValidationToolCommand(toolCall.args)
    if (toolCall.name === 'process.wait') return processWaitResultSucceeded(result.content)
    return false
  }

  if (
    (args.activeStepRole === 'scaffold' || args.activeStepRole === 'install') &&
    (
      toolCall.name === 'file.create_dir' ||
      toolCall.name === 'shell.run_command' ||
      toolCall.name === 'process.start' ||
      toolCall.name === 'process.wait'
    )
  ) {
    return false
  }

  if (args.activeStepRole === 'feature') {
    // Feature steps require edit + verification evidence. Directory creation
    // or a raw file write alone must not end the tool loop before verification.
    if (toolCall.name === 'file.create_dir' || isFeatureEditTool(toolCall.name)) return false
  }

  if (args.activeStepRole === 'repair') {
    if (isFeatureVerificationTool(toolCall.name) || toolCall.name === 'search.ripgrep') return false
    if (isFeatureEditTool(toolCall.name)) return true
    if (toolCall.name === 'shell.run_command') return looksLikeValidationToolCommand(toolCall.args)
  }

  if ((args.activeStepRole === 'console' || args.activeStepRole === 'screenshot') && toolCall.name.startsWith('devserver.')) {
    return false
  }

  return true
}

function progressToolSatisfiedForStep(
  args: StreamChatArgs,
  toolCall: ToolCallCandidate,
  result: CallToolResult | CallToolError,
  parts: ToolCallPart[],
): boolean {
  if (!args.activeStepRole || !result.ok || result.isError) return false
  if (requiredToolSatisfiedForStep(args, toolCall, result)) return true
  if (args.activeStepRole === 'feature') {
    const hasEdit = parts.some(part =>
      part.status === 'ok' && isFeatureEditTool(part.name),
    )
    if (hasEdit && isFeatureVerificationTool(toolCall.name)) return true
    return false
  }
  if (
    args.activeStepRole === 'repair' &&
    isFeatureEditTool(toolCall.name)
  ) {
    return true
  }
  if (
    args.activeStepRole === 'scaffold' &&
    toolCall.name === 'file.write_text' &&
    String(toolCall.args.path ?? '').replace(/\\/g, '/').toLowerCase().endsWith('/package.json')
  ) {
    return true
  }
  if (
    (args.activeStepRole === 'scaffold' || args.activeStepRole === 'install') &&
    isPackageEvidenceTool(toolCall)
  ) {
    return true
  }
  return false
}

function toolMadeSemanticProgressForStep(
  args: StreamChatArgs,
  toolCall: ToolCallCandidate,
  result: CallToolResult | CallToolError,
  parts: ToolCallPart[],
): boolean {
  if (!result.ok || result.isError) return false
  if (!args.activeStepRole) return true

  if (args.activeStepRole === 'feature') {
    if (isFeatureEditTool(toolCall.name)) return true
    const hasEdit = parts.some(part => part.status === 'ok' && isFeatureEditTool(part.name))
    return hasEdit && isFeatureVerificationTool(toolCall.name)
  }

  if (args.activeStepRole === 'inspect') {
    return isFeatureVerificationTool(toolCall.name) || toolCall.name === 'search.ripgrep'
  }

  if (args.activeStepRole === 'repair') {
    return isFeatureEditTool(toolCall.name) ||
      (toolCall.name === 'shell.run_command' && looksLikeValidationToolCommand(toolCall.args))
  }

  if (args.activeStepRole === 'scaffold' || args.activeStepRole === 'install') {
    return toolCall.name === 'shell.run_command' ||
      toolCall.name === 'process.start' ||
      toolCall.name === 'process.wait' ||
      toolCall.name === 'file.write_text' ||
      toolCall.name === 'file.create_dir' ||
      isPackageEvidenceTool(toolCall)
  }

  if (args.activeStepRole === 'validate') {
    return toolCall.name === 'project.validate' ||
      toolCall.name === 'process.wait' ||
      (toolCall.name === 'shell.run_command' && looksLikeValidationToolCommand(toolCall.args))
  }

  if (args.activeStepRole === 'preview') return toolCall.name === 'devserver.start' || toolCall.name === 'devserver.status'
  if (args.activeStepRole === 'console') return toolCall.name === 'preview.console'
  if (args.activeStepRole === 'screenshot') return toolCall.name === 'preview.screenshot'
  if (args.activeStepRole === 'final_report') return false
  return true
}

function unsatisfiedRequiredToolMessage(args: StreamChatArgs, toolCall: ToolCallCandidate): string | null {
  if ((args.activeStepRole === 'console' || args.activeStepRole === 'screenshot') && toolCall.name.startsWith('devserver.')) {
    return [
      'The dev server action completed, but this step is not complete yet.',
      args.activeStepRole === 'console'
        ? 'Now call preview.console with the actual local URL returned by devserver.start/status.'
        : 'Now call preview.screenshot with the actual local URL returned by devserver.start/status.',
      'Do not assume port 5173; use the URL from the dev server tool result.',
    ].join(' ')
  }

  if (args.activeStepRole === 'feature') {
    if (toolCall.name === 'file.create_dir') {
      return [
        'The directory was created, but directory creation alone does not satisfy a feature step.',
        'Now write the required feature files with file.write_text or file.patch, then verify them with file.read_text, file.stat, project.detect, or project.map.',
      ].join(' ')
    }
    if (isFeatureEditTool(toolCall.name)) {
      return [
        'The file edit was applied, but feature steps require verification before moving on.',
        'Now verify the changed project state with file.read_text, file.stat, file.list_dir, project.detect, or project.map.',
      ].join(' ')
    }
  }

  if (args.activeStepRole === 'repair' && isFeatureVerificationTool(toolCall.name)) {
    return [
      'The inspection succeeded, but this is a repair step and no repair action has been made.',
      'Do not keep reading files.',
      'Use the build error details already provided, then call file.patch or file.write_text to fix the failing code. After the edit, run npm run build or project validation if available.',
    ].join(' ')
  }

  if (
    (args.activeStepRole === 'scaffold' || args.activeStepRole === 'install') &&
    (
      toolCall.name === 'file.create_dir' ||
      toolCall.name === 'shell.run_command' ||
      toolCall.name === 'process.start' ||
      toolCall.name === 'process.wait'
    )
  ) {
    return [
      'The previous tool call finished, but directory creation or command success alone does not prove this scaffold/install step is complete.',
      'You must now verify the expected project artifact before moving on: call file.read_text on package.json, file.stat on package.json, project.detect, or project.map for the working directory.',
      'If package.json is still missing, do not repeat the same create command blindly. Create the minimal package.json with file.write_text, or use a non-interactive scaffold command that can run in a non-empty directory.',
    ].join(' ')
  }

  if (args.activeStepRole !== 'validate') return null
  if (toolCall.name !== 'shell.run_command') return null
  if (looksLikeValidationToolCommand(toolCall.args) && !looksLikeStrongValidationToolCommand(toolCall.args)) {
    return [
      'The previous validation command succeeded, but it is too weak for this validate step.',
      'For frontend/preview tasks, run project.validate or an explicit build command such as npm run build. Typecheck/lint alone does not prove the app bundles.',
      'Do not move to preview or final report until build succeeds.',
    ].join(' ')
  }
  if (looksLikeValidationToolCommand(toolCall.args)) return null
  return [
    'The previous shell.run_command succeeded, but it did not satisfy the current validate step.',
    'Validate step should run project.validate first. For frontend/preview tasks, npm run build or an equivalent build command must pass; typecheck/lint alone is not enough.',
    'Do not scaffold, install, or rewrite project files during validate unless a validation error first routes the task to repair.',
  ].join(' ')
}

function withToolCallCorrectionPrompt(messages: LlmMessage[], rawText: string): LlmMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: rawText,
    },
    {
      role: 'system',
      content: [
        'The previous assistant output was a raw shell command or command-like text, not a tool call.',
        'Do not print commands such as "dir" as plain text.',
        'Call the appropriate available tool now.',
        'For checking project structure, prefer project.map or file.list_dir.',
        'For one-shot commands, use shell.run_command with structured command, args, and cwd.',
        'For long-running dev servers, use devserver.start. For other long-running commands, use process.start then process.status/process.wait.',
      ].join(' '),
    },
  ]
}

function looksLikeActionPromiseWithoutTool(text: string): boolean {
  const cleaned = cleanRawCommandText(text)
  if (!cleaned || cleaned.length > 3_000) return false
  if (/[。.!?]\s*(?:done|completed|finished|已完成|完成了)\s*$/i.test(cleaned)) return false
  return ACTION_PROMISE_WITHOUT_TOOL_RE.test(cleaned)
}

function toolLoopBudgetFromArgs(args: StreamChatArgs): number {
  const requested = args.activeStepToolLoopBudget
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_TOOL_LOOP
  return Math.max(1, Math.min(MAX_TOOL_LOOP, Math.floor(requested)))
}

function isFinalReportReadTool(name: string): boolean {
  return FINAL_REPORT_READ_TOOL_NAMES.has(name)
}

function finalReportBudgetError(budget: number): string {
  return [
    `Final report read budget reached (${budget}).`,
    'Use the already accumulated tool results, validation output, and changed-file context to produce the final report now.',
    'Do not call another read/list/diff/validate tool for this final report step.',
  ].join(' ')
}

function withActionRequiredPrompt(messages: LlmMessage[], rawText: string): LlmMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: rawText,
    },
    {
      role: 'system',
      content: [
        'The previous assistant response announced an action but did not call any tool.',
        'That is not a completed agent step.',
        'Do not repeat the plan or say what you will do.',
        'Call exactly one appropriate available tool now.',
        'For checking project state, use project.map or file.list_dir.',
        'For one-shot commands, use shell.run_command with structured command, args, and cwd.',
        'For long-running commands, use process.start then process.wait/process.status rather than only describing the command.',
        'For creating or editing files, use file.write_text or file.patch.',
      ].join(' '),
    },
  ]
}

function rawCommandNoToolText(rawText: string): string {
  const command = rawText.trim().split(/\r?\n/)[0]?.trim() || '(empty command)'
  return `Stopped: the model output a raw command instead of calling a tool: ${command}. Ava did not execute it. Please retry; Ava will require a tool call such as project.map, file.list_dir, shell.run_command, process.start, or devserver.start.`
}

export function buildToolPrompt(tools: McpToolDescriptor[], runtimePrompt = runtimeEnvironmentPrompt()): string {
  const toolLines = tools.map(tool => {
    const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : '{}'
    return `- ${tool.name}: ${tool.description ?? 'No description'} | args schema: ${schema}`
  })
  const exampleTool = tools.find(tool => tool.name === 'project.map')
    ?? tools.find(tool => tool.name === 'file.list_dir')
    ?? tools.find(tool => tool.name === 'shell.run_command')
    ?? tools.find(tool => tool.name === 'filesystem.read_text_file')
    ?? tools.find(tool => tool.name.startsWith('filesystem.') && /read/i.test(tool.name))
    ?? tools[0]
  const exampleName = exampleTool?.name ?? 'filesystem.read_text_file'
  return [
    runtimePrompt,
    '',
    'Available tools:',
    ...toolLines,
    'Only call a tool when the latest user request requires external state, filesystem access, or an explicit action.',
    'For conceptual questions, instructions, or explanations, answer directly without a tool call.',
    'For file work, prefer built-in file.read_text, file.write_text, file.list_dir, file.create_dir, and file.stat when available.',
    'There is no batch read tool. To read multiple files, call file.read_text once per file.',
    'For focused edits to an existing file, prefer file.patch with exact oldText/newText before rewriting the whole file.',
    'For codebase exploration, use project.map first for a compact project picture, then search.ripgrep/project.detect/read files as needed.',
    'Before claiming coding work is complete, use project.validate or an equivalent shell.run_command validation when available.',
    'For frontend or design preview work, use devserver.start/status/stop for long-running servers, preview.open for local URLs, preview.console for runtime errors, and preview.screenshot for visual feedback.',
    'Do not use shell.run_command for a long-running dev server because it blocks the agent loop.',
    'For other long-running commands, use process.start and then process.wait/process.status/process.logs so the task can recover from interruptions.',
    'Use git.status and git.diff for read-only change review; do not commit or push unless the latest user request explicitly asks.',
    'For code-agent work that needs commands, use shell.run_command with {"command":"npm","args":["..."],"cwd":"..."}; never claim you ran a command unless the tool call succeeded.',
    'When scaffolding npm projects, use a lowercase/kebab-case package name. If the folder name has uppercase letters, create/fix package.json with a valid lowercase name before install/build.',
    'Do not run scaffold commands from a parent folder such as D:\\Apps unless that parent is the active/allowed workspace. Create/use the exact target project folder and run commands with cwd set to that folder.',
    'For large local-model tasks, execute one small plan step at a time and use files, project.map/project.detect, devserver, preview, and validation tools as durable progress state.',
    'Do not generate a whole app/site/3D project as one huge chat answer.',
    'Never output a bare command like "dir", "npm install", or "npm run dev" as plain assistant text. Use a tool call instead.',
    'To call a tool, respond with exactly one or more blocks like:',
    `<tool_call>{"name":"${exampleName}","arguments":{"path":"D:\\\\example.txt"}}</tool_call>`,
    'Use tool names exactly as listed above.',
    'Do not wrap tool calls in markdown fences.',
  ].join('\n')
}

export function toOpenAiMessages(messages: LlmMessage[]) {
  return messages.map(message => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        })),
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      }
    }
    return {
      role: message.role,
      content: message.content,
    }
  })
}

function injectRuntimeEnvironmentPrompt(messages: LlmMessage[]): LlmMessage[] {
  const prompt = runtimeEnvironmentPrompt()
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content: `${messages[0].content}\n\n${prompt}` }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: prompt }, ...messages]
}

function injectHermesToolPrompt(messages: LlmMessage[], tools: McpToolDescriptor[]): LlmMessage[] {
  if (tools.length === 0) return messages
  const prompt = buildToolPrompt(tools)
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content: `${messages[0].content}\n\n${prompt}` }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: prompt }, ...messages]
}

function buildSkillsPrompt(skills: PluginSkill[]): string {
  if (skills.length === 0) return ''
  const blocks = skills.map(skill => [
    `--- Skill: ${skill.pluginName} / ${skill.name}`,
    `Source: ${skill.sourcePath}${skill.truncated ? ' (truncated)' : ''}`,
    skill.routingReasons?.length ? `Selected because: ${skill.routingReasons.join(', ')}` : '',
    skill.content.trim(),
  ].filter(Boolean).join('\n'))
  return [
    'Selected plugin skills for this task step:',
    'Use these instructions when they are relevant to the current task. They do not replace the latest user request or task boundary rules.',
    ...blocks,
  ].join('\n\n')
}

function injectPluginSkills(messages: LlmMessage[], skills: PluginSkill[]): LlmMessage[] {
  const prompt = buildSkillsPrompt(skills)
  if (!prompt) return messages
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content: `${messages[0].content}\n\n${prompt}` }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: prompt }, ...messages]
}

function maxSkillsForStep(role?: TaskStepRole): number {
  if (role === 'final_report') return 0
  if (role === 'validate' || role === 'console' || role === 'screenshot' || role === 'preview') return 1
  if (role === 'repair') return 2
  return 3
}

function maxMcpToolsForStep(role?: TaskStepRole): number {
  if (role === 'final_report') return 0
  if (role === 'validate' || role === 'preview' || role === 'console' || role === 'screenshot') return 2
  if (role === 'repair') return 5
  return 8
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function toolCallFromJsonObject(parsed: Record<string, unknown>): ToolCallCandidate | null {
  const name = typeof parsed.name === 'string' ? parsed.name : null
  if (!name) return null
  const argsSource = parsed.arguments ?? parsed.args
  const args = argsSource && typeof argsSource === 'object' ? argsSource as Record<string, unknown> : {}
  return {
    id: `json_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    args,
  }
}

function parseFencedJsonToolCalls(text: string): { visibleText: string; toolCalls: ToolCallCandidate[] } {
  const toolCalls: ToolCallCandidate[] = []
  let visibleText = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, (match, body) => {
    const parsed = parseJsonObject(String(body).trim())
    const call = parsed ? toolCallFromJsonObject(parsed) : null
    if (!call) return match
    toolCalls.push(call)
    return ''
  })

  if (toolCalls.length === 0) {
    const parsed = parseJsonObject(visibleText.trim())
    const call = parsed ? toolCallFromJsonObject(parsed) : null
    if (call) {
      toolCalls.push(call)
      visibleText = ''
    }
  }

  return { visibleText: visibleText.trim(), toolCalls }
}

export function parseHermesToolCalls(text: string): { visibleText: string; toolCalls: ToolCallCandidate[] } {
  const toolCalls: ToolCallCandidate[] = []
  const parameterXml = parseFunctionParameterToolCalls(text)
  if (parameterXml.toolCalls.length > 0) {
    return parameterXml
  }

  const bracketCalls = parseBracketToolCalls(text)
  if (bracketCalls.toolCalls.length > 0) {
    return bracketCalls
  }

  const toolCallBlockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let visibleText = text.replace(toolCallBlockRe, (_match, body) => {
    const parsed = parseJsonObject(body)
    if (parsed) {
      const call = toolCallFromJsonObject(parsed)
      if (call) toolCalls.push(call)
      return ''
    }

    const functionMatch = String(body).match(/<function=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*(?:<\/function>)?$/)
    if (functionMatch) {
      const args = parseJsonObject(functionMatch[2].trim()) ?? {}
      toolCalls.push({
        id: `hermes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: functionMatch[1],
        args,
      })
      return ''
    }

    return ''
  }).trim()

  if (toolCalls.length === 0) {
    const fenced = parseFencedJsonToolCalls(visibleText)
    if (fenced.toolCalls.length > 0) {
      toolCalls.push(...fenced.toolCalls)
      visibleText = fenced.visibleText
    }
  }

  return { visibleText, toolCalls }
}

function decodeXmlValue(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function parseLooseParameterValue(raw: string): unknown {
  const value = decodeXmlValue(raw).trim()
  if (!value) return ''
  const parsed = parseJsonObject(value)
  if (parsed) return parsed
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('"') && value.endsWith('"'))) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

function readBalancedValue(raw: string, start: number): { value: string; end: number } | null {
  let quote: string | null = null
  let escaped = false
  let depth = 0
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
        if (depth === 0) return { value: raw.slice(start, index + 1), end: index + 1 }
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      if (depth === 0 && index !== start) return { value: raw.slice(start, index).trim(), end: index }
      continue
    }
    if (char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) return { value: raw.slice(start, index + 1), end: index + 1 }
      continue
    }
    if (depth === 0 && /\s/.test(char)) {
      return { value: raw.slice(start, index).trim(), end: index }
    }
  }
  const value = raw.slice(start).trim()
  return value ? { value, end: raw.length } : null
}

function parseBracketToolArgs(raw: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  let index = 0
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1
    const keyMatch = raw.slice(index).match(/^([A-Za-z0-9_.-]+)\s*=/)
    if (!keyMatch) break
    const key = keyMatch[1]
    index += keyMatch[0].length
    while (index < raw.length && /\s/.test(raw[index])) index += 1
    const parsedValue = readBalancedValue(raw, index)
    if (!parsedValue) break
    args[key] = parseLooseParameterValue(parsedValue.value)
    index = parsedValue.end
  }
  return args
}

function findBracketToolCallEnd(text: string, start: number): number {
  let quote: string | null = null
  let escaped = false
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') {
      depth += 1
      continue
    }
    if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function parseBracketToolCalls(text: string): { visibleText: string; toolCalls: ToolCallCandidate[] } {
  const toolCalls: ToolCallCandidate[] = []
  let visibleText = ''
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf('[', cursor)
    if (start < 0) {
      visibleText += text.slice(cursor)
      break
    }
    visibleText += text.slice(cursor, start)
    const head = text.slice(start + 1).match(/^([A-Za-z0-9_.-]+)\s+/)
    if (!head) {
      visibleText += text[start]
      cursor = start + 1
      continue
    }
    const name = head[1]
    if (!name.includes('.') && !name.includes('_')) {
      visibleText += text[start]
      cursor = start + 1
      continue
    }
    const end = findBracketToolCallEnd(text, start)
    if (end < 0) {
      visibleText += text.slice(start)
      break
    }
    const body = text.slice(start + 1 + head[0].length, end).trim()
    const args = parseBracketToolArgs(body)
    if (Object.keys(args).length === 0) {
      visibleText += text.slice(start, end + 1)
    } else {
      toolCalls.push({
        id: `bracket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        args,
      })
    }
    cursor = end + 1
  }

  return { visibleText: visibleText.trim(), toolCalls }
}

function stripBracketToolMarkup(text: string): string {
  let output = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('[', cursor)
    if (start < 0) {
      output += text.slice(cursor)
      break
    }
    output += text.slice(cursor, start)
    const head = text.slice(start + 1).match(/^([A-Za-z0-9_.-]+)\s+/)
    const name = head?.[1] ?? ''
    if (!head || (!name.includes('.') && !name.includes('_'))) {
      output += text[start]
      cursor = start + 1
      continue
    }
    const end = findBracketToolCallEnd(text, start)
    if (end < 0) {
      const lineEnd = text.indexOf('\n', start)
      cursor = lineEnd < 0 ? text.length : lineEnd + 1
    } else {
      cursor = end + 1
    }
  }
  return output.trim()
}

function parseFunctionParameterToolCalls(text: string): { visibleText: string; toolCalls: ToolCallCandidate[] } {
  const toolCalls: ToolCallCandidate[] = []
  const blockRe = /<(?:tool_call|tool_code)>\s*<function=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*(?:<\/function>)?\s*(?:<\/(?:tool_call|tool_code)>|$)/g
  const visibleText = text.replace(blockRe, (_match, name, body) => {
    const args: Record<string, unknown> = {}
    const parameterRe = /<parameter=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*(?:<\/parameter>|(?=<parameter=)|$)/g
    let found = false
    String(body).replace(parameterRe, (_paramMatch, key, value) => {
      found = true
      args[key] = parseLooseParameterValue(String(value))
      return ''
    })
    if (found) {
      toolCalls.push({
        id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(name),
        args,
      })
    }
    return ''
  }).trim()
  return { visibleText, toolCalls }
}

export function stripResidualToolMarkup(text: string): string {
  return stripBracketToolMarkup(stripInlineThinkingMarkup(text)
    .replace(/<(?:tool_call|tool_code)>[\s\S]*?(?:<\/(?:tool_call|tool_code)>|$)/g, '')
    .replace(/<function=[A-Za-z0-9_.-]+>[\s\S]*?(?:<\/function>|$)/g, '')
    .replace(/<parameter=[A-Za-z0-9_.-]+>[\s\S]*?(?:<\/parameter>|$)/g, '')
    .replace(/<\/?(?:tool_call|tool_code|function|parameter)>/g, '')
    .trim())
}

export function hasUnterminatedToolCallMarkup(text: string): boolean {
  const toolCallOpen = text.lastIndexOf('<tool_call>')
  const toolCodeOpen = text.lastIndexOf('<tool_code>')
  const lastOpen = Math.max(toolCallOpen, toolCodeOpen)
  if (lastOpen < 0) return false
  const lastClose = Math.max(text.lastIndexOf('</tool_call>'), text.lastIndexOf('</tool_code>'))
  if (lastClose < lastOpen) return true
  const tail = text.slice(lastOpen, lastClose)
  const functionOpen = tail.match(/<function=[A-Za-z0-9_.-]+>/g)?.length ?? 0
  const functionClose = tail.match(/<\/function>/g)?.length ?? 0
  if (functionClose < functionOpen) return true
  const parameterOpen = tail.match(/<parameter=[A-Za-z0-9_.-]+>/g)?.length ?? 0
  const parameterClose = tail.match(/<\/parameter>/g)?.length ?? 0
  return parameterClose < parameterOpen
}

function withTruncatedToolCallRetryPrompt(messages: LlmMessage[], visibleText: string): LlmMessage[] {
  return [
    ...messages,
    ...(visibleText.trim() ? [{ role: 'assistant' as const, content: visibleText.trim() }] : []),
    {
      role: 'system',
      content: [
        'The previous assistant output ended inside an incomplete XML tool call.',
        'Do not continue the half-written XML.',
        'Discard it and resend exactly one complete tool call from scratch.',
        'The new tool call must include <tool_call>, <function=...>, all required <parameter=...>...</parameter> values, and </tool_call>.',
        'Do not include explanatory prose before or after the tool call.',
      ].join(' '),
    },
  ]
}

export function extractOpenAiPayload(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  return parseJsonObject(payload)
}

export function isOpenAiDoneLine(line: string): boolean {
  return line.startsWith('data:') && line.slice(5).trim() === '[DONE]'
}

export function normalizeToolCallCandidates(accs: ToolCallAccumulator[]): ToolCallCandidate[] {
  const out: ToolCallCandidate[] = []
  for (let i = 0; i < accs.length; i += 1) {
    const acc = accs[i]
    if (!acc?.name) continue
    out.push({
      id: acc.id || `tc_${Date.now()}_${i}`,
      name: acc.name,
      args: parseJsonObject(acc.argsText) ?? {},
    })
  }
  return out
}

export function applyToolCallDelta(accs: ToolCallAccumulator[], payload: Record<string, unknown>): boolean {
  const deltaObj = payload.choices && Array.isArray(payload.choices)
    ? payload.choices[0] as Record<string, unknown> | undefined
    : undefined
  const delta = deltaObj?.delta
  if (!delta || typeof delta !== 'object') return false
  const toolCalls = (delta as Record<string, unknown>).tool_calls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false

  for (const raw of toolCalls) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const index = typeof item.index === 'number' ? item.index : accs.length
    if (!accs[index]) accs[index] = { argsText: '' }
    if (typeof item.id === 'string') accs[index].id = item.id
    const fn = item.function
    if (fn && typeof fn === 'object') {
      const f = fn as Record<string, unknown>
      if (typeof f.name === 'string') accs[index].name = f.name
      if (typeof f.arguments === 'string') accs[index].argsText += f.arguments
    }
  }
  return true
}

export function extractMessageToolCalls(payload: Record<string, unknown>): ToolCallCandidate[] {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined
  const message = choice?.message
  if (!message || typeof message !== 'object') return []
  const toolCalls = (message as Record<string, unknown>).tool_calls
  if (!Array.isArray(toolCalls)) return []

  return toolCalls.flatMap((raw, idx) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const fn = item.function
    if (!fn || typeof fn !== 'object') return []
    const name = typeof (fn as Record<string, unknown>).name === 'string'
      ? (fn as Record<string, unknown>).name as string
      : ''
    if (!name) return []
    const argsText = typeof (fn as Record<string, unknown>).arguments === 'string'
      ? (fn as Record<string, unknown>).arguments as string
      : '{}'
    return [{
      id: typeof item.id === 'string' ? item.id : `tc_${Date.now()}_${idx}`,
      name,
      args: parseJsonObject(argsText) ?? {},
    }]
  })
}

function streamFromProvider(
  provider: ModelProvider,
  args: StreamStepArgs,
  controller: AbortController,
  onChunk: (text: string) => void,
  onReasoningChunk?: (text: string) => void,
): Promise<StreamStepResult> {
  const adapter = getAdapter(provider.id)
  return adapter.streamChat({
    provider,
    args,
    controller,
    onChunk,
    onReasoningChunk,
  })
}

function sendRunStatus(
  webContents: RuntimeEventTarget,
  args: StreamChatArgs,
  provider: ModelProvider,
  model: string,
  phase: AssistantRunPhase,
): void {
  toolRuntime.sendRunStatus(webContents, args, provider, model, phase)
}

function sendTextDelta(webContents: RuntimeEventTarget, args: StreamChatArgs, text: string): void {
  toolRuntime.sendTextDelta(webContents, args, text)
}

function sendReasoningDelta(webContents: RuntimeEventTarget, args: StreamChatArgs, text: string): void {
  toolRuntime.sendReasoningDelta(webContents, args, text)
}

async function runToolLoop(
  webContents: RuntimeEventTarget,
  provider: ModelProvider,
  args: StreamChatArgs,
  controller: AbortController,
): Promise<Omit<StreamChatResult, 'provider' | 'attempts' | 'fallbackUsed'>> {
  const model = provider.defaultModel
  const currentTask = latestUserRequest(args.messages)
  const tools = listAvailableTools(
    currentTask,
    args.activeCommandInvocation,
    Boolean(args.activeStepRequiredTools?.length),
    args.activeStepRequiredTools,
    args.routedMcpToolNames,
  )
  const effectiveProvider: ModelProvider = {
    ...provider,
    reasoningMode: chooseReasoningMode(provider, currentTask, tools.length > 0, args.activeStepRole),
  }
  const hiddenReasoningBudgetChars = chooseHiddenReasoningBudgetChars(
    effectiveProvider.reasoningMode === 'on' ? 'on' : 'off',
    currentTask,
    tools.length > 0,
  )
  const savedHint = args.toolFormatMap?.[toolKey(provider.id, model)]
  const initialHint = tools.length > 0 ? savedHint : 'none'
  const effectiveInitialHint: ToolCallFormat | undefined =
    initialHint === 'none'
      ? undefined
      : initialHint ?? (provider.id === 'lmstudio' && tools.length > 0 ? 'hermes' : undefined)
  const workingMessages: LlmMessage[] = injectRuntimeEnvironmentPrompt(args.messages)
  const parts: StreamChatResult['parts'] = []
  let fullContent = ''
  let detectedToolFormat: ToolCallFormat = initialHint ?? 'none'
  let toolCallsIssued = 0
  let sawFirstToken = false
  let rawCommandCorrectionIssued = false
  let actionCorrectionCount = 0
  const baseBudget = toolLoopBudgetFromArgs(args)
  let effectiveBudget = baseBudget
  let extensionsUsed = 0
  // No hard cap on extensions — as long as hasRecentProgress() is true we
  // keep granting more rounds. The MAX_TOOL_LOOP ceiling and the
  // unrecoverable_repeat / no_progress heuristics are the real stops.
  const EXTENSION_AMOUNT = 10
  // Sliding window of the most-recent tool-call fingerprints. Each entry is
  // `${name}|${argsKey}|${status}`. Two heuristics use this:
  //   1. Unrecoverable repeat — last 3 entries identical means the model is
  //      hammering the same call. Stop early whether it keeps failing or keeps
  //      succeeding; repeated successful reads are not real progress.
  //   2. Stagnation — none of the last 5 entries succeeded. The model is
  //      thrashing without progress. Don't grant any budget extensions.
  const recentSignatures: string[] = []
  const SIG_WINDOW = 8
  const REPEAT_LIMIT = 3
  const STAGNATION_WINDOW = 5
  // Typed as string | null so TS doesn't narrow it based on which branches
  // assign which literal — the recordSignature closure assigns
  // 'unrecoverable_repeat' which the outer flow can't see otherwise.
  let earlyStopReason: string | null = null
  const recordSignature = (name: string, args: unknown, status: 'ok' | 'stale_ok' | 'error'): void => {
    let argsKey: string
    try {
      const s = JSON.stringify(args ?? {})
      argsKey = s.length > 200 ? s.slice(0, 200) : s
    } catch { argsKey = '?' }
    recentSignatures.push(`${name}|${argsKey}|${status}`)
    if (recentSignatures.length > SIG_WINDOW) recentSignatures.shift()
    // Check 1: identical tool+args+status repeated REPEAT_LIMIT times in a row.
    if (recentSignatures.length >= REPEAT_LIMIT) {
      const tail = recentSignatures.slice(-REPEAT_LIMIT)
      const allSame = tail.every(s => s === tail[0])
      if (allSame && tail[0].endsWith('|error')) {
        earlyStopReason = 'unrecoverable_repeat'
      } else if (allSame && (tail[0].endsWith('|ok') || tail[0].endsWith('|stale_ok'))) {
        earlyStopReason = 'repeated_success'
      }
    }
  }
  const hasRecentProgress = (): boolean => {
    if (recentSignatures.length === 0) return true
    const window = recentSignatures.slice(-STAGNATION_WINDOW)
    return window.some(s => s.endsWith('|ok'))
  }
  const finalReportReadBudget = typeof args.finalReportReadBudget === 'number'
    ? Math.max(0, Math.floor(args.finalReportReadBudget))
    : undefined
  let finalReportReadCalls = 0

  for (let round = 0; round < effectiveBudget; round += 1) {
    if (controller.signal.aborted) throw new Error('aborted')
    sendRunStatus(webContents, args, provider, model, round === 0 ? 'waiting_first_token' : 'generating')
    let bufferedVisibleText = ''

    const stepMessages =
      effectiveInitialHint === 'hermes'
        ? injectHermesToolPrompt(workingMessages, tools)
        : workingMessages

    const step = await streamFromProvider(
      effectiveProvider,
      {
        ...args,
        messages: stepMessages,
        tools,
        toolFormatHint: detectedToolFormat === 'none' ? effectiveInitialHint : detectedToolFormat,
        hiddenReasoningBudgetChars,
      },
      controller,
      text => {
        if (!sawFirstToken) {
          sawFirstToken = true
          sendRunStatus(webContents, args, provider, model, 'generating')
        }
        if (tools.length > 0) {
          bufferedVisibleText += text
          return
        }
        sendTextDelta(webContents, args, text)
      },
      text => {
        sendReasoningDelta(webContents, args, text)
      },
    )

    if (step.detectedToolFormat !== 'none') {
      detectedToolFormat = step.detectedToolFormat
    } else if (!effectiveInitialHint) {
      detectedToolFormat = 'none'
    }

    const outputLimitReached = step.finishReason === 'length' || step.finishReason === 'max_tokens'
    const toolCallTruncated = step.finishReason === 'tool_call_truncated'
    const serverDisconnected = step.finishReason === 'stream_disconnected'
    const visibleText = stripResidualToolMarkup(step.visibleText ?? '')
    let toolCalls = normalizeToolCallsForContext(step.toolCalls, args.activeFolderPath)
    if (toolCallTruncated) {
      workingMessages.splice(0, workingMessages.length, ...withTruncatedToolCallRetryPrompt(workingMessages, visibleText))
      continue
    }
    const trailingRawCommand =
      tools.length > 0 && toolCalls.length === 0 && visibleText
        ? extractTrailingRawCommand(visibleText)
        : null
    if (trailingRawCommand) {
      const shellToolCall = rawCommandToShellToolCall(visibleText, args.activeFolderPath)
      if (shellToolCall) {
        toolCalls = [shellToolCall]
      } else if (!rawCommandCorrectionIssued) {
        rawCommandCorrectionIssued = true
        workingMessages.splice(0, workingMessages.length, ...withToolCallCorrectionPrompt(workingMessages, visibleText))
        continue
      } else {
        const failText = rawCommandNoToolText(visibleText)
        fullContent += failText
        parts.push({ type: 'text', text: failText })
        sendTextDelta(webContents, args, failText)
        return {
          fullContent,
          parts,
          model,
          toolCallsIssued,
          loopRounds: round + 1,
          detectedToolFormat,
          stopReason: 'raw_command_no_tool',
        }
      }
    }

    if (trailingRawCommand?.prefixText && toolCalls.length > 0) {
      fullContent += trailingRawCommand.prefixText
      parts.push({ type: 'text', text: trailingRawCommand.prefixText })
      if (tools.length > 0 && bufferedVisibleText) sendTextDelta(webContents, args, trailingRawCommand.prefixText)
    }

    const actionPromiseWithoutTool =
      tools.length > 0 &&
      toolCalls.length === 0 &&
      args.activeStepRole !== 'final_report' &&
      Boolean(visibleText) &&
      looksLikeActionPromiseWithoutTool(visibleText)
    if (actionPromiseWithoutTool) {
      const synthesizedToolCall = actionPromiseToToolCall(visibleText, args.activeFolderPath)
      if (synthesizedToolCall) {
        toolCalls = normalizeToolCallsForContext([synthesizedToolCall], args.activeFolderPath)
      } else if (actionCorrectionCount < 4) {
        actionCorrectionCount += 1
        workingMessages.splice(0, workingMessages.length, ...withActionRequiredPrompt(workingMessages, visibleText))
        continue
      }
    }

    const inlineThinkingOnly =
      toolCalls.length === 0 && step.visibleText ? isInlineThinkingOnly(step.visibleText) : false

    if (toolCalls.length === 0) {
      console.warn('[ava-debug] no-tool-call round', {
        provider: provider.id,
        model,
        finishReason: step.finishReason,
        hiddenReasoningExceeded: step.hiddenReasoningExceeded,
        hiddenReasoningChars: step.hiddenReasoningChars,
        visibleTextLen: visibleText.length,
        visibleTextSample: visibleText.slice(0, 300),
        inlineThinkingOnly,
        toolsExposedCount: tools.length,
        reasoningMode: effectiveProvider.reasoningMode,
        round,
      })
    }

    if (visibleText && toolCalls.length === 0 && !inlineThinkingOnly) {
      fullContent += visibleText
      parts.push({ type: 'text', text: visibleText })
      if (tools.length > 0 && bufferedVisibleText) sendTextDelta(webContents, args, visibleText)
    }

    // Treat any inline-thinking-only response with no tool call as a reasoning
    // failure regardless of finishReason. The model spent its budget thinking
    // and produced no actionable output — same recovery path as
    // hiddenReasoningExceeded (retry with reasoning off, then mark broken).
    const reasoningExceededLikely =
      step.hiddenReasoningExceeded ||
      (inlineThinkingOnly && toolCalls.length === 0)

    if (reasoningExceededLikely && (!step.visibleText || inlineThinkingOnly) && toolCalls.length === 0) {
      const finalizeProvider: ModelProvider = { ...effectiveProvider, reasoningMode: 'off' }
      const finalizeMessages = withFinalizePrompt(workingMessages)
      const finalizeStep = await streamFromProvider(
        finalizeProvider,
        {
          ...args,
          messages: finalizeMessages,
          tools: [],
          toolFormatHint: 'none',
          hiddenReasoningBudgetChars: 0,
        },
        controller,
        text => {
          if (!sawFirstToken) {
            sawFirstToken = true
            sendRunStatus(webContents, args, provider, model, 'generating')
          }
          sendTextDelta(webContents, args, text)
        },
      )
      const finalizeVisibleText = stripResidualToolMarkup(finalizeStep.visibleText ?? '')
      if (finalizeVisibleText) {
        // Recovery worked, but only with reasoning forced off. Remember this so
        // future calls for this provider+model skip the wasted reasoning attempt.
        markReasoningBroken(provider.id, model)
        fullContent += finalizeVisibleText
        parts.push({ type: 'text', text: finalizeVisibleText })
        return {
          fullContent,
          parts,
          model,
          toolCallsIssued,
          loopRounds: round + 1,
          detectedToolFormat,
        }
      }
      // Even with reasoning forced off the model produced nothing. Mark broken
      // so the next call skips the reasoning-on attempt and gives the user a
      // clean run; the underlying chat-template issue still needs the user's
      // attention but Ava will at least not loop on it.
      markReasoningBroken(provider.id, model)
      const failText = [
        'Model produced only hidden reasoning (chain-of-thought) and no visible content or tool call, even after a recovery attempt with reasoning disabled.',
        'This is almost always a model template / profile mismatch — the model is emitting content into a reasoning_content channel that Ava cannot use to drive tools.',
        '',
        'How to fix:',
        '1. In Ava → Settings → Providers, set reasoningMode = "off" for this model.',
        '2. In LM Studio (or your provider), switch to a non-thinking variant (Instruct / Chat build) of the same model.',
        '3. As a last resort, edit the model\'s chat template to flush <think> blocks before the final answer.',
        '',
        '模型只输出了 reasoning_content（思考链），即便在关闭 reasoning 后重试也没有返回可显示的最终答案或工具调用。',
        '请把该 provider 的 reasoningMode 设为 "off"，或在 LM Studio 中切换到非 thinking 版本（Instruct / Chat），或修改聊天模板让 <think> 块在最终答案前结束。',
      ].join('\n')
      fullContent += failText
      parts.push({ type: 'text', text: failText })
      sendTextDelta(webContents, args, failText)
      return {
        fullContent,
        parts,
        model,
        toolCallsIssued,
        loopRounds: round + 1,
        detectedToolFormat,
      }
    }

    if (toolCalls.length === 0) {
      if (visibleText) {
        workingMessages.push({ role: 'assistant', content: visibleText })
      }
      return {
        fullContent,
        parts,
        model,
        toolCallsIssued,
        loopRounds: round + 1,
        detectedToolFormat,
        ...(outputLimitReached ? { stopReason: 'output_limit' as const } : {}),
        ...(serverDisconnected ? { stopReason: 'server_disconnected' as const } : {}),
      }
    }

    toolCallsIssued += toolCalls.length
    workingMessages.push({
      role: 'assistant',
      content: visibleText,
      toolCalls,
    })
    for (const toolCall of toolCalls) {
      if (controller.signal.aborted) throw new Error('aborted')
      sendRunStatus(webContents, args, provider, model, 'tool_running')

      const partIndex = parts.length
      const duplicateToolCall = toolRuntime.hasResolvedToolCall(args.streamId, toolCall.id)
      const finalReportBudgetReason =
        !duplicateToolCall &&
        finalReportReadBudget !== undefined &&
        isFinalReportReadTool(toolCall.name) &&
        finalReportReadCalls >= finalReportReadBudget
          ? finalReportBudgetError(finalReportReadBudget)
          : null
      if (!duplicateToolCall && finalReportReadBudget !== undefined && isFinalReportReadTool(toolCall.name) && !finalReportBudgetReason) {
        finalReportReadCalls += 1
      }
      const builtInTool = builtInTools.resolveTool(toolCall.name)
      const resolvedTool = builtInTool ?? mcpSupervisor.resolveTool(toolCall.name)
      const serverRuntime = resolvedTool && !builtInTool ? mcpSupervisor.getServer(resolvedTool.serverId) : null
      const disallowedStepToolReason =
        !duplicateToolCall && !isToolAllowedForActiveStep(toolCall.name, args.activeStepRequiredTools)
          ? [
              `Tool "${toolCall.name}" is not available for the current task step.`,
              args.activeStepRole ? `Current step role: ${args.activeStepRole}.` : '',
              args.activeStepRequiredTools?.length ? `Allowed step tools: ${args.activeStepRequiredTools.join(', ')}.` : '',
              'Use one of the allowed tools or safe read-only inspection tools for this step; do not jump ahead to later steps.',
            ].filter(Boolean).join(' ')
          : null
      const unknownToolReason =
        !duplicateToolCall && !resolvedTool
          ? `unknown tool: ${toolCall.name}`
          : null
      const staleReason = duplicateToolCall
        ? null
        : finalReportBudgetReason ?? disallowedStepToolReason ?? unknownToolReason ?? validateToolAgainstCurrentTask(toolCall, currentTask)
      const startedAt = Date.now()
      const toolPart: ToolCallPart = {
        type: 'tool_call',
        taskId: args.activeTaskId,
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        status: staleReason ? 'error' : 'running',
        startedAt,
        ...(staleReason ? { endedAt: Date.now(), error: staleReason } : {}),
      }
      parts.push(toolPart)

      toolRuntime.sendToolStarted(webContents, args, partIndex, toolPart)

      if (duplicateToolCall) {
        const duplicatePatch = duplicateToolResultPatch()
        Object.assign(toolPart, duplicatePatch)
        toolRuntime.sendToolResult(webContents, args, partIndex, toolCall.id, duplicatePatch)
        workingMessages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify(duplicatePatch.result, null, 2),
        })
        continue
      }

      if (staleReason) {
        toolRuntime.rememberResolvedToolCall(args.streamId, toolCall.id)
        toolRuntime.sendError(webContents, args, staleReason)
        await appendToolAudit({
          args,
          provider,
          model,
          toolCall,
          startedAt,
          status: 'error',
          error: staleReason,
          serverId: resolvedTool?.serverId,
          rawToolName: resolvedTool?.rawName,
          pluginId: serverRuntime?.pluginId,
        })
        workingMessages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify({ error: staleReason }, null, 2),
        })
        continue
      }

      const result = await callToolSafely({
        toolCall,
        builtInTool,
        resolvedMcpTool: builtInTool ? null : resolvedTool,
        args,
      })
      const compactedResult = result.ok
        ? await compactToolResultForContext(result.content, {
            activeFolderPath: args.activeFolderPath,
            streamId: args.streamId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          })
        : null
      const resultForContext: CallToolResult | CallToolError = result.ok
        ? {
            ...result,
            content: compactedResult?.content,
          }
        : result

      const patch: Partial<ToolCallPart> = {
        endedAt: Date.now(),
        status: resultForContext.ok ? (resultForContext.isError ? 'error' : 'ok') : (resultForContext.aborted ? 'aborted' : 'error'),
      }
      if (resultForContext.ok) {
        patch.result = resultForContext.content
        if (compactedResult?.persistedOutput) patch.persistedOutput = compactedResult.persistedOutput
      } else {
        patch.error = resultForContext.error
      }

      Object.assign(toolPart, patch)
      toolRuntime.rememberResolvedToolCall(args.streamId, toolCall.id)
      await appendToolAudit({
        args,
        provider,
        model,
        toolCall,
        startedAt,
        status: resultForContext.ok
          ? (resultForContext.isError ? 'error' : 'ok')
          : (resultForContext.aborted ? 'aborted' : 'error'),
        error: resultForContext.ok ? undefined : resultForContext.error,
        result: resultForContext.ok ? resultForContext.content : undefined,
        isToolError: resultForContext.ok ? Boolean(resultForContext.isError) : undefined,
        serverId: resolvedTool?.serverId,
        rawToolName: resolvedTool?.rawName,
        pluginId: serverRuntime?.pluginId,
      })
      toolRuntime.sendToolResult(webContents, args, partIndex, toolCall.id, patch)

      if (!resultForContext.ok && resultForContext.aborted) {
        throw new Error('aborted')
      }

      const toolText = JSON.stringify(resultForContext.ok ? resultForContext.content : { error: resultForContext.error }, null, 2)
      workingMessages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: toolText,
      })
      if (!resultForContext.ok || resultForContext.isError) {
        workingMessages.push({
          role: 'system',
          content: toolRecoveryMessage(toolCall, resultForContext.ok ? toolText : resultForContext.error),
        })
      }
      const unsatisfiedMessage = unsatisfiedRequiredToolMessage(args, toolCall)
      if (resultForContext.ok && !resultForContext.isError && unsatisfiedMessage) {
        workingMessages.push({
          role: 'system',
          content: unsatisfiedMessage,
        })
      }

      const toolParts = parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
      const stepProgressSatisfied = progressToolSatisfiedForStep(
        args,
        toolCall,
        resultForContext,
        toolParts,
      )
      const semanticProgress = stepProgressSatisfied || toolMadeSemanticProgressForStep(args, toolCall, resultForContext, toolParts)
      if (
        args.activeStepRole === 'feature' &&
        resultForContext.ok &&
        !resultForContext.isError &&
        isFeatureVerificationTool(toolCall.name) &&
        !toolParts.some(part => part.status === 'ok' && isFeatureEditTool(part.name))
      ) {
        workingMessages.push({
          role: 'system',
          content: [
            'The inspection succeeded, but this is a feature implementation step and no file edit has been made in this step.',
            'Do not keep inspecting the project.',
            'Call file.write_text or file.patch now to implement the current step. If you cannot edit because required information is missing, explain the blocker visibly instead of calling another inspection tool.',
          ].join(' '),
        })
      }

      // Smart-budget signal: semantic progress is step-aware. A successful
      // read-only inspection during a feature step is not progress unless it
      // verifies an edit made in the same step.
      recordSignature(
        toolCall.name,
        toolCall.args,
        result.ok && !result.isError ? (semanticProgress ? 'ok' : 'stale_ok') : 'error',
      )

      if (stepProgressSatisfied) {
        return {
          fullContent,
          parts,
          model,
          toolCallsIssued,
          loopRounds: round + 1,
          detectedToolFormat,
        }
      }
    }
    sendRunStatus(webContents, args, provider, model, 'generating')

    // Smart-budget early stop: same tool+args+status happened REPEAT_LIMIT
    // times in a row. Repeating successful inspections forever is still a loop.
    if (earlyStopReason) {
      console.warn('[ava-debug] tool-loop early stop', earlyStopReason, recentSignatures.slice(-REPEAT_LIMIT))
      break
    }

    // Smart-budget extension: if we're about to hit the budget and the
    // model is still making progress (recent ok tool calls), grant +10
    // rounds. No cap on extensions — only MAX_TOOL_LOOP and the
    // no_progress / unrecoverable_repeat heuristics actually stop us.
    // If there's no progress in the last STAGNATION_WINDOW calls, bail.
    if (round + 1 >= effectiveBudget && effectiveBudget < MAX_TOOL_LOOP) {
      if (hasRecentProgress()) {
        effectiveBudget = Math.min(effectiveBudget + EXTENSION_AMOUNT, MAX_TOOL_LOOP)
        extensionsUsed += 1
        console.warn('[ava-debug] tool-loop budget extended', {
          newBudget: effectiveBudget,
          extensionsUsed,
          ceiling: MAX_TOOL_LOOP,
        })
      } else {
        earlyStopReason = 'no_progress'
      }
    }
  }

  if (
    args.activeStepRole &&
    madeStepProgress(parts.filter((part): part is ToolCallPart => part.type === 'tool_call'))
  ) {
    return {
      fullContent,
      parts,
      model,
      toolCallsIssued,
      loopRounds: effectiveBudget,
      detectedToolFormat,
      stopReason: 'tool_loop_limit',
    }
  }

  const recentTools = parts
    .filter((part): part is ToolCallPart => part.type === 'tool_call')
    .slice(-5)
    .map(part => {
      const argText = JSON.stringify(part.args).slice(0, 180)
      const statusText = part.status === 'ok'
        ? `ok: ${JSON.stringify(part.result).slice(0, 220)}`
        : part.error ?? part.status
      return `- ${part.name}(${argText}): ${statusText}`
    })
    .join('\n')
  // Pull the last failing tool call so we can show its error in the stop
  // message — useful for telling apart "model gave bad args" (LLM bug) vs
  // "tool returned a malformed result every time" (Ava bug).
  const lastFailingPart = [...parts]
    .reverse()
    .find((p): p is ToolCallPart => p.type === 'tool_call' && p.status === 'error')
  const lastErrorText = lastFailingPart
    ? `${lastFailingPart.name}: ${lastFailingPart.error ?? '(no message)'}`
    : ''
  // Heuristic: if the same tool keeps returning an error that matches a
  // known Ava-side pattern, ask the user to file a bug.
  const looksLikeAvaBug = lastFailingPart && /(expected \d+ replacement.*found 0|Unknown tool|not registered|tool name not recognized)/i.test(lastFailingPart.error ?? '')
  const headline =
    earlyStopReason === 'unrecoverable_repeat'
      ? 'Stopped: same tool call failed repeatedly with no recovery — likely a permission, missing path, or wrong-tool-name issue.'
      : earlyStopReason === 'repeated_success'
        ? 'Stopped: same successful tool call repeated without advancing the task step.'
      : earlyStopReason === 'no_progress'
        ? 'Stopped: no tool call has succeeded recently — the model appears stuck without making progress.'
        : `Tool loop reached the safety ceiling of ${effectiveBudget} rounds. The model may still be productive — re-send to continue, or stop here.`
  const stopText = [
    headline,
    lastErrorText ? `Last error → ${lastErrorText}` : '',
    looksLikeAvaBug
      ? 'NOTE: this error pattern often points to an Ava internal bug (tool dispatch / patch normalization). Please file an Ava bug report with the recent tool calls below.'
      : '',
    recentTools ? `Recent tool calls:\n${recentTools}` : '',
    '',
    'Ava stopped to avoid repeating the same action indefinitely.',
  ].filter(Boolean).join('\n')
  fullContent += stopText
  parts.push({ type: 'text', text: stopText })
  sendTextDelta(webContents, args, stopText)
  return {
    fullContent,
    parts,
    model,
    toolCallsIssued,
    loopRounds: effectiveBudget,
    detectedToolFormat,
    stopReason: 'tool_loop_limit',
  }
}

async function appendToolAudit(input: {
  args: StreamChatArgs
  provider: ModelProvider
  model: string
  toolCall: ToolCallCandidate
  startedAt: number
  status: 'ok' | 'error' | 'aborted'
  error?: string
  result?: unknown
  isToolError?: boolean
  serverId?: string
  rawToolName?: string
  pluginId?: string
}): Promise<void> {
  try {
    await capabilityStats.recordUse({
      id: `${input.serverId ? 'mcp_tool' : 'built_in_tool'}:${input.toolCall.name}`,
      kind: input.serverId ? 'mcp_tool' : 'built_in_tool',
      success: input.status === 'ok' && !input.isToolError,
    })
    await toolAuditLog.append({
      streamId: input.args.streamId,
      taskId: input.args.activeTaskId,
      providerId: input.provider.id,
      providerName: input.provider.name,
      model: input.model,
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      serverId: input.serverId,
      rawToolName: input.rawToolName,
      pluginId: input.pluginId,
      commandInvocation: input.args.activeCommandInvocation,
      args: input.toolCall.args,
      status: input.status,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      isToolError: input.isToolError,
      error: input.error,
      resultPreview: previewValue(input.result),
    })
  } catch (err) {
    console.warn('[tool-audit] append failed:', err)
  }
}

export async function streamChat(
  webContents: RuntimeEventTarget,
  args: StreamChatArgs,
): Promise<StreamChatResult> {
  if (!args.providers.length) {
    throw new Error('No enabled LLM provider. Configure one in Settings.')
  }

  const controller = new AbortController()
  activeStreams.set(args.streamId, { controller, aborted: false })

  const attempts: LlmAttempt[] = []

  try {
    const skillCandidates = await pluginManager.skillCandidatesForStates(args.pluginStates ?? {})
    const mcpTools = mcpSupervisor.listAllTools()
    const currentTask = latestUserRequest(args.messages)
    const messagesText = compactMessagesText(args.messages)
    const capabilityIndex = buildCapabilityIndex({
      builtInTools: builtInTools.listTools(),
      mcpTools,
      skills: skillCandidates,
    })
    const routedMcpTools = routeMcpTools(mcpTools, {
      currentTask,
      activeStepRole: args.activeStepRole,
      activeStepRequiredTools: args.activeStepRequiredTools,
      messagesText,
      maxMcpTools: maxMcpToolsForStep(args.activeStepRole),
    })
    const routedSkills = routeSkills(skillCandidates, {
      currentTask,
      activeStepRole: args.activeStepRole,
      activeStepRequiredTools: args.activeStepRequiredTools,
      messagesText,
      maxSkills: maxSkillsForStep(args.activeStepRole),
    })
    const pluginSkills = await pluginManager.skillsForCandidates(routedSkills.map(item => item.item))
    const skillReasons = new Map(routedSkills.map(item => [
      `${item.item.pluginId}:${item.item.name}`,
      { score: item.score, reasons: item.reasons },
    ]))
    for (const skill of pluginSkills) {
      const routed = skillReasons.get(`${skill.pluginId}:${skill.name}`)
      if (!routed) continue
      skill.routingScore = routed.score
      skill.routingReasons = routed.reasons
    }
    await capabilityStats.recordSelection([
      ...routedSkills.map(item => ({ id: `skill:${item.item.pluginId}:${item.item.name}`, kind: 'skill' as const, injected: true })),
      ...routedMcpTools.map(item => ({ id: `mcp_tool:${item.item.name}`, kind: 'mcp_tool' as const })),
    ])
    await capabilityStats.appendRouteLog({
      streamId: args.streamId,
      taskId: args.activeTaskId,
      activeStepRole: args.activeStepRole,
      totalCapabilities: capabilityIndex.length,
      selectedSkills: routedSkills.map(item => ({
        id: `skill:${item.item.pluginId}:${item.item.name}`,
        name: `${item.item.pluginName}/${item.item.name}`,
        score: item.score,
        reasons: item.reasons,
      })),
      selectedMcpTools: routedMcpTools.map(item => ({
        id: `mcp_tool:${item.item.name}`,
        name: item.item.name,
        score: item.score,
        reasons: item.reasons,
      })),
      createdAt: Date.now(),
    })
    if (skillCandidates.length > 0 || mcpTools.length > 0) {
      console.info('[capability-router] selected capabilities', {
        totalCapabilities: capabilityIndex.length,
        skillCandidates: skillCandidates.length,
        mcpCandidates: mcpTools.length,
        selectedSkills: pluginSkills.map(skill => ({
          plugin: skill.pluginName,
          name: skill.name,
          score: skill.routingScore,
          reasons: skill.routingReasons,
        })),
        selectedMcpTools: routedMcpTools.map(item => ({
          name: item.item.name,
          score: item.score,
          reasons: item.reasons,
        })),
        activeStepRole: args.activeStepRole,
      })
    }
    const argsWithSkills: StreamChatArgs = {
      ...args,
      messages: injectPluginSkills(args.messages, pluginSkills),
      routedMcpToolNames: routedMcpTools.map(item => item.item.name),
    }
    for (const provider of args.providers) {
      const model = provider.defaultModel
      try {
        sendRunStatus(webContents, argsWithSkills, provider, model, 'connecting')
        const result = await runToolLoop(webContents, provider, argsWithSkills, controller)
        sendRunStatus(webContents, argsWithSkills, provider, model, 'completed')
        attempts.push({ providerId: provider.id, providerName: provider.name, model, ok: true })
        return {
          ...result,
          provider,
          attempts,
          fallbackUsed: attempts.length > 1,
        }
      } catch (err) {
        if (controller.signal.aborted) throw new Error('aborted')
        attempts.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
        if (!webContents.isDestroyed()) {
          webContents.send('ava:llm:attempt', { streamId: args.streamId, attempts: [...attempts] })
        }
        sendRunStatus(
          webContents,
          argsWithSkills,
          provider,
          model,
          attempts.length < args.providers.length ? 'fallback' : 'error',
        )
      }
    }

    const lastError = [...attempts].reverse().find(a => !a.ok)?.error ?? 'unknown_llm_error'
    throw new Error(`All providers failed. Last error: ${lastError}`)
  } finally {
    activeStreams.delete(args.streamId)
  }
}

export function abortStream(streamId: string): boolean {
  const active = activeStreams.get(streamId)
  if (!active) return false
  active.aborted = true
  active.controller.abort()
  builtInTools.abortAllCalls()
  mcpSupervisor.abortAllCalls()
  activeStreams.delete(streamId)
  return true
}
