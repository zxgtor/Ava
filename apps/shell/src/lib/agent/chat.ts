import type { ContentPart, Conversation, Message, Settings } from '../../types'
import { getEnabledProviders } from '../llm/providers'

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

function buildSystemPrompt(settings: Settings): string {
  return [
    `You are ${settings.persona.assistantName}, a reliable and practical AI assistant.`,
    `The user's name is ${settings.persona.userName}.`,
    'Your primary goal is to help the user successfully complete their task.',
    'Prioritize correctness, clarity, and usefulness over brevity.',
    'Answer in the same language as the user.',
    'If the request is ambiguous or missing important information, ask follow-up questions before proceeding.',
    'Do not guess facts, requirements, or intent when uncertain.',
    'Point out mistakes, missing constraints, and important risks directly.',
    'Be concise for simple tasks, but provide enough detail when detail is needed to help the user succeed.',
    'Task boundary rules:',
    '- Treat the latest user message as the current task.',
    '- If the latest user message gives a new concrete target, path, or scope, it replaces older unfinished requests.',
    '- Do not continue or retry older failed requests unless the user explicitly asks to continue or retry them.',
    '- Before every tool call, verify that the action is necessary for the latest user message, not merely related to older chat history.',
  ].join('\n')
}

function buildCurrentTaskPrompt(latestUserRequest: string): string {
  return [
    'Current task boundary:',
    `Latest user request: ${latestUserRequest}`,
    'Only execute tool calls needed for this latest request.',
    'If an older request failed because of permissions, missing whitelist access, or unavailable tools, do not retry it unless the latest request explicitly asks for that retry.',
    'If the user changed the target path, file, or scope, use only the new target.',
  ].join('\n')
}

function hasFailedToolCall(parts: ContentPart[]): boolean {
  return parts.some(part =>
    part.type === 'tool_call' && (part.status === 'error' || part.status === 'aborted'),
  )
}

function wantsHistoricalContinuation(latestUserRequest: string): boolean {
  return /\b(continue|retry|again|previous|last|same)\b|继续|重试|再试|刚才|上次|之前|同一个/.test(latestUserRequest)
}

function summarizeHistoricalMessage(message: Message, includeUserHistory: boolean): LlmMessage | null {
  if (message.role === 'tool') return null
  const text = partsToText(message.content).trim()
  if (!text) return null
  if (message.role === 'user' && !includeUserHistory) return null
  if (message.role === 'user') {
    return {
      role: 'system',
      content: `Historical user request, not active unless the latest message asks to continue it: ${text.length > 500 ? `${text.slice(0, 500)}...` : text}`,
    }
  }
  if (message.role === 'assistant' && (message.error || message.aborted || hasFailedToolCall(message.content))) {
    return {
      role: 'system',
      content: 'Previous assistant attempt failed or was interrupted. Treat it as historical context only; do not retry its tool calls unless the latest user request explicitly asks to retry.',
    }
  }
  return {
    role: 'system',
    content: `Historical assistant response, not an active task: ${text.length > 800 ? `${text.slice(0, 800)}...` : text}`,
  }
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
}

function conversationToLlmMessages(
  conversation: Conversation,
  settings: Settings,
): LlmMessage[] {
  const latestUserText = [...conversation.messages]
    .reverse()
    .find(m => m.role === 'user')
    ?.content
  const latestUserRequest = latestUserText ? partsToText(latestUserText).trim() : ''
  const includeUserHistory = wantsHistoricalContinuation(latestUserRequest)
  const latestUserIndex = (() => {
    for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
      if (conversation.messages[i].role === 'user') return i
    }
    return -1
  })()

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(settings) },
  ]
  if (latestUserRequest) {
    messages.push({ role: 'system', content: buildCurrentTaskPrompt(latestUserRequest) })
  }
  const historyStart = Math.max(0, latestUserIndex - 6)
  for (let i = historyStart; i < conversation.messages.length; i += 1) {
    const m = conversation.messages[i]
    if (m.role === 'system') continue
    if (i < latestUserIndex) {
      const summarized = summarizeHistoricalMessage(m, includeUserHistory)
      if (summarized) messages.push(summarized)
      continue
    }
    const text = partsToText(m.content)
    if (!text.trim() && !m.streaming) continue
    messages.push({
      role: m.role,
      content: text,
      ...(m.role === 'tool' && m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    })
  }
  return messages
}

export interface SendOptions {
  conversation: Conversation
  settings: Settings
  onDelta: (delta: string) => void
  onAttempt?: (attempts: Array<{ providerId: string; ok: boolean; error?: string }>) => void
  onPart?: (payload: { partIndex: number; part: ContentPart }) => void
  onPartUpdate?: (payload: { partIndex: number; partId?: string; patch: Record<string, unknown> }) => void
  streamId: string
}

export interface SendResult {
  ok: true
  fullContent: string
  providerId: string
  provider: string
  model: string
  fallbackUsed: boolean
  detectedToolFormat: 'openai' | 'hermes' | 'none'
}

export interface SendError {
  ok: false
  error: string
}

export async function sendChat(options: SendOptions): Promise<SendResult | SendError> {
  const providers = getEnabledProviders(options.settings)
  if (providers.length === 0) {
    return {
      ok: false,
      error: 'No enabled LLM provider. Open Settings to configure one.',
    }
  }

  const messages = conversationToLlmMessages(options.conversation, options.settings)

  const offChunk = window.ava.llm.onChunk(({ streamId, text }) => {
    if (streamId === options.streamId) options.onDelta(text)
  })
  const offAttempt = options.onAttempt
    ? window.ava.llm.onAttempt(({ streamId, attempts }) => {
        if (streamId === options.streamId) options.onAttempt!(attempts)
      })
    : () => { /* noop */ }
  const offPart = options.onPart
    ? window.ava.llm.onPart(({ streamId, partIndex, part }) => {
        if (streamId === options.streamId) options.onPart!({ partIndex, part })
      })
    : () => { /* noop */ }
  const offPartUpdate = options.onPartUpdate
    ? window.ava.llm.onPartUpdate(({ streamId, partIndex, partId, patch }) => {
        if (streamId === options.streamId) options.onPartUpdate!({ partIndex, partId, patch })
      })
    : () => { /* noop */ }

  try {
    const reply = await window.ava.llm.stream({
      streamId: options.streamId,
      messages,
      providers,
      temperature: 0.4,
      toolFormatMap: options.settings.modelToolFormatMap,
    })

    if (!reply.ok) {
      return { ok: false, error: reply.error }
    }

    return {
      ok: true,
      fullContent: reply.result.fullContent,
      providerId: reply.result.provider.id,
      provider: reply.result.provider.name,
      model: reply.result.model,
      fallbackUsed: reply.result.fallbackUsed,
      detectedToolFormat: reply.result.detectedToolFormat,
    }
  } finally {
    offChunk()
    offAttempt()
    offPart()
    offPartUpdate()
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
    content: [{ type: 'text', text: content }],
    createdAt: Date.now(),
  }
}

export function makeAssistantPlaceholder(): Message {
  return {
    id: makeMessageId(),
    role: 'assistant',
    content: [],
    createdAt: Date.now(),
    streaming: true,
  }
}
