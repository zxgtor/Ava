import { 
  LlmMessage, 
  StreamStepResult, 
  ToolCallFormat,
  chatCompletionsEndpoint,
  makeDeltaPusher,
  toOpenAiMessages,
  extractOpenAiPayload,
  isOpenAiDoneLine,
  applyToolCallDelta,
  normalizeToolCallCandidates,
  extractMessageToolCalls,
  parseHermesToolCalls,
  stripResidualToolMarkup,
  hasUnterminatedToolCallMarkup,
  ToolCallAccumulator
} from '../llm'
import { LlmAdapter, AdapterOptions } from './base'

const OPENAI_COMPAT_MAX_TOKENS = 4096

// OpenAI tool/function names must match ^[a-zA-Z0-9_-]+$ (no dots). Newer
// LM Studio builds enforce this server-side and silently drop the response
// body (HTTP 200, 0 bytes) when validation fails. Map dots to underscores on
// the wire and reverse on the way back so Ava's dotted tool names round-trip.
const sanitizeToolName = (name: string): string => name.replace(/\./g, '_')
function buildToolNameMaps(toolNames: string[]): { forward: Map<string, string>; inverse: Map<string, string> } {
  const forward = new Map<string, string>()
  const inverse = new Map<string, string>()
  for (const original of toolNames) {
    const safe = sanitizeToolName(original)
    forward.set(original, safe)
    inverse.set(safe, original)
  }
  return { forward, inverse }
}
// LM Studio (and many OpenAI-compatible servers) silently reject requests
// with `system` messages that appear after the first user/assistant turn —
// the server returns HTTP 200 but closes the body with 0 bytes. Ava's retry
// and finalize prompts inject mid-conversation system messages, so we
// re-tag them as `user` notes here. The leading system block (everything
// before the first non-system message) is preserved as-is.
function normalizeMidConversationSystem(messages: any[]): any[] {
  if (messages.length === 0) return messages

  // Step 1: collapse the leading system block into a single message. Strict
  // chat templates (e.g. qwen3.6-35b-a3b's Jinja) only treat the first system
  // message as system context; multiple back-to-back system messages can
  // break their "find user query" logic and yield "No user query found in
  // messages" errors.
  let leadingSystemEnd = 0
  while (leadingSystemEnd < messages.length && messages[leadingSystemEnd]?.role === 'system') {
    leadingSystemEnd += 1
  }
  const merged: any[] = []
  if (leadingSystemEnd > 0) {
    const combined = messages
      .slice(0, leadingSystemEnd)
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n')
    merged.push({ role: 'system', content: combined })
  }

  // Step 2: any system message that appears after the leading block becomes
  // a `[system note]` user message so the role sequence stays valid.
  for (let i = leadingSystemEnd; i < messages.length; i += 1) {
    const m = messages[i]
    if (m?.role === 'system' && typeof m.content === 'string') {
      merged.push({ role: 'user', content: `[system note]\n${m.content}` })
    } else {
      merged.push(m)
    }
  }

  return merged
}

function rewriteOutgoingToolNames(messages: any[], forward: Map<string, string>): any[] {
  if (forward.size === 0) return messages
  return messages.map(m => {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc: any) => {
          const fn = tc?.function
          if (!fn || typeof fn.name !== 'string') return tc
          const mapped = forward.get(fn.name) ?? sanitizeToolName(fn.name)
          if (mapped === fn.name) return tc
          return { ...tc, function: { ...fn, name: mapped } }
        }),
      }
    }
    return m
  })
}

function applyReasoningMode(messages: any[], reasoningMode?: 'auto' | 'off' | 'on'): any[] {
  if (reasoningMode !== 'off') return messages
  const directInstruction = [
    'Reasoning mode is off for this request.',
    'Do not generate hidden reasoning, chain-of-thought, or thinking blocks.',
    'Return the final answer directly in visible content.',
  ].join(' ')
  const next = [...messages]
  if (next[0]?.role === 'system' && typeof next[0].content === 'string') {
    next[0] = { ...next[0], content: `${next[0].content}\n\n${directInstruction}` }
  } else {
    next.unshift({ role: 'system', content: directInstruction })
  }
  return next
}

function applyReasoningRequestOptions(
  requestBody: Record<string, unknown>,
  provider: { id: string; type: string },
  reasoningMode?: 'auto' | 'off' | 'on',
): void {
  if (provider.type !== 'local') return
  if (reasoningMode === 'off') {
    // OpenAI-compatible local servers use non-standard knobs. Unknown fields
    // are ignored by most local runtimes, but supported runtimes can disable
    // thinking before the model spends tokens in reasoning_content.
    requestBody.reasoning_effort = 'none'
    requestBody.enable_thinking = false
    requestBody.chat_template_kwargs = { enable_thinking: false }
    return
  }
  if (reasoningMode === 'on') {
    requestBody.enable_thinking = true
    requestBody.chat_template_kwargs = { enable_thinking: true }
  }
}

