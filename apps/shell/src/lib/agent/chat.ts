import type { AssistantRunPhase, CommandInvocation, ContentPart, Conversation, Message, ProjectBrief, Settings } from '../../types'
import { getEnabledProviders } from '../llm/providers'

// ── Shared utilities ────────────────────────────────────────────────

export function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

/** Rough token estimate: ~4 chars per token for English, ~2 for CJK. */
export function estimateTokens(text: string): number {
  // Count CJK characters (they use ~1 token each instead of ~0.25)
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  const rest = text.length - cjk
  return Math.ceil(rest / 4) + cjk
}

function estimateMessageTokens(msg: LlmMessage): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content) + 4 // role overhead
  // Multimodal: only count text parts, images are handled separately by the API
  const text = msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')
  return estimateTokens(text) + 4
}

// ── Image file extensions ───────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

function isImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true
  const ext = url.split('.').pop()?.toLowerCase().split('?')[0] || ''
  return IMAGE_EXTENSIONS.has(ext)
}

// ── System prompt construction ──────────────────────────────────────

const TRAIT_PROMPTS: Record<string, string[]> = {
  code: [
    'You are in Code mode.',
    'Prioritize working, runnable code and completing the requested file changes.',
    'For non-trivial code generation, write or edit files with tools instead of dumping large code blocks into chat.',
    'Use built-in file tools for project files: file.read_text, file.write_text, file.list_dir, file.create_dir, and file.stat.',
    'Use file.patch for precise edits to existing files when possible.',
    'Use project.detect and search.ripgrep to understand unfamiliar codebases before editing.',
    'When a task requires project initialization, dependency installation, build, test, git, node, npm, or python execution, use the available shell.run_command tool instead of only saying what you will run.',
    'Before final reporting on coding tasks, validate with project.validate or an equivalent build/test/typecheck command when available.',
    'Use shell.run_command with structured command and args, never as one combined shell string.',
    'Split large web/app tasks into small files or clear sections (for example index.html, styles.css, main.js) unless the user explicitly asks for one file.',
    'After writing files, inspect the file tail or run an available validation command before claiming the task is complete.',
    'If output is interrupted or token-limited, continue from the existing file state rather than restarting from scratch.',
    'Explain technical trade-offs briefly. Prefer concise implementations over verbose explanations.',
    'When debugging, show the fix first, then explain why.',
  ],
  design: [
    'You are in Design mode.',
    'Think visually. Describe layouts, colors, and typography precisely.',
    'When generating UI, prefer creating/editing project files over emitting a long single chat answer.',
    'For larger UI/site work, split structure, styling, and behavior into manageable files or sections.',
    'Suggest visual improvements proactively.',
  ],
  business: [
    'You are in Business mode.',
    'Focus on actionable insights: ROI, market analysis, competitive positioning.',
    'Use structured formats (tables, bullet lists) for data comparisons.',
    'Quantify recommendations whenever possible.',
  ],
  idea: [
    'You are in Brainstorm mode.',
    'Generate diverse, creative options. Think laterally.',
    'Present ideas in numbered lists. Include unconventional approaches.',
    'Build on ideas iteratively rather than dismissing them.',
  ],
  video: [
    'You are in Video/Script mode.',
    'Structure content for visual storytelling: scenes, shots, timing.',
    'Include technical specs (resolution, duration, transitions) when relevant.',
  ],
  mastery: [
    'You are in Learning mode.',
    'Break complex topics into digestible steps. Use analogies.',
    'Provide examples before definitions. Check understanding with follow-up questions.',
  ],
}

const TRAIT_TEMPERATURES: Record<string, number> = {
  code: 0.2,
  idea: 0.8,
  design: 0.5,
  business: 0.3,
  video: 0.6,
  mastery: 0.4,
  chat: 0.4,
}

function buildSystemPrompt(settings: Settings, traits?: string[]): string {
  const base = [
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
  ]

  const trait = traits?.[0] || 'chat'
  if (TRAIT_PROMPTS[trait]) {
    base.push('', ...TRAIT_PROMPTS[trait])
  }

  return base.join('\n')
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

function buildProjectContext(folderPath: string, brief: ProjectBrief): string {
  const lines = [
    'Project context (background only, do not repeat unless asked):',
    `Active folder: ${folderPath}`,
    `Files: ${brief.files.join(', ') || '(none)'}`,
  ]
  if (brief.tasksTotal > 0) {
    lines.push(`Task progress: ${brief.tasksDone}/${brief.tasksTotal} completed`)
  }
  return lines.join('\n')
}

// ── History helpers ─────────────────────────────────────────────────

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

// ── LLM message construction ────────────────────────────────────────

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  taskId?: string
  toolCallId?: string
}

