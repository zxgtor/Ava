// ─────────────────────────────────────────────
// Main-process LLM client.
// Runs in Node, so no CORS, no cert issues.
// Exposes: streamChat() → emits text / tool-call parts to renderer via IPC.
// ─────────────────────────────────────────────

import { WebContents } from 'electron'
import { mcpSupervisor, type McpToolDescriptor } from './services/mcpSupervisor'
import { pluginManager, type PluginSkill, type PluginState } from './services/pluginManager'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
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
  temperature?: number
  toolFormatMap?: Record<string, ToolCallFormat>
  pluginStates?: Record<string, PluginState>
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

interface ToolCallCandidate {
  id: string
  name: string
  args: Record<string, unknown>
}

interface ToolCallAccumulator {
  id?: string
  name?: string
  argsText: string
}

interface StreamStepResult {
  visibleText: string
  toolCalls: ToolCallCandidate[]
  model: string
  detectedToolFormat: ToolCallFormat
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

function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

function anthropicMessagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/messages$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function makeDeltaPusher(onChunk: (text: string) => void) {
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
    if (messages[i].role === 'user') return messages[i].content
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

function buildToolPrompt(tools: McpToolDescriptor[]): string {
  const toolLines = tools.map(tool => {
    const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : '{}'
    return `- ${tool.name}: ${tool.description ?? 'No description'} | args schema: ${schema}`
  })
  return [
    'Available tools:',
    ...toolLines,
    'To call a tool, respond with exactly one or more blocks like:',
    '<tool_call>{"name":"filesystem.read_file","arguments":{"path":"D:\\\\example.txt"}}</tool_call>',
    'Do not wrap tool calls in markdown fences.',
  ].join('\n')
}

function toOpenAiMessages(messages: LlmMessage[]) {
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

function parseHermesToolCalls(text: string): { visibleText: string; toolCalls: ToolCallCandidate[] } {
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

function stripResidualToolMarkup(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function=[A-Za-z0-9_.-]+>[\s\S]*?(?:<\/function>)?/g, '')
    .trim()
}

function extractOpenAiPayload(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  return parseJsonObject(payload)
}

function normalizeToolCallCandidates(accs: ToolCallAccumulator[]): ToolCallCandidate[] {
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

function applyToolCallDelta(accs: ToolCallAccumulator[], payload: Record<string, unknown>): boolean {
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

function extractMessageToolCalls(payload: Record<string, unknown>): ToolCallCandidate[] {
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

async function streamOpenAiCompat(
  provider: ModelProvider,
  args: StreamChatArgs & {
    messages: LlmMessage[]
    tools: McpToolDescriptor[]
    toolFormatHint?: ToolCallFormat
  },
  controller: AbortController,
  onChunk: (text: string) => void,
): Promise<StreamStepResult> {
  const model = provider.defaultModel
  const endpoint = chatCompletionsEndpoint(provider.baseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

  const requestBody: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(args.messages),
    temperature: args.temperature ?? 0.4,
    stream: true,
  }
  if (args.tools.length > 0 && args.toolFormatHint !== 'hermes' && args.toolFormatHint !== 'none') {
    requestBody.tools = args.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }))
    requestBody.tool_choice = 'auto'
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${errorText ? ` — ${errorText.slice(0, 300)}` : ''}`)
  }
  if (!response.body) {
    throw new Error('No response body from provider')
  }

  const streamChunks = args.toolFormatHint !== 'hermes'
  const pusher = makeDeltaPusher(streamChunks ? onChunk : () => { /* buffer Hermes text until tool tags are stripped */ })
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const toolAccs: ToolCallAccumulator[] = []
  let finalPayload: Record<string, unknown> | null = null

  const processPayload = (payload: Record<string, unknown>) => {
    finalPayload = payload
    const deltaObj = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined
    const delta = deltaObj?.delta
    if (delta && typeof delta === 'object') {
      const content = (delta as Record<string, unknown>).content
      if (typeof content === 'string') pusher.push(content)
    }
    applyToolCallDelta(toolAccs, payload)
    const messageContent = deltaObj?.message && typeof deltaObj.message === 'object'
      ? (deltaObj.message as Record<string, unknown>).content
      : undefined
    if (typeof messageContent === 'string' && !toolAccs.length && !pusher.fullContent) {
      pusher.push(messageContent)
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        const payload = extractOpenAiPayload(line)
        if (payload) processPayload(payload)
      }
    }
    if (buffer.trim()) {
      const payload = extractOpenAiPayload(buffer.trim())
      if (payload) processPayload(payload)
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }

  let toolCalls = normalizeToolCallCandidates(toolAccs)
  if (toolCalls.length === 0 && finalPayload) {
    toolCalls = extractMessageToolCalls(finalPayload)
  }

  let visibleText = pusher.fullContent
  let detected: ToolCallFormat = toolCalls.length > 0 ? 'openai' : 'none'
  if (toolCalls.length === 0 && args.tools.length > 0) {
    const hermes = parseHermesToolCalls(visibleText)
    if (hermes.toolCalls.length > 0) {
      toolCalls = hermes.toolCalls
      visibleText = hermes.visibleText
      detected = 'hermes'
    }
  }
  visibleText = stripResidualToolMarkup(visibleText)
  if (!streamChunks && visibleText) {
    onChunk(visibleText)
  }

  return { visibleText, toolCalls, model, detectedToolFormat: detected }
}

interface AnthropicSseEvent {
  type: string
  [k: string]: unknown
}

function extractAnthropicDelta(jsonLine: string): { delta?: string; error?: string } {
  try {
    const event = JSON.parse(jsonLine) as AnthropicSseEvent
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return { delta: delta.text }
      }
    }
    if (event.type === 'error') {
      const err = event.error as { message?: string; type?: string } | undefined
      return { error: err?.message || err?.type || 'anthropic stream error' }
    }
    return {}
  } catch {
    return {}
  }
}

async function streamAnthropic(
  provider: ModelProvider,
  args: StreamChatArgs & { messages: LlmMessage[]; tools: McpToolDescriptor[] },
  controller: AbortController,
  onChunk: (text: string) => void,
): Promise<StreamStepResult> {
  const model = provider.defaultModel
  const endpoint = anthropicMessagesEndpoint(provider.baseUrl)

  const systemParts: string[] = []
  const chat: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of args.messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
    } else if (m.role === 'tool') {
      chat.push({ role: 'user', content: `Tool result for ${m.toolCallId ?? 'tool'}:\n${m.content}` })
    } else {
      chat.push({ role: m.role, content: m.content })
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  }
  if (provider.apiKey) headers['x-api-key'] = provider.apiKey

  const body: Record<string, unknown> = {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    temperature: args.temperature ?? 0.4,
    messages: chat,
    stream: true,
  }
  if (systemParts.length > 0) body.system = systemParts.join('\n\n')

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${errorText ? ` — ${errorText.slice(0, 300)}` : ''}`)
  }
  if (!response.body) {
    throw new Error('No response body from Anthropic')
  }

  const pusher = makeDeltaPusher(onChunk)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let streamError: string | null = null

  const processDataLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload) return
    const { delta, error } = extractAnthropicDelta(payload)
    if (error) streamError = error
    else if (delta) pusher.push(delta)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        processDataLine(line)
      }
    }
    if (buffer.trim()) processDataLine(buffer.trim())
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }

  if (streamError) throw new Error(streamError)
  return {
    visibleText: pusher.fullContent,
    toolCalls: [],
    model,
    detectedToolFormat: 'none',
  }
}

