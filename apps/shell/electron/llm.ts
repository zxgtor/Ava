// ─────────────────────────────────────────────
// Main-process LLM client.
// Runs in Node, so no CORS, no cert issues.
// Exposes: streamChat() → emits chunks to renderer via IPC.
// ─────────────────────────────────────────────

import { WebContents } from 'electron'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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

export interface StreamChatArgs {
  streamId: string
  messages: LlmMessage[]
  providers: ModelProvider[]      // already filtered + ordered by renderer
  temperature?: number
}

export interface StreamChatResult {
  fullContent: string
  provider: ModelProvider
  model: string
  attempts: LlmAttempt[]
  fallbackUsed: boolean
}

// active streams, for cancellation
const activeStreams = new Map<string, AbortController>()

const ANTHROPIC_API_VERSION = '2023-06-01'
const ANTHROPIC_MAX_TOKENS = 4096

// ── URL helpers ─────────────────────────────────────────────────────

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

// ── Leading-whitespace stripper ─────────────────────────────────────

function makeDeltaPusher(onChunk: (text: string) => void) {
  let fullContent = ''
  let seenFirstVisible = false

  // Many chat-tuned models (e.g. Qwen) emit a leading "\n" after the
  // assistant role token because the template already appended one.
  // Strip leading whitespace until the first visible char arrives.
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

// ── OpenAI-compatible SSE ───────────────────────────────────────────

function extractOpenAiDelta(line: string): string | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const json = JSON.parse(payload)
    const delta = json.choices?.[0]?.delta?.content
    if (typeof delta === 'string') return delta
    // Some providers send full message at end (e.g. in streaming-disabled mode)
    const content = json.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    return null
  } catch {
    return null
  }
}

async function streamOpenAiCompat(
  provider: ModelProvider,
  args: StreamChatArgs,
  controller: AbortController,
  onChunk: (text: string) => void,
): Promise<{ fullContent: string; model: string }> {
  const model = provider.defaultModel
  const endpoint = chatCompletionsEndpoint(provider.baseUrl)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: args.messages,
      temperature: args.temperature ?? 0.4,
      stream: true,
    }),
    signal: controller.signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${errorText ? ` — ${errorText.slice(0, 300)}` : ''}`)
  }

  if (!response.body) {
    throw new Error('No response body from provider')
  }

  const pusher = makeDeltaPusher(onChunk)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        const delta = extractOpenAiDelta(line)
        if (delta) pusher.push(delta)
      }
    }
    if (buffer.trim()) {
      const delta = extractOpenAiDelta(buffer.trim())
      if (delta) pusher.push(delta)
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }

  if (!pusher.fullContent.trim()) {
    throw new Error('LLM returned empty content')
  }

  return { fullContent: pusher.fullContent, model }
}

// ── Anthropic /v1/messages ──────────────────────────────────────────

interface AnthropicSseEvent {
  type: string
  [k: string]: unknown
}

function extractAnthropicDelta(jsonLine: string): { delta?: string; error?: string } {
  // Line is `data: {json}`. Non-data lines (event:, id:, retry:, empty) are ignored upstream.
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
  args: StreamChatArgs,
  controller: AbortController,
  onChunk: (text: string) => void,
): Promise<{ fullContent: string; model: string }> {
  const model = provider.defaultModel
  const endpoint = anthropicMessagesEndpoint(provider.baseUrl)

  // Pull system messages out — Anthropic expects `system` as a top-level string.
  const systemParts: string[] = []
  const chat: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of args.messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
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
  if (systemParts.length > 0) {
    body.system = systemParts.join('\n\n')
  }

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
      if (done) break
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

  if (streamError) {
    throw new Error(streamError)
  }
  if (!pusher.fullContent.trim()) {
    throw new Error('LLM returned empty content')
  }

  return { fullContent: pusher.fullContent, model }
}

// ── Dispatcher ──────────────────────────────────────────────────────

function streamFromProvider(
  provider: ModelProvider,
  args: StreamChatArgs,
  controller: AbortController,
  onChunk: (text: string) => void,
): Promise<{ fullContent: string; model: string }> {
  if (provider.id === 'anthropic') {
    return streamAnthropic(provider, args, controller, onChunk)
  }
  return streamOpenAiCompat(provider, args, controller, onChunk)
}

export async function streamChat(
  webContents: WebContents,
  args: StreamChatArgs,
): Promise<StreamChatResult> {
  if (!args.providers.length) {
    throw new Error('No enabled LLM provider. Configure one in Settings.')
  }

  const controller = new AbortController()
  activeStreams.set(args.streamId, controller)

  const attempts: LlmAttempt[] = []

  try {
    for (const provider of args.providers) {
      const model = provider.defaultModel
      try {
        const onChunk = (text: string) => {
          if (!webContents.isDestroyed()) {
            webContents.send('ava:llm:chunk', { streamId: args.streamId, text })
          }
        }
        const { fullContent } = await streamFromProvider(provider, args, controller, onChunk)
        attempts.push({ providerId: provider.id, providerName: provider.name, model, ok: true })

        return {
          fullContent,
          provider,
          model,
          attempts,
          fallbackUsed: attempts.length > 1,
        }
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error('aborted')
        }
        attempts.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
        // notify renderer about fallback attempt failure
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
  const controller = activeStreams.get(streamId)
  if (!controller) return false
  controller.abort()
  activeStreams.delete(streamId)
  return true
}