const CONTEXT_BUDGET_BY_TRAIT: Record<string, number> = {
  chat: 6000,
  code: 16000,
  design: 8000,
  business: 8000,
  video: 8000,
  mastery: 10000,
  intelligence: 12000,
  laboratory: 12000,
  forge: 12000,
  idea: 8000,
  profile: 8000,
}

export function contextBudgetForTraits(traits?: string[]): number {
  const trait = traits?.[0] || 'chat'
  return CONTEXT_BUDGET_BY_TRAIT[trait] ?? CONTEXT_BUDGET_BY_TRAIT.chat
}

function conversationToLlmMessages(
  conversation: Conversation,
  settings: Settings,
  projectBrief?: ProjectBrief,
  folderPath?: string,
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

  // ── 1. Build mandatory messages (always included, not counted against budget) ──
  const mandatory: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(settings, conversation.traits) },
  ]

  // Project context — injected dynamically, always fresh
  if (projectBrief && folderPath) {
    mandatory.push({ role: 'system', content: buildProjectContext(folderPath, projectBrief) })
  }

  if (latestUserRequest) {
    mandatory.push({ role: 'system', content: buildCurrentTaskPrompt(latestUserRequest, activeTaskId) })
  }

  // ── 2. Build the active-task messages (latest user + same-task messages after it) ──
  const activeMessages: LlmMessage[] = []
  for (let i = latestUserIndex; i >= 0 && i < conversation.messages.length; i += 1) {
    const m = conversation.messages[i]
    const isActiveTask = activeTaskId ? m.taskId === activeTaskId : i >= latestUserIndex
    if (!isActiveTask && i > latestUserIndex) break
    if (m.role === 'system' && !isActiveTask) continue

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

    activeMessages.push({
      role: m.role,
      content,
      taskId: m.taskId,
      ...(m.role === 'tool' && m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    })
  }

  // ── 3. Build history messages within the token budget ──
  const mandatoryTokens = mandatory.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  const activeTokens = activeMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  const contextBudget = contextBudgetForTraits(conversation.traits)
  let remainingBudget = contextBudget - mandatoryTokens - activeTokens

  const historyMessages: LlmMessage[] = []

  // Walk backwards from latestUserIndex - 1 to include recent history
  for (let i = latestUserIndex - 1; i >= 0 && remainingBudget > 0; i -= 1) {
    const m = conversation.messages[i]
    const isActiveTask = activeTaskId ? m.taskId === activeTaskId : false

    if (m.role === 'system' && !isActiveTask) continue

    let msg: LlmMessage | null = null

    if (isActiveTask) {
      // Same-task messages: include verbatim
      const text = partsToText(m.content)
      const imageParts = m.content.filter((p): p is Extract<ContentPart, { type: 'image_url' }> => p.type === 'image_url')
      if (!text.trim() && imageParts.length === 0) continue

      let content: LlmMessage['content'] = text
      if (m.role === 'user' && imageParts.length > 0) {
        content = [
          { type: 'text', text },
          ...imageParts.map(p => ({ type: 'image_url' as const, image_url: { url: p.image_url.url } }))
        ]
      }
      msg = {
        role: m.role,
        content,
        taskId: m.taskId,
        ...(m.role === 'tool' && m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      }
    } else {
      // Historical messages: summarize to save tokens
      msg = summarizeHistoricalMessage(m, includeUserHistory)
    }

    if (!msg) continue

    const tokens = estimateMessageTokens(msg)
    if (tokens > remainingBudget) {
      // If this single message blows the budget, try a truncated version
      if (typeof msg.content === 'string' && msg.content.length > 200) {
        msg = { ...msg, content: msg.content.slice(0, 200) + '... (truncated)' }
        const truncatedTokens = estimateMessageTokens(msg)
        if (truncatedTokens > remainingBudget) break
        remainingBudget -= truncatedTokens
      } else {
        break
      }
    } else {
      remainingBudget -= tokens
    }

    historyMessages.unshift(msg) // prepend to maintain chronological order
  }

  // ── 4. Assemble final message array ──
  if (historyMessages.length > 0) {
    mandatory.push({
      role: 'system',
      content: 'Conversation history follows. Older messages are historical context only.',
    })
  }

  return [...mandatory, ...historyMessages, ...activeMessages]
}

export interface ContextUsageEstimate {
  usedTokens: number
  budgetTokens: number
  percent: number
  messageCount: number
}

export function estimateContextUsage(
  conversation: Conversation,
  settings: Settings,
  projectBrief?: ProjectBrief,
  folderPath?: string,
): ContextUsageEstimate {
  const messages = conversationToLlmMessages(conversation, settings, projectBrief, folderPath)
  const usedTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const budgetTokens = contextBudgetForTraits(conversation.traits)
  return {
    usedTokens,
    budgetTokens,
    percent: Math.min(100, Math.round((usedTokens / budgetTokens) * 100)),
    messageCount: conversation.messages.length,
  }
}

// ── Public API ──────────────────────────────────────────────────────

export interface SendOptions {
  conversation: Conversation
  settings: Settings
  projectBrief?: ProjectBrief
  folderPath?: string
  onDelta: (delta: string) => void
  onReasoningDelta?: (delta: string) => void
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
  stopReason?: 'output_limit' | 'tool_loop_limit' | 'server_disconnected'
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

  const messages = conversationToLlmMessages(
    options.conversation,
    options.settings,
    options.projectBrief,
    options.folderPath,
  )

  // Trait-based temperature
  const trait = options.conversation.traits?.[0] || 'chat'
  const temperature = TRAIT_TEMPERATURES[trait] ?? 0.4

  // ── Event listeners (simplified cleanup) ──
  const cleanups: (() => void)[] = [
    window.ava.llm.onChunk(({ streamId, text }) => {
      if (streamId === options.streamId) options.onDelta(text)
    }),
  ]
  if (options.onReasoningDelta && typeof window.ava.llm.onReasoningChunk === 'function') {
    const cb = options.onReasoningDelta
    cleanups.push(window.ava.llm.onReasoningChunk(({ streamId, text }) => {
      if (streamId === options.streamId) cb(text)
    }))
  }
  if (options.onAttempt) {
    const cb = options.onAttempt
    cleanups.push(window.ava.llm.onAttempt(({ streamId, attempts }) => {
      if (streamId === options.streamId) cb(attempts)
    }))
  }
  if (options.onStatus) {
    const cb = options.onStatus
    cleanups.push(window.ava.llm.onStatus(({ streamId, taskId, phase }) => {
      if (streamId === options.streamId && (!options.activeTaskId || !taskId || taskId === options.activeTaskId)) {
        cb({ taskId, phase })
      }
    }))
  }
  if (options.onPart) {
    const cb = options.onPart
    cleanups.push(window.ava.llm.onPart(({ streamId, taskId, partIndex, part }) => {
      if (streamId === options.streamId && (!options.activeTaskId || !taskId || taskId === options.activeTaskId)) {
        cb({ taskId, partIndex, part })
      }
    }))
  }
  if (options.onPartUpdate) {
    const cb = options.onPartUpdate
    cleanups.push(window.ava.llm.onPartUpdate(({ streamId, taskId, partIndex, partId, patch }) => {
      if (streamId === options.streamId && (!options.activeTaskId || !taskId || taskId === options.activeTaskId)) {
        cb({ taskId, partIndex, partId, patch })
      }
    }))
  }

  try {
    const reply = await window.ava.llm.stream({
      streamId: options.streamId,
      messages,
      providers,
      activeTaskId: options.activeTaskId,
      activeFolderPath: options.folderPath,
      activeCommandInvocation: latestCommandInvocation(options.conversation),
      temperature,
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
      stopReason: reply.result.stopReason,
    }
  } finally {
    cleanups.forEach(fn => fn())
  }
}

function latestCommandInvocation(conversation: Conversation): CommandInvocation | undefined {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'user') return message.commandInvocation
  }
  return undefined
}

// ── Message factories ───────────────────────────────────────────────

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
    if (isImageUrl(url)) {
      parts.push({ type: 'image_url', image_url: { url } })
    } else {
      // Non-image files: append as text context with file path
      parts.push({ type: 'text', text: `\n[Attached file: ${url}]` })
    }
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
