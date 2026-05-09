// ─────────────────────────────────────────────
// Main-process LLM client.
// Runs in Node, so no CORS, no cert issues.
// Exposes: streamChat() → emits text / tool-call parts to renderer via IPC.
// ─────────────────────────────────────────────

import { WebContents } from 'electron'
import { mcpSupervisor, type McpToolDescriptor } from './services/mcpSupervisor'
import { pluginManager, type PluginSkill, type PluginState } from './services/pluginManager'
import { previewValue, toolAuditLog, type ToolAuditCommandInvocation } from './services/toolAuditLog'
import { builtInTools } from './services/builtInTools'
import { runtimeEnvironmentPrompt } from './services/runtimeEnvironment'
import { OpenAiAdapter } from './adapters/openai'
import { AnthropicAdapter } from './adapters/anthropic'
import { LlmAdapter } from './adapters/base'

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

export interface ToolCallPart {
  type: 'tool_call'
  taskId?: string
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolCallStatus
  result?: unknown
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface StreamChatArgs {
  streamId: string
  messages: LlmMessage[]
  providers: ModelProvider[]
  activeTaskId?: string
  activeFolderPath?: string
  activeCommandInvocation?: ToolAuditCommandInvocation
  temperature?: number
  toolFormatMap?: Record<string, ToolCallFormat>
  pluginStates?: Record<string, PluginState>
  activeStepRequiredTools?: string[]
  activeStepToolLoopBudget?: number
  finalReportReadBudget?: number
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
const DEFAULT_TOOL_LOOP = 10
const MAX_TOOL_LOOP = 50
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
  'project.map',
  'project.detect',
  'search.ripgrep',
])

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

function listAvailableTools(
  currentTask: string,
  activeCommandInvocation?: ToolAuditCommandInvocation,
  forceToolExposure = false,
  activeStepRequiredTools?: string[],
): McpToolDescriptor[] {
  if (!shouldExposeTools(currentTask, activeCommandInvocation, forceToolExposure)) return []
  const all = [...builtInTools.listTools(), ...mcpSupervisor.listAllTools()]
  if (!activeStepRequiredTools || activeStepRequiredTools.length === 0) return all
  const allowed = new Set([...activeStepRequiredTools, ...ALWAYS_ALLOWED_CORE_TOOLS])
  return all.filter(tool => allowed.has(tool.name))
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
): 'off' | 'on' {
  if (provider.reasoningMode === 'off') return 'off'
  if (provider.reasoningMode === 'on') return 'on'
  if (isReasoningBroken(provider.id, provider.defaultModel)) return 'off'
  if (REASONING_INTENT_RE.test(currentTask)) return 'on'
  if (toolsExposed && !SIMPLE_CHAT_RE.test(currentTask)) return 'on'
  return 'off'
}

function chooseHiddenReasoningBudgetChars(mode: 'off' | 'on', currentTask: string, toolsExposed: boolean): number {
  if (mode === 'off') return 0
  if (REASONING_INTENT_RE.test(currentTask) || toolsExposed) return 10_000
  return 4_000
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
  file_mkdir: 'file.create_dir',
  mkdir: 'file.create_dir',
  create_dir: 'file.create_dir',
  file_stat: 'file.stat',
  shell_exec: 'shell.run_command',
  shell_execute: 'shell.run_command',
  run_command: 'shell.run_command',
}

function normalizeToolCallName(name: string): string {
  const normalized = name.trim().replace(/\./g, '_').toLowerCase()
  return TOOL_NAME_ALIASES[normalized] ?? name
}

function expandToolCallAliases(toolCall: ToolCallCandidate): ToolCallCandidate[] {
  const normalizedName = toolCall.name.trim().replace(/\./g, '_').toLowerCase()
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
        'For long-running dev servers, use devserver.start.',
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
        'For creating or editing files, use file.write_text or file.patch.',
      ].join(' '),
    },
  ]
}

function rawCommandNoToolText(rawText: string): string {
  const command = rawText.trim().split(/\r?\n/)[0]?.trim() || '(empty command)'
  return `Stopped: the model output a raw command instead of calling a tool: ${command}. Ava did not execute it. Please retry; Ava will require a tool call such as project.map, file.list_dir, shell.run_command, or devserver.start.`
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
    'Use git.status and git.diff for read-only change review; do not commit or push unless the latest user request explicitly asks.',
    'For code-agent work that needs commands, use shell.run_command with {"command":"npm","args":["..."],"cwd":"..."}; never claim you ran a command unless the tool call succeeded.',
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
    skill.content.trim(),
  ].join('\n'))
  return [
    'Enabled plugin skills:',
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

export function stripResidualToolMarkup(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function=[A-Za-z0-9_.-]+>[\s\S]*?(?:<\/function>)?/g, '')
    .trim()
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
  webContents: WebContents,
  args: StreamChatArgs,
  provider: ModelProvider,
  model: string,
  phase: AssistantRunPhase,
): void {
  if (webContents.isDestroyed()) return
  webContents.send('ava:llm:status', {
    streamId: args.streamId,
    taskId: args.activeTaskId,
    providerId: provider.id,
    providerName: provider.name,
    model,
    phase,
  })
}