function streamFromProvider(
  provider: ModelProvider,
  args: StreamChatArgs & {
    messages: LlmMessage[]
    tools: McpToolDescriptor[]
    toolFormatHint?: ToolCallFormat
  },
  controller: AbortController,
  onChunk: (text: string) => void,
): Promise<StreamStepResult> {
  if (provider.id === 'anthropic') {
    return streamAnthropic(provider, args, controller, onChunk)
  }
  return streamOpenAiCompat(provider, args, controller, onChunk)
}

async function runToolLoop(
  webContents: WebContents,
  provider: ModelProvider,
  args: StreamChatArgs,
  controller: AbortController,
): Promise<Omit<StreamChatResult, 'provider' | 'attempts' | 'fallbackUsed'>> {
  const model = provider.defaultModel
  const tools = mcpSupervisor.listAllTools()
  const initialHint = args.toolFormatMap?.[toolKey(provider.id, model)]
  const effectiveInitialHint: ToolCallFormat | undefined =
    initialHint ?? (provider.id === 'lmstudio' && tools.length > 0 ? 'hermes' : undefined)
  const workingMessages: LlmMessage[] = [...args.messages]
  const currentTask = latestUserRequest(args.messages)
  const parts: StreamChatResult['parts'] = []
  let fullContent = ''
  let detectedToolFormat: ToolCallFormat = initialHint ?? 'none'
  let toolCallsIssued = 0

  for (let round = 0; round < MAX_TOOL_LOOP; round += 1) {
    if (controller.signal.aborted) throw new Error('aborted')

    const stepMessages =
      effectiveInitialHint === 'hermes'
        ? injectHermesToolPrompt(workingMessages, tools)
        : workingMessages

    const step = await streamFromProvider(
      provider,
      {
        ...args,
        messages: stepMessages,
        tools,
        toolFormatHint: detectedToolFormat === 'none' ? effectiveInitialHint : detectedToolFormat,
      },
      controller,
      text => {
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

      const partIndex = parts.length
      const staleReason = validateToolAgainstCurrentTask(toolCall, currentTask)
      const toolPart: ToolCallPart = {
        type: 'tool_call',
        taskId: args.activeTaskId,
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        status: staleReason ? 'error' : 'running',
        startedAt: Date.now(),
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
        const result = await runToolLoop(webContents, provider, argsWithSkills, controller)
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
