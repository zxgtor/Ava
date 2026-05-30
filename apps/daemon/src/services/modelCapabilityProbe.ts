type CapabilityValue = 'yes' | 'no' | 'unknown'
type CapabilityToolFormat = 'openai' | 'hermes' | 'json' | 'none' | 'unknown'

export interface ModelCapabilityProfile {
  model: string
  providerId: string
  vision: CapabilityValue
  tools: CapabilityValue
  thinking: CapabilityValue
  toolFormat: CapabilityToolFormat
  source: 'probe' | 'heuristic'
  checkedAt: number
  error?: string
}

export interface ProbeModelProvider {
  id: string
  name: string
  type?: 'local' | 'cloud' | 'aggregator'
  baseUrl: string
  apiKey: string
  defaultModel?: string
}

function inferModelCapabilities(providerId: string, model: string): ModelCapabilityProfile {
  const id = `${providerId} ${model}`.toLowerCase()
  const hasVision = /\b(vision|vl|vlm|gpt-4o|o4|gemini|pixtral|llava|qwen2\.5-vl|qwen-vl|omni)\b/i.test(id)
  const hasThinking = /\b(reason|thinking|think|qwen3|deepseek-r1|r1|o1|o3|o4|qwq)\b/i.test(id)
  return {
    model,
    providerId,
    vision: hasVision ? 'yes' : 'unknown',
    tools: 'unknown',
    thinking: hasThinking ? 'yes' : 'unknown',
    toolFormat: 'unknown',
    source: 'heuristic',
    checkedAt: Date.now(),
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/models$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/models`
  return `${trimmed}/v1/models`
}

function providerHeaders(provider: { id: string; apiKey: string }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.id === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
  }
  return headers
}

function detectToolFormatFromProbe(json: unknown): { tools: CapabilityValue; toolFormat: CapabilityToolFormat; thinking: CapabilityValue } {
  const raw = JSON.stringify(json ?? {})
  const parsed = json as {
    choices?: Array<{
      message?: {
        content?: string
        reasoning_content?: string
        reasoning?: string
        tool_calls?: unknown[]
      }
      delta?: {
        reasoning_content?: string
        reasoning?: string
        tool_calls?: unknown[]
      }
    }>
  }
  const choice = parsed.choices?.[0]
  const message = choice?.message
  const content = typeof message?.content === 'string' ? message.content : ''
  const hasNativeTool = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
  const hasThinking = Boolean(message?.reasoning_content || message?.reasoning || choice?.delta?.reasoning_content || choice?.delta?.reasoning || /reasoning_content/i.test(raw))
  if (hasNativeTool) return { tools: 'yes', toolFormat: 'openai', thinking: hasThinking ? 'yes' : 'unknown' }
  if (/<tool_call>[\s\S]*?<\/tool_call>/i.test(content)) return { tools: 'yes', toolFormat: 'hermes', thinking: hasThinking ? 'yes' : 'unknown' }
  if (/```(?:json)?\s*[\s\S]*?"name"\s*:\s*"ava_capability_probe"/i.test(content) || /^\s*\{[\s\S]*"name"\s*:\s*"ava_capability_probe"/i.test(content)) {
    return { tools: 'yes', toolFormat: 'json', thinking: hasThinking ? 'yes' : 'unknown' }
  }
  return { tools: 'no', toolFormat: 'none', thinking: hasThinking ? 'yes' : 'unknown' }
}

export async function probeModels(args: { baseUrl: string; apiKey: string; providerId?: string }): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(modelsUrl(args.baseUrl), {
      headers: providerHeaders({ id: args.providerId ?? '', apiKey: args.apiKey }),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = await res.json() as { data?: Array<{ id?: string; created?: number; created_at?: string }> }
    const models = Array.isArray(json.data)
      ? json.data
          .filter((model): model is { id: string; created?: number; created_at?: string } => typeof model?.id === 'string')
          .map((model, idx) => {
            const ts = typeof model.created === 'number'
              ? model.created * 1000
              : typeof model.created_at === 'string'
                ? Date.parse(model.created_at)
                : NaN
            return { id: model.id, ts: Number.isFinite(ts) ? ts : -1, idx }
          })
          .sort((a, b) => a.ts !== b.ts ? b.ts - a.ts : a.idx - b.idx)
          .map(model => model.id)
      : []
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function probeModelCapabilities(args: {
  provider: ProbeModelProvider
  model: string
}): Promise<{ ok: true; profile: ModelCapabilityProfile } | { ok: false; profile: ModelCapabilityProfile; error: string }> {
  const model = args.model || args.provider.defaultModel || ''
  const inferred = inferModelCapabilities(args.provider.id, model)
  if (!args.provider.baseUrl || !model) {
    const error = 'Missing baseUrl or model.'
    return { ok: false, profile: { ...inferred, error }, error }
  }
  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: 'You are a tool capability probe. If tools are available, call ava_capability_probe exactly once. Do not explain.' },
        { role: 'user', content: 'Call the provided tool now.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'ava_capability_probe',
          description: 'Capability probe for Ava.',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'string' } },
            required: ['ok'],
          },
        },
      }],
      tool_choice: 'auto',
      max_tokens: 96,
      temperature: 0,
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
    }
    const res = await fetch(chatCompletionsUrl(args.provider.baseUrl), {
      method: 'POST',
      headers: providerHeaders(args.provider),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const error = `HTTP ${res.status}`
      return { ok: false, profile: { ...inferred, error }, error }
    }
    const detected = detectToolFormatFromProbe(await res.json() as unknown)
    return {
      ok: true,
      profile: {
        ...inferred,
        tools: detected.tools,
        toolFormat: detected.toolFormat,
        thinking: detected.thinking === 'unknown' ? inferred.thinking : detected.thinking,
        source: 'probe',
        checkedAt: Date.now(),
      },
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ok: false, profile: { ...inferred, error }, error }
  }
}
