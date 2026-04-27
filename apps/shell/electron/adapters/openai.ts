import { 
  LlmMessage, 
  StreamStepResult, 
  ToolCallFormat,
  chatCompletionsEndpoint,
  makeDeltaPusher,
  toOpenAiMessages,
  extractOpenAiPayload,
  applyToolCallDelta,
  normalizeToolCallCandidates,
  extractMessageToolCalls,
  parseHermesToolCalls,
  stripResidualToolMarkup,
  ToolCallAccumulator
} from '../llm'
import { LlmAdapter, AdapterOptions } from './base'

export class OpenAiAdapter extends LlmAdapter {
  async streamChat(options: AdapterOptions): Promise<StreamStepResult> {
    const { provider, args, controller, onChunk } = options
    const model = provider.defaultModel
    const endpoint = chatCompletionsEndpoint(provider.baseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

    const requestBody: Record<string, unknown> = {
      model,
      messages: this.transformMessages(args.messages),
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

  protected transformMessages(messages: LlmMessage[]): any {
    return toOpenAiMessages(messages)
  }
}
