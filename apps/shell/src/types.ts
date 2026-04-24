// ── Message / Conversation ──────────────────────────────────────────

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  streaming?: boolean
  error?: string
  aborted?: boolean
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

// ── LLM providers ───────────────────────────────────────────────────

export type ProviderKind = 'local' | 'cloud' | 'aggregator'

export interface ModelProvider {
  id: string
  name: string
  type: ProviderKind
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: string[]
  defaultModel: string
}

// ── Settings ────────────────────────────────────────────────────────

export interface Settings {
  version: number
  modelProviders: ModelProvider[]
  primaryModelChain: string[]
  persona: {
    userName: string
    assistantName: string
  }
}

// ── View mode ───────────────────────────────────────────────────────

export type ViewMode = 'chat' | 'settings'
