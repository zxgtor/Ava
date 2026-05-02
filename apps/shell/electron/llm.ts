// ─────────────────────────────────────────────
// Main-process LLM client.
// Runs in Node, so no CORS, no cert issues.
// Exposes: streamChat() → emits text / tool-call parts to renderer via IPC.
// ─────────────────────────────────────────────

import { WebContents } from 'electron'
import { mcpSupervisor, type McpToolDescriptor } from './services/mcpSupervisor'
import { pluginManager, type PluginSkill, type PluginState } from './services/pluginManager'
import { previewValue, toolAuditLog, type ToolAuditCommandInvocation } from './services/toolAuditLog'
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
  activeCommandInvocation?: ToolAuditCommandInvocation
  temperature?: number
  toolFormatMap?: Record<string, ToolCallFormat>
  pluginStates?: Record<string, PluginState>
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
const MAX_TOOL_LOOP = 10
const WINDOWS_PATH_RE = /[A-Za-z]:\\[^\s"'`<>|?*，。；：、]+/g
const WINDOWS_DRIVE_SCOPE_RE = /\b[A-Za-z]:\\?(?![^\s"'`<>|?*])/g
const TOOL_INTENT_RE =
  /\b(read|open|inspect|check|list|search|find|scan|write|create|edit|modify|delete|run|execute|call|use tool|tool call)\b|读取|打开|检查|查看|列出|搜索|查找|扫描|写入|创建|编辑|修改|删除|运行|执行|调用工具|使用工具/i
const REASONING_INTENT_RE =
  /\b(debug|diagnose|trace|root cause|why|architecture|architect|design|plan|strategy|refactor|migrate|compare|tradeoff|risk|review|analyze|complex|investigate|fix|implement)\b|为什么|原因|诊断|排查|调试|架构|设计|计划|方案|重构|迁移|比较|权衡|风险|审查|分析|复杂|调查|修复|实现/i
const SIMPLE_CHAT_RE =
  /\b(what is|how to|do you know|explain|summarize|translate|tell me|can this|does this|support)\b|是什么|怎么|如何|解释|总结|翻译|支持吗|知道/i

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

function shouldExposeTools(currentTask: string, activeCommandInvocation?: ToolAuditCommandInvocation): boolean {
  if (activeCommandInvocation) return true
  if (extractPathScopes(currentTask).length > 0) return true
  return TOOL_INTENT_RE.test(currentTask)
}

function chooseReasoningMode(
  provider: ModelProvider,
  currentTask: string,
  toolsExposed: boolean,
): 'off' | 'on' {
  if (provider.reasoningMode === 'off') return 'off'
  if (provider.reasoningMode === 'on') return 'on'
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

export function buildToolPrompt(tools: McpToolDescriptor[]): string {
  const toolLines = tools.map(tool => {
    const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : '{}'
    return `- ${tool.name}: ${tool.description ?? 'No description'} | args schema: ${schema}`
  })
  const exampleTool = tools.find(tool => tool.name === 'filesystem.read_text_file')
    ?? tools.find(tool => tool.name.startsWith('filesystem.') && /read/i.test(tool.name))
    ?? tools[0]
  const exampleName = exampleTool?.name ?? 'filesystem.read_text_file'
  return [
    'Available tools:',
    ...toolLines,
    'Only call a tool when the latest user request requires external state, filesystem access, or an explicit action.',
    'For conceptual questions, instructions, or explanations, answer directly without a tool call.',
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

export function parseHermesToolCalls(text: string): { visibleText: string; toolCalls: ToolCallCandidate[] } {
  const toolCalls: ToolCallCandidate[] = []
  const toolCallBlockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  const visibleText = text.replace(toolCallBlockRe, (_match, body) => {
    const parsed = parseJsonObject(body)
    if (parsed) {
      const name = typeof parsed.name === 'string' ? parsed.name : null
      const argsSource = parsed.arguments ?? parsed.args
      const args = argsSource && typeof argsSource === 'object' ? argsSource as Record<string, unknown> : {}
      if (name) {
        toolCalls.push({
          id: `hermes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          args,
        })
      }
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
): Promise<StreamStepResult> {
  const adapter = getAdapter(provider.id)
  return adapter.streamChat({
    provider,
    args,
    controller,
    onChunk,
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
  const tools = shouldExposeTools(currentTask, args.activeCommandInvocation)
    ? mcpSupervisor.listAllTools()
    : []
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
  const workingMessages: LlmMessage[] = [...args.messages]
  const parts: StreamChatResult['parts'] = []
  let fullContent = ''
  let detectedToolFormat: ToolCallFormat = initialHint ?? 'none'
  let toolCallsIssued = 0
  let sawFirstToken = false

  for (let round = 0; round < MAX_TOOL_LOOP; round += 1) {
    if (controller.signal.aborted) throw new Error('aborted')
    sendRunStatus(webContents, args, provider, model, round === 0 ? 'waiting_first_token' : 'generating')

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
        if (!webContents.isDestroyed()) {
          webContents.send('ava:llm:chunk', { streamId: args.streamId, text })
        }
      },
    )

    if (step.detectedToolFormat !== 'none') {
      detectedToolFormat = step.detectedToolFormat
    } else if (!effectiveInitialHint) {
      detectedToolFormat = 'none'
    }

    if (step.visibleText) {
      fullContent += step.visibleText
      parts.push({ type: 'text', text: step.visibleText })
    }

    if (step.hiddenReasoningExceeded && !step.visibleText && step.toolCalls.length === 0) {
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
      const failText = '模型超过 hidden reasoning 预算后仍没有返回可显示的最终答案。当前模型 profile 可能只输出 reasoning_content，请换用 chat/instruct profile 或关闭该模型模板的 thinking 输出。'
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

    if (step.toolCalls.length === 0) {
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
      }
    }

    toolCallsIssued += step.toolCalls.length
    workingMessages.push({
      role: 'assistant',
      content: step.visibleText,
      toolCalls: step.toolCalls,
    })
    for (const toolCall of step.toolCalls) {
      if (controller.signal.aborted) throw new Error('aborted')
      sendRunStatus(webContents, args, provider, model, 'tool_running')

      const partIndex = parts.length
      const staleReason = validateToolAgainstCurrentTask(toolCall, currentTask)
      const resolvedTool = mcpSupervisor.resolveTool(toolCall.name)
      const serverRuntime = resolvedTool ? mcpSupervisor.getServer(resolvedTool.serverId) : null
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

      const result = await mcpSupervisor.callTool({
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
    }
    sendRunStatus(webContents, args, provider, model, 'generating')
  }

  const stopText = 'Tool loop exceeded, stopping.'
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
    loopRounds: MAX_TOOL_LOOP,
    detectedToolFormat,
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
  mcpSupervisor.abortAllCalls()
  activeStreams.delete(streamId)
  return true
}
