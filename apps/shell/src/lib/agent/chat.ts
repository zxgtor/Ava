import type { AssistantRunPhase, CommandInvocation, ContentPart, Conversation, Message, Settings } from '../../types'
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
    'Do not spend tokens on hidden reasoning. Provide the final answer directly.',
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

function buildCurrentTaskPrompt(latestUserRequest: string, taskId?: string): string {
  return [
    'Current task boundary:',
    taskId ? `Active task id: ${taskId}` : '',
    `Latest user request: ${latestUserRequest}`,
    'Only execute tool calls needed for this latest request.',
    'Only tool-call events for the active task id belong to the current assistant response.',
    'If an older request failed because of permissions, missing whitelist access, or unavailable tools, do not retry it unless the latest request explicitly asks for that retry.',
    'If the user changed the target path, file, or scope, use only the new target.',
  ].filter(Boolean).join('\n')
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
  const taskPrefix = message.taskId ? `Historical task ${message.taskId}. ` : ''
  if (message.role === 'user' && !includeUserHistory) return null
  if (message.role === 'user') {
    return {
      role: 'system',
      taskId: message.taskId,
      content: `${taskPrefix}Historical user request, not active unless the latest message asks to continue it: ${text.length > 500 ? `${text.slice(0, 500)}...` : text}`,
    }
  }
  if (message.role === 'assistant' && (message.error || message.aborted || hasFailedToolCall(message.content))) {
    return {
      role: 'system',
      taskId: message.taskId,
      content: `${taskPrefix}Previous assistant attempt failed or was interrupted. Treat it as historical context only; do not retry its tool calls unless the latest user request explicitly asks to retry.`,
    }
  }
  return {
    role: 'system',
    taskId: message.taskId,
    content: `${taskPrefix}Historical assistant response, not an active task: ${text.length > 800 ? `${text.slice(0, 800)}...` : text}`,
  }
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  taskId?: string
  toolCallId?: string
}

function conversationToLlmMessages(
  conversation: Conversation,
  settings: Settings,
): LlmMessage[] {
  const latestUserIndex = (() => {
    for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
      if (conversation.messages[i].role === 'user') return i
    }
    return -1
  })()
  const latestUser = latestUserIndex >= 0 ? conversation.messages[latestUserIndex] : null
  const activeTaskId = latestUser?.taskId
  const latestUserRequest = latestUser ? partsToText(latestUser.content).trim() : ''
  const includeUserHistory = wantsHistoricalContinuation(latestUserRequest)

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(settings) },
  ]
  if (latestUserRequest) {
    messages.push({ role: 'system', content: buildCurrentTaskPrompt(latestUserRequest, activeTaskId) })
  }
  const historyStart = Math.max(0, latestUserIndex - 12)
  if (historyStart > 0) {
    const compacted = conversation.messages
      .slice(0, historyStart)
      .map(m => summarizeHistoricalMessage(m, includeUserHistory))
      .filter((m): m is LlmMessage => Boolean(m))
      .slice(-8)
    if (compacted.length > 0) {
      messages.push({
        role: 'system',
        content: 'Compacted older conversation context follows. It is historical context only and must not trigger old tool calls.',
      })
      messages.push(...compacted)
    }
  }
  for (let i = historyStart; i < conversation.messages.length; i += 1) {
    const m = conversation.messages[i]
    const isActiveTask = activeTaskId ? m.taskId === activeTaskId : i >= latestUserIndex
    if (m.role === 'system' && !isActiveTask) continue
    if (i < latestUserIndex && !isActiveTask) {
      const summarized = summarizeHistoricalMessage(m, includeUserHistory)
      if (summarized) messages.push(summarized)
      continue
    }
    const text = partsToText(m.content)
    const imageParts = m.content.filter((p): p is Extract<ContentPart, { type: 'image_url' }> => p.type === 'image_url')
    if (!text.trim() && !m.streaming && imageParts.length === 0) continue
    
    let content: LlmMessage['content'] = text
    if (isActiveTask && m.role === 'user' && imageParts.length > 0) {
      content = [
        { type: 'text', text },
        ...imageParts.map(p => ({ type: 'image_url' as const, image_url: { url: p.image_url.url } }))
      ]
    }

    messages.push({
      role: m.role,
      content,
      taskId: m.taskId,
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
  onStatus?: (payload: { taskId?: string; phase: AssistantRunPhase }) => void
  activeTaskId?: string
  onPart?: (payload: { taskId?: string; partIndex: number; part: ContentPart }) => void
  onPartUpdate?: (payload: { taskId?: string; partIndex: number; partId?: string; patch: Record<string, unknown> }) => void
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
  const offStatus = options.onStatus
    ? window.ava.llm.onStatus(({ streamId, taskId, phase }) => {
        if (streamId === options.streamId && (!options.activeTaskId || !taskId || taskId === options.activeTaskId)) {
          options.onStatus!({ taskId, phase })
        }
      })
    : () => { /* noop */ }
  const offPart = options.onPart
    ? window.ava.llm.onPart(({ streamId, taskId, partIndex, part }) => {
        if (streamId === options.streamId && (!options.activeTaskId || !taskId || taskId === options.activeTaskId)) {
          options.onPart!({ taskId, partIndex, part })
        }
      })
    : () => { /* noop */ }
  const offPartUpdate = options.onPartUpdate
    ? window.ava.llm.onPartUpdate(({ streamId, taskId, partIndex, partId, patch }) => {
        if (streamId === options.streamId && (!options.activeTaskId || !taskId || taskId === options.activeTaskId)) {
          options.onPartUpdate!({ taskId, partIndex, partId, patch })
        }
      })
    : () => { /* noop */ }

  try {
    const reply = await window.ava.llm.stream({
      streamId: options.streamId,
      messages,
      providers,
      activeTaskId: options.activeTaskId,
      activeCommandInvocation: latestCommandInvocation(options.conversation),
      temperature: 0.4,
      toolFormatMap: options.settings.modelToolFormatMap,
      pluginStates: options.settings.pluginStates,
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
    offStatus()
    offPart()
    offPartUpdate()
  }
}

function latestCommandInvocation(conversation: Conversation): CommandInvocation | undefined {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'user') return message.commandInvocation
  }
  return undefined
}

export function makeStreamId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function makeMessageId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function makeTaskId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function makeUserMessage(
  content: string,
  commandInvocation?: CommandInvocation,
  taskId = makeTaskId(),
  attachments: string[] = []
): Message {
  const parts: ContentPart[] = [{ type: 'text', text: content }]
  for (const url of attachments) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return {
    id: makeMessageId(),
    taskId,
    role: 'user',
    content: parts,
    createdAt: Date.now(),
    commandInvocation,
  }
}

export function makeAssistantPlaceholder(taskId?: string): Message {
  return {
    id: makeMessageId(),
    taskId,
    role: 'assistant',
    content: [],
    createdAt: Date.now(),
    streaming: true,
    runPhase: 'connecting',
  }
}
