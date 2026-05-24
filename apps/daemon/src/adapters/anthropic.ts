import { 
  LlmMessage, 
  StreamStepResult, 
  ToolCallFormat,
  anthropicMessagesEndpoint,
  makeDeltaPusher,
  ToolCallCandidate,
  LlmMessagePart
} from '../llm'
import { LlmAdapter, AdapterOptions } from './base'

const ANTHROPIC_API_VERSION = '2023-06-01'
const ANTHROPIC_MAX_TOKENS = 4096

export class AnthropicAdapter extends LlmAdapter {
  async streamChat(options: AdapterOptions): Promise<StreamStepResult> {
    const { provider, args, controller, onChunk } = options
    const model = provider.defaultModel
    const endpoint = anthropicMessagesEndpoint(provider.baseUrl)

    const { system, messages } = this.transformMessages(args.messages)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
    }
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey

    const body: Record<string, unknown> = {
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      temperature: args.temperature ?? 0.4,
      messages,
      stream: true,
    }
    if (system) body.system = system

    if (args.tools.length > 0) {
      body.tools = args.tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
      }))
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
      throw new Error('No response body from provider')
    }

    const pusher = makeDeltaPusher(onChunk)
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    
    const toolCalls: ToolCallCandidate[] = []
    let currentToolCall: { id: string; name: string; argsText: string } | null = null

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          
          const jsonStr = trimmed.slice(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') continue

          try {
            const event = JSON.parse(jsonStr)
            switch (event.type) {
              case 'content_block_delta':
                if (event.delta?.type === 'text_delta') {
                  pusher.push(event.delta.text)
                } else if (event.delta?.type === 'input_json_delta') {
                  if (currentToolCall) {
                    currentToolCall.argsText += event.delta.partial_json
                  }
                }
                break
              case 'content_block_start':
                if (event.content_block?.type === 'tool_use') {
                  currentToolCall = {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    argsText: '',
                  }
                }
                break
              case 'content_block_stop':
                if (currentToolCall) {
                  try {
                    toolCalls.push({
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      args: JSON.parse(currentToolCall.argsText || '{}'),
                    })
                  } catch (e) {
                    console.warn('[AnthropicAdapter] Failed to parse tool args:', e)
                  }
                  currentToolCall = null
                }
                break
              case 'error':
                throw new Error(event.error?.message || 'Anthropic stream error')
            }
          } catch (e) {
            if (e instanceof Error && e.message === 'aborted') throw e
            // console.warn('[AnthropicAdapter] JSON parse error:', e)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    return {
      visibleText: pusher.fullContent,
      toolCalls,
      model,
      detectedToolFormat: toolCalls.length > 0 ? 'openai' : 'none', // We treat native as 'openai' equivalent for the loop
    }
  }

  protected transformMessages(messages: LlmMessage[]): { system?: string; messages: any[] } {
    const systemParts: string[] = []
    const anthropicMessages: any[] = []

    for (const m of messages) {
      if (m.role === 'system') {
        if (typeof m.content === 'string' && m.content) {
          systemParts.push(m.content)
        }
      } else if (m.role === 'tool') {
        // Native tool result
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            }
          ]
        })
      } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // Native tool use from history
        const content: any[] = []
        if (typeof m.content === 'string' && m.content.trim()) {
          content.push({ type: 'text', text: m.content })
        }
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args,
          })
        }
        anthropicMessages.push({ role: 'assistant', content })
      } else {
        // Standard text or image
        if (typeof m.content === 'string') {
          anthropicMessages.push({ role: m.role, content: m.content })
        } else {
          const parts = m.content.map(p => {
            if (p.type === 'text') return { type: 'text', text: p.text }
            if (p.type === 'image_url') {
              const match = p.image_url.url.match(/^data:(image\/[a-zA-Z+]+);base64,(.*)$/)
              if (match) {
                return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
              }
            }
            return null
          }).filter(Boolean)
          anthropicMessages.push({ role: m.role, content: parts })
        }
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      messages: anthropicMessages,
    }
  }
}
