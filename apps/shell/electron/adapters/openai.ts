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
  ToolCallAccumulator
} from '../llm'
import { LlmAdapter, AdapterOptions } from './base'

const OPENAI_COMPAT_MAX_TOKENS = 4096

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
    const { provider, args, controller, onChunk } = options
    const model = provider.defaultModel
    const endpoint = chatCompletionsEndpoint(provider.baseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

    const requestBody: Record<string, unknown> = {
      model,
      messages: applyReasoningMode(this.transformMessages(args.messages), provider.reasoningMode),
      temperature: args.temperature ?? 0.4,
      max_tokens: OPENAI_COMPAT_MAX_TOKENS,
      stream: true,
    }
    applyReasoningRequestOptions(requestBody, provider, provider.reasoningMode)

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
    let sawDone = false
    let sawHiddenReasoning = false
    let hiddenReasoningChars = 0
    let hiddenReasoningExceeded = false
    const hiddenReasoningBudgetChars = args.hiddenReasoningBudgetChars ?? 4_000

    const processPayload = (payload: Record<string, unknown>) => {
      finalPayload = payload
      const deltaObj = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined
      const delta = deltaObj?.delta
      if (delta && typeof delta === 'object') {
        const deltaRecord = delta as Record<string, unknown>
        const reasoning = deltaRecord.reasoning_content ?? deltaRecord.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          sawHiddenReasoning = true
          hiddenReasoningChars += reasoning.length
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
    if (!visibleText && sawHiddenReasoning && !hiddenReasoningExceeded) {
      visibleText = '模型只生成了隐藏推理内容，没有返回可显示的最终答案。当前模型 profile 可能只输出 reasoning_content，请换用 chat/instruct profile 或关闭该模型模板的 thinking 输出。'
      if (streamChunks) onChunk(visibleText)
    }
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

    return {
      visibleText,
      toolCalls,
      model,
      detectedToolFormat: detected,
      hiddenReasoningChars,
      hiddenReasoningExceeded,
    }
  }

  protected transformMessages(messages: LlmMessage[]): any {
    return toOpenAiMessages(messages)
  }
}
