import type { Conversation, Message, Settings } from '../../types'
import { getEnabledProviders } from '../llm/providers'

// ── System prompt ─────────────────────────────────────────────────

function buildSystemPrompt(settings: Settings): string {
  return [
    `You are ${settings.persona.assistantName}, a concise, honest assistant.`,
    `The user's name is ${settings.persona.userName}.`,
    'Default to terse, direct answers. No filler.',
    'If you do not know something, say so — do not guess.',
    'Answer in the same language the user is using.',
  ].join('\n')
}

// ── LLM message conversion ────────────────────────────────────────

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function conversationToLlmMessages(
  conversation: Conversation,
  settings: Settings,
): LlmMessage[] {
  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(settings) },
  ]
  for (const m of conversation.messages) {
    if (m.role === 'system') continue // internal only
    if (!m.content.trim() && !m.streaming) continue // skip blank errored placeholders
    messages.push({ role: m.role, content: m.content })
  }
  return messages
}

// ── Public API ────────────────────────────────────────────────────

export interface SendOptions {
  conversation: Conversation
  settings: Settings
  onDelta: (delta: string) => void
  onAttempt?: (attempts: Array<{ providerId: string; ok: boolean; error?: string }>) => void
  streamId: string
}

export interface SendResult {
  ok: true
  fullContent: string
  provider: string
  model: string
  fallbackUsed: boolean
}

export interface SendError {
  ok: false
  error: string
}

/**
 * Streams a chat completion for the given conversation.
 * Resolves with full content once the stream ends (or errors).
 */
export async function sendChat(options: SendOptions): Promise<SendResult | SendError> {
  const providers = getEnabledProviders(options.settings)
  if (providers.length === 0) {
    return {
      ok: false,
      error: 'No enabled LLM provider. Open Settings to configure one.',
    }
  }

  const messages = conversationToLlmMessages(options.conversation, options.settings)

  // subscribe to streaming chunks for this streamId only
  const offChunk = window.ava.llm.onChunk(({ streamId, text }) => {
    if (streamId === options.streamId) options.onDelta(text)
  })
  const offAttempt = options.onAttempt
    ? window.ava.llm.onAttempt(({ streamId, attempts }) => {
        if (streamId === options.streamId) options.onAttempt!(attempts)
      })
    : () => { /* noop */ }

  try {
    const reply = await window.ava.llm.stream({
      streamId: options.streamId,
      messages,
      providers,
      temperature: 0.4,
    })

    if (!reply.ok) {
      return { ok: false, error: reply.error }
    }

    return {
      ok: true,
      fullContent: reply.result.fullContent,
      provider: reply.result.provider.name,
      model: reply.result.model,
      fallbackUsed: reply.result.fallbackUsed,
    }
  } finally {
    offChunk()
    offAttempt()
  }
}

export function makeStreamId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function makeMessageId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function makeUserMessage(content: string): Message {
  return {
    id: makeMessageId(),
    role: 'user',
    content,
    createdAt: Date.now(),
  }
}

export function makeAssistantPlaceholder(): Message {
  return {
    id: makeMessageId(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    streaming: true,
  }
}
