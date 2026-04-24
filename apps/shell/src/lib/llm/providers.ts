import type { ModelProvider, Settings } from '../../types'

export const DEFAULT_MODEL_CHAIN = ['lmstudio', 'openai']

const LM_STUDIO_DEFAULT_MODEL = 'qwen2.5-7b-instruct'
const LM_STUDIO_MODEL_CANDIDATES = [
  LM_STUDIO_DEFAULT_MODEL,
  'qwen2.5-14b-instruct',
  'llama-3.2-3b-instruct',
  'llama-3.1-8b-instruct',
]

export const DEFAULT_MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'local',
    baseUrl: 'http://127.0.0.1:1234',
    apiKey: '',
    enabled: true,
    models: LM_STUDIO_MODEL_CANDIDATES,
    defaultModel: LM_STUDIO_DEFAULT_MODEL,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    enabled: false,
    models: ['llama3'],
    defaultModel: 'llama3',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    type: 'local',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    enabled: false,
    models: ['local-model'],
    defaultModel: 'local-model',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    type: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    enabled: false,
    models: ['local-model'],
    defaultModel: 'local-model',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabled: false,
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'cloud',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    enabled: false,
    models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    defaultModel: 'claude-3-5-sonnet-latest',
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'cloud',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: '',
    enabled: false,
    models: ['llama-3.1-70b-versatile'],
    defaultModel: 'llama-3.1-70b-versatile',
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    type: 'cloud',
    baseUrl: '',
    apiKey: '',
    enabled: false,
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'aggregator',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    enabled: false,
    models: ['openai/gpt-4o-mini'],
    defaultModel: 'openai/gpt-4o-mini',
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    type: 'cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    enabled: false,
    models: ['gemini-2.0-flash'],
    defaultModel: 'gemini-2.0-flash',
  },
]

function sanitizeProvider(provider: ModelProvider): ModelProvider {
  const models = Array.isArray(provider.models)
    ? Array.from(new Set(provider.models.map(m => m.trim()).filter(Boolean)))
    : []
  // Note: do NOT prepend defaultModel to models. `models` is the discovered
  // catalog (from probe or config). The current defaultModel may be a custom
  // alias that isn't in the catalog — UI layer handles that separately.
  const defaultModel = provider.defaultModel?.trim() || models[0] || 'local-model'

  return {
    ...provider,
    id: provider.id.trim(),
    name: provider.name.trim() || provider.id.trim(),
    baseUrl: provider.baseUrl.trim(),
    apiKey: provider.apiKey ?? '',
    enabled: Boolean(provider.enabled),
    models,
    defaultModel,
  }
}

export function mergeModelProviders(overrides?: ModelProvider[] | null): ModelProvider[] {
  const merged = new Map<string, ModelProvider>()

  for (const provider of DEFAULT_MODEL_PROVIDERS) {
    merged.set(provider.id, sanitizeProvider(provider))
  }

  for (const provider of overrides ?? []) {
    if (!provider?.id?.trim()) continue
    const current = merged.get(provider.id)
    merged.set(provider.id, sanitizeProvider({
      ...(current ?? provider),
      ...provider,
    }))
  }

  return Array.from(merged.values())
}

export function normalizeProviderChain(
  chain: string[] | undefined | null,
  providers: ModelProvider[],
): string[] {
  const ids = new Set(providers.map(p => p.id))
  const cleaned = (Array.isArray(chain) ? chain : DEFAULT_MODEL_CHAIN)
    .map(id => id.trim())
    .filter(id => id && ids.has(id))

  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : [...DEFAULT_MODEL_CHAIN]
}

export function getProvider(settings: Settings, id: string): ModelProvider | undefined {
  return settings.modelProviders.find(p => p.id === id)
}

export function getEnabledProviders(
  settings: Settings,
  chain?: string[],
): ModelProvider[] {
  const normalized = normalizeProviderChain(chain ?? settings.primaryModelChain, settings.modelProviders)
  return normalized
    .map(id => getProvider(settings, id))
    .filter((p): p is ModelProvider => Boolean(p?.enabled && p.baseUrl && p.defaultModel))
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

export function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/models$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/models`
  return `${trimmed}/v1/models`
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    modelProviders: mergeModelProviders(),
    primaryModelChain: [...DEFAULT_MODEL_CHAIN],
    persona: {
      userName: 'Jason',
      assistantName: 'Ava',
    },
  }
}