async function runToolLoop(
  webContents: WebContents,
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
  )
  const effectiveProvider: ModelProvider = {
    ...provider,
    reasoningMode: chooseReasoningMode(provider, currentTask, tools.length > 0),
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
  const loopBudget = toolLoopBudgetFromArgs(args)
  const finalReportReadBudget = typeof args.finalReportReadBudget === 'number'
    ? Math.max(0, Math.floor(args.finalReportReadBudget))
    : undefined
  let finalReportReadCalls = 0

  for (let round = 0; round < loopBudget; round += 1) {
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
        if (!webContents.isDestroyed()) {
          webContents.send('ava:llm:chunk', { streamId: args.streamId, text })
        }
      },
      text => {
        if (!webContents.isDestroyed()) {
          webContents.send('ava:llm:reasoning-chunk', { streamId: args.streamId, text })
        }
      },
    )

    if (step.detectedToolFormat !== 'none') {
      detectedToolFormat = step.detectedToolFormat
    } else if (!effectiveInitialHint) {
      detectedToolFormat = 'none'
    }

    const outputLimitReached = step.finishReason === 'length' || step.finishReason === 'max_tokens'
    const serverDisconnected = step.finishReason === 'stream_disconnected'
    let toolCalls = normalizeToolCallsForContext(step.toolCalls, args.activeFolderPath)
    const trailingRawCommand =
      tools.length > 0 && toolCalls.length === 0 && step.visibleText
        ? extractTrailingRawCommand(step.visibleText)
        : null
    if (trailingRawCommand) {
      const shellToolCall = rawCommandToShellToolCall(step.visibleText, args.activeFolderPath)
      if (shellToolCall) {
        toolCalls = [shellToolCall]
      } else if (!rawCommandCorrectionIssued) {
        rawCommandCorrectionIssued = true
        workingMessages.splice(0, workingMessages.length, ...withToolCallCorrectionPrompt(workingMessages, step.visibleText))
        continue
      } else {
        const failText = rawCommandNoToolText(step.visibleText)
        fullContent += failText
        parts.push({ type: 'text', text: failText })
        if (!webContents.isDestroyed()) {
          webContents.send('ava:llm:chunk', { streamId: args.streamId, text: failText })
        }
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
      if (tools.length > 0 && bufferedVisibleText && !webContents.isDestroyed()) {
        webContents.send('ava:llm:chunk', { streamId: args.streamId, text: trailingRawCommand.prefixText })
      }
    }

    const actionPromiseWithoutTool =
      tools.length > 0 &&
      toolCalls.length === 0 &&
      Boolean(step.visibleText) &&
      looksLikeActionPromiseWithoutTool(step.visibleText)
    if (actionPromiseWithoutTool) {
      const synthesizedToolCall = actionPromiseToToolCall(step.visibleText, args.activeFolderPath)
      if (synthesizedToolCall) {
        toolCalls = normalizeToolCallsForContext([synthesizedToolCall], args.activeFolderPath)
      } else if (actionCorrectionCount < 4) {
        actionCorrectionCount += 1
        workingMessages.splice(0, workingMessages.length, ...withActionRequiredPrompt(workingMessages, step.visibleText))
        continue
      }
    }

    if (step.visibleText && toolCalls.length === 0) {
      fullContent += step.visibleText
      parts.push({ type: 'text', text: step.visibleText })
      if (tools.length > 0 && bufferedVisibleText && !webContents.isDestroyed()) {
        webContents.send('ava:llm:chunk', { streamId: args.streamId, text: step.visibleText })
      }
    }

    if (step.hiddenReasoningExceeded && !step.visibleText && toolCalls.length === 0) {
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
          if (!webContents.isDestroyed()) {
            webContents.send('ava:llm:chunk', { streamId: args.streamId, text })
          }
        },
      )
      if (finalizeStep.visibleText) {
        // Recovery worked, but only with reasoning forced off. Remember this so
        // future calls for this provider+model skip the wasted reasoning attempt.
        markReasoningBroken(provider.id, model)
        fullContent += finalizeStep.visibleText
        parts.push({ type: 'text', text: finalizeStep.visibleText })
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
      if (!webContents.isDestroyed()) {
        webContents.send('ava:llm:chunk', { streamId: args.streamId, text: failText })
      }
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
      if (step.visibleText) {
        workingMessages.push({ role: 'assistant', content: step.visibleText })
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
      content: step.visibleText,
      toolCalls,
    })
    for (const toolCall of toolCalls) {
      if (controller.signal.aborted) throw new Error('aborted')
      sendRunStatus(webContents, args, provider, model, 'tool_running')

      const partIndex = parts.length
      const finalReportBudgetReason =
        finalReportReadBudget !== undefined &&
        isFinalReportReadTool(toolCall.name) &&
        finalReportReadCalls >= finalReportReadBudget
          ? finalReportBudgetError(finalReportReadBudget)
          : null
      if (finalReportReadBudget !== undefined && isFinalReportReadTool(toolCall.name) && !finalReportBudgetReason) {
        finalReportReadCalls += 1
      }
      const staleReason = finalReportBudgetReason ?? validateToolAgainstCurrentTask(toolCall, currentTask)
      const builtInTool = builtInTools.resolveTool(toolCall.name)
      const resolvedTool = builtInTool ?? mcpSupervisor.resolveTool(toolCall.name)
      const serverRuntime = resolvedTool && !builtInTool ? mcpSupervisor.getServer(resolvedTool.serverId) : null
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

      if (!webContents.isDestroyed()) {
        webContents.send('ava:llm:part', {
          streamId: args.streamId,
          taskId: args.activeTaskId,
          partIndex,
          part: toolPart,
        })
      }

      if (staleReason) {
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

      const result = builtInTool
        ? await builtInTools.callTool(toolCall.name, toolCall.args, {
            activeFolderPath: args.activeFolderPath,
            allowedDirs: allowedFilesystemDirs(),
          })
        : await mcpSupervisor.callTool({
            namespacedName: toolCall.name,
            rawArgs: toolCall.args,
          })

      const patch: Partial<ToolCallPart> = {
        endedAt: Date.now(),
        status: result.ok ? (result.isError ? 'error' : 'ok') : (result.aborted ? 'aborted' : 'error'),
      }
      if (result.ok) patch.result = result.content
      else patch.error = result.error

      Object.assign(toolPart, patch)
      await appendToolAudit({
        args,
        provider,
        model,
        toolCall,
        startedAt,
        status: result.ok
          ? (result.isError ? 'error' : 'ok')
          : (result.aborted ? 'aborted' : 'error'),
        error: result.ok ? undefined : result.error,
        result: result.ok ? result.content : undefined,
        isToolError: result.ok ? Boolean(result.isError) : undefined,
        serverId: resolvedTool?.serverId,
        rawToolName: resolvedTool?.rawName,
        pluginId: serverRuntime?.pluginId,
      })
      if (!webContents.isDestroyed()) {
        webContents.send('ava:llm:partUpdate', {
          streamId: args.streamId,
          taskId: args.activeTaskId,
          partIndex,
          partId: toolCall.id,
          patch,
        })
      }

      if (!result.ok && result.aborted) {
        throw new Error('aborted')
      }

      const toolText = JSON.stringify(result.ok ? result.content : { error: result.error }, null, 2)
      workingMessages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: toolText,
      })

      if (
        args.activeStepRequiredTools?.length &&
        result.ok &&
        !result.isError &&
        args.activeStepRequiredTools.includes(toolCall.name)
      ) {
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
  const stopText = [
    `Tool loop exceeded after ${loopBudget} round(s), stopping.`,
    recentTools ? `Recent tool calls:\n${recentTools}` : '',
    '',
    'Ava stopped to avoid repeating the same action indefinitely.',
  ].filter(Boolean).join('\n')
  fullContent += stopText
  parts.push({ type: 'text', text: stopText })
  if (!webContents.isDestroyed()) {
    webContents.send('ava:llm:chunk', { streamId: args.streamId, text: stopText })
  }
  return {
    fullContent,
    parts,
    model,
    toolCallsIssued,
    loopRounds: loopBudget,
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
  webContents: WebContents,
  args: StreamChatArgs,
): Promise<StreamChatResult> {
  if (!args.providers.length) {
    throw new Error('No enabled LLM provider. Configure one in Settings.')
  }

  const controller = new AbortController()
  activeStreams.set(args.streamId, { controller, aborted: false })

  const attempts: LlmAttempt[] = []

  try {
    const pluginSkills = await pluginManager.skillsForStates(args.pluginStates ?? {})
    const argsWithSkills: StreamChatArgs = {
      ...args,
      messages: injectPluginSkills(args.messages, pluginSkills),
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