export class OpenAiAdapter extends LlmAdapter {
  async streamChat(options: AdapterOptions): Promise<StreamStepResult> {
    const { provider, args, controller, onChunk, onReasoningChunk } = options
    const model = provider.defaultModel
    const endpoint = chatCompletionsEndpoint(provider.baseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

    const { forward: nameForward, inverse: nameInverse } = buildToolNameMaps(args.tools.map(t => t.name))

    const requestBody: Record<string, unknown> = {
      model,
      messages: normalizeMidConversationSystem(
        rewriteOutgoingToolNames(
          applyReasoningMode(this.transformMessages(args.messages), provider.reasoningMode),
          nameForward,
        ),
      ),
      temperature: args.temperature ?? 0.4,
      max_tokens: OPENAI_COMPAT_MAX_TOKENS,
      stream: true,
    }
    applyReasoningRequestOptions(requestBody, provider, provider.reasoningMode)

    if (args.tools.length > 0 && args.toolFormatHint !== 'hermes' && args.toolFormatHint !== 'none') {
      requestBody.tools = args.tools.map(tool => ({
        type: 'function',
        function: {
          name: nameForward.get(tool.name) ?? sanitizeToolName(tool.name),
          description: tool.description ?? '',
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      }))
      requestBody.tool_choice = 'auto'
    }

    const requestBodyJson = JSON.stringify(requestBody)
    const reqStart = Date.now()
    const sentToolNames = Array.isArray(requestBody.tools)
      ? (requestBody.tools as Array<{ function?: { name?: string } }>).map(t => t.function?.name ?? '?')
      : []
    const messageShape = Array.isArray(requestBody.messages)
      ? (requestBody.messages as Array<Record<string, any>>).map(m => {
          const role = m.role
          const tcNames = Array.isArray(m.tool_calls)
            ? m.tool_calls.map((tc: any) => tc?.function?.name).filter(Boolean)
            : []
          const contentLen = typeof m.content === 'string' ? m.content.length : 0
          return tcNames.length > 0
            ? `${role}[tc:${tcNames.join(',')}]`
            : role === 'tool'
              ? `tool(${m.tool_call_id ?? '?'})=${contentLen}c`
              : `${role}=${contentLen}c`
        })
      : []
    console.warn('[ava-debug] openai-adapter request', {
      endpoint,
      provider: provider.id,
      model,
      bodyBytes: requestBodyJson.length,
      messageCount: Array.isArray(requestBody.messages) ? (requestBody.messages as unknown[]).length : 0,
      toolCount: Array.isArray(requestBody.tools) ? (requestBody.tools as unknown[]).length : 0,
      sentToolNames,
      messageShape,
      reasoningMode: provider.reasoningMode,
      enable_thinking: requestBody.enable_thinking,
    })
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: requestBodyJson,
      signal: controller.signal,
    })
    console.warn('[ava-debug] openai-adapter response', {
      status: response.status,
      ok: response.ok,
      ttfbMs: Date.now() - reqStart,
      hasBody: !!response.body,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      console.warn('[ava-debug] openai-adapter http error body', errorText.slice(0, 600))
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
    let sawDone = false
    let sawHiddenReasoning = false
    let hiddenReasoningChars = 0
    let hiddenReasoningExceeded = false
    let finishReason: string | undefined
    const hiddenReasoningBudgetChars = args.hiddenReasoningBudgetChars ?? 4_000

    const processPayload = (payload: Record<string, unknown>) => {
      finalPayload = payload
      const deltaObj = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined
      if (typeof deltaObj?.finish_reason === 'string') {
        finishReason = deltaObj.finish_reason
      }
      const delta = deltaObj?.delta
      if (delta && typeof delta === 'object') {
        const deltaRecord = delta as Record<string, unknown>
        const reasoning = deltaRecord.reasoning_content ?? deltaRecord.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          sawHiddenReasoning = true
          hiddenReasoningChars += reasoning.length
          if (onReasoningChunk) onReasoningChunk(reasoning)
        }
        const content = deltaRecord.content
        if (typeof content === 'string') pusher.push(content)
      }
      applyToolCallDelta(toolAccs, payload)
      const messageContent = deltaObj?.message && typeof deltaObj.message === 'object'
        ? (deltaObj.message as Record<string, unknown>).content
        : undefined
      const messageReasoning = deltaObj?.message && typeof deltaObj.message === 'object'
        ? ((deltaObj.message as Record<string, unknown>).reasoning_content ?? (deltaObj.message as Record<string, unknown>).reasoning)
        : undefined
      if (typeof messageReasoning === 'string' && messageReasoning.length > 0) {
        sawHiddenReasoning = true
        hiddenReasoningChars += messageReasoning.length
      }
      if (typeof messageContent === 'string' && !toolAccs.length && !pusher.fullContent) {
        pusher.push(messageContent)
      }
      if (
        sawHiddenReasoning &&
        !pusher.fullContent &&
        hiddenReasoningChars > hiddenReasoningBudgetChars
      ) {
        hiddenReasoningExceeded = true
        sawDone = true
      }
    }

    const processLine = (line: string) => {
      if (isOpenAiDoneLine(line)) {
        sawDone = true
        return
      }
      const payload = extractOpenAiPayload(line)
      if (payload) processPayload(payload)
    }

    try {
      while (!sawDone) {
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
          processLine(line)
          if (sawDone) break
        }
      }
      if (!sawDone && buffer.trim()) {
        processLine(buffer.trim())
      }
    } finally {
      if (sawDone) {
        try { await reader.cancel() } catch { /* noop */ }
      }
      try { reader.releaseLock() } catch { /* noop */ }
    }

    let toolCalls = normalizeToolCallCandidates(toolAccs)
    if (toolCalls.length === 0 && finalPayload) {
      toolCalls = extractMessageToolCalls(finalPayload)
    }

    let visibleText = pusher.fullContent
    if (!visibleText && sawHiddenReasoning && toolCalls.length === 0) {
      // Model produced only reasoning_content with no visible content and no
      // tool call. Signal hiddenReasoningExceeded so runToolLoop's bail-out
      // path runs — it caches a "reasoning-broken" flag for this model so
      // future calls auto-disable reasoning, and emits a single bilingual
      // user-facing diagnostic. Substituting a chat message here would
      // bypass that recovery and the user would loop on the same failure.
      hiddenReasoningExceeded = true
    }
    let detected: ToolCallFormat = toolCalls.length > 0 ? 'openai' : 'none'
    const truncatedHermesToolCall =
      args.tools.length > 0 &&
      (finishReason === 'length' || finishReason === 'max_tokens') &&
      hasUnterminatedToolCallMarkup(visibleText)
    if (truncatedHermesToolCall) {
      toolCalls = []
      detected = 'hermes'
      finishReason = 'tool_call_truncated'
    } else if (toolCalls.length === 0 && args.tools.length > 0) {
      const hermes = parseHermesToolCalls(visibleText)
      if (hermes.toolCalls.length > 0) {
        toolCalls = hermes.toolCalls
        visibleText = hermes.visibleText
        detected = 'hermes'
      }
    }
    // Unsanitize tool names from BOTH paths (native + hermes).
    //
    // Primary path: nameInverse map built from this request's tools[]. That
    // covers tools the engine actually exposed for this step.
    //
    // Fallback path: the model sometimes emits a sanitized name (e.g.
    // `file_patch`, `shell_run_command`) for a tool NOT in the current
    // step's required-tool set — so it isn't in nameInverse and lookup
    // misses. Ava's built-in tool names follow `<category>.<snake_name>`
    // (e.g. `file.list_dir`, `shell.run_command`), so converting the FIRST
    // underscore to a dot recovers the canonical name with no ambiguity.
    // Without this, dispatch silently fails (call stays "running"),
    // step.requiredTools never matches, and the loop wastes attempts.
    if (toolCalls.length > 0) {
      toolCalls = toolCalls.map(tc => {
        const fromInverse = nameInverse.get(tc.name)
        if (fromInverse) return { ...tc, name: fromInverse }
        // Heuristic recovery for tools not exposed to this step.
        if (tc.name.includes('_') && !tc.name.includes('.')) {
          const guess = tc.name.replace('_', '.')
          return { ...tc, name: guess }
        }
        return tc
      })
      console.warn('[ava-debug] tool names after unsanitize', { detected, names: toolCalls.map(tc => tc.name) })
    }
    visibleText = stripResidualToolMarkup(visibleText)
    if (!streamChunks && visibleText) {
      onChunk(visibleText)
    }
    if (!sawDone && !finishReason) {
      finishReason = 'stream_disconnected'
    }
    console.warn('[ava-debug] openai-adapter stream end', {
      sawDone,
      finishReason,
      visibleLen: visibleText.length,
      toolCalls: toolCalls.length,
      hiddenReasoningChars,
      hiddenReasoningExceeded,
      bufferTail: buffer.slice(-200),
      durationMs: Date.now() - reqStart,
    })
    if (toolCalls.length === 0 && visibleText.length > 0) {
      console.warn('[ava-debug] visibleText sample (head)', visibleText.slice(0, 500))
      console.warn('[ava-debug] visibleText sample (tail)', visibleText.slice(-500))
    }

    return {
      visibleText,
      toolCalls,
      model,
      detectedToolFormat: detected,
      finishReason,
      hiddenReasoningChars,
      hiddenReasoningExceeded,
    }
  }

  protected transformMessages(messages: LlmMessage[]): any {
    return toOpenAiMessages(messages)
  }
}
