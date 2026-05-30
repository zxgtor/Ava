import type { AvaChatClientContext, AvaChatMessage, TaskExecutionPlan } from '@ava/contracts'
import type { LlmMessage, ModelProvider } from './llm'

type RuntimeSettings = {
  persona?: {
    assistantName?: unknown
    userName?: unknown
  }
}

const TRAIT_PROMPTS: Record<string, string[]> = {
  code: [
    'You are in Code mode.',
    'Prioritize working, runnable code and completing the requested file changes.',
    'For non-trivial code generation, write or edit files with tools instead of dumping large code blocks into chat.',
    'Use built-in file tools for project files: file.read_text, file.write_text, file.list_dir, file.create_dir, and file.stat.',
    'Use file.patch for precise edits to existing files when possible.',
    'Use project.map first to get a compact project picture, then project.detect, search.ripgrep, and file reads for targeted context.',
    'When a task requires project initialization, dependency installation, build, test, git, node, npm, or python execution, use the available shell.run_command tool instead of only saying what you will run.',
    'Never output raw commands such as dir, npm install, or npm run dev as plain text; call the appropriate tool.',
    'For frontend preview tasks, use devserver.start/status/stop, preview.open, preview.console, and preview.screenshot to inspect runtime and visual results.',
    'For long-running non-devserver commands, use process.start and recover with process.wait/process.status/process.logs instead of blocking the agent loop.',
    'Before final reporting on coding tasks, validate with project.validate or an equivalent build/test/typecheck command when available.',
    'Use shell.run_command with structured command and args, never as one combined shell string.',
    'Split large web/app tasks into small files or clear sections unless the user explicitly asks for one file.',
    'After writing files, inspect the file tail or run an available validation command before claiming the task is complete.',
    'If output is interrupted or token-limited, continue from the existing file state rather than restarting from scratch.',
  ],
  design: [
    'You are in Design mode.',
    'Think visually. Describe layouts, colors, and typography precisely.',
    'When generating UI, prefer creating/editing project files over emitting a long single chat answer.',
  ],
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

export function isAvaChatClientContext(raw: unknown): raw is AvaChatClientContext {
  if (!raw || typeof raw !== 'object') return false
  const context = raw as Partial<AvaChatClientContext>
  return Boolean(
    context.conversation &&
    typeof context.conversation === 'object' &&
    typeof context.conversation.id === 'string' &&
    Array.isArray(context.conversation.messages),
  )
}

export function buildDaemonChatMessages(input: {
  context: AvaChatClientContext
  settings: RuntimeSettings
  providers: ModelProvider[]
  activeTaskPlan?: TaskExecutionPlan
}): LlmMessage[] {
  const { context, settings, providers } = input
  const conversation = context.conversation
  const messages = conversation.messages
  const latestUserIndex = findLatestUserIndex(messages)
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : null
  const activeTaskId = latestUser?.taskId
  const latestUserRequest = latestUser ? partsToText(latestUser.content).trim() : ''
  const includeUserHistory = wantsHistoricalContinuation(latestUserRequest)
  const traits = conversation.traits ?? ['chat']

  const mandatory: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(settings, traits) },
  ]
  if (context.projectBrief && (context.folderPath || conversation.folderPath)) {
    mandatory.push({
      role: 'system',
      content: buildProjectContext(context.folderPath || conversation.folderPath || '', context.projectBrief),
    })
  }
  if (latestUserRequest) {
    mandatory.push({ role: 'system', content: buildCurrentTaskPrompt(latestUserRequest, activeTaskId) })
  }
  if (input.activeTaskPlan) {
    mandatory.push({ role: 'system', content: buildTaskMemoryState(input.activeTaskPlan) })
  }

  const activeMessages: LlmMessage[] = []
  for (let i = latestUserIndex; i >= 0 && i < messages.length; i += 1) {
    const message = messages[i]
    const isActiveTask = activeTaskId ? message.taskId === activeTaskId : i >= latestUserIndex
    if (!isActiveTask && i > latestUserIndex) break
    const normalized = normalizeMessage(message, isActiveTask)
    if (normalized) activeMessages.push(normalized)
  }

  const mandatoryTokens = mandatory.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const activeTokens = activeMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  let remainingBudget = planningContextBudgetForProviders(providers, traits) - mandatoryTokens - activeTokens
  const historyMessages: LlmMessage[] = []

  for (let i = latestUserIndex - 1; i >= 0 && remainingBudget > 0; i -= 1) {
    const message = messages[i]
    const isActiveTask = activeTaskId ? message.taskId === activeTaskId : false
    let normalized = isActiveTask
      ? normalizeMessage(message, true)
      : summarizeHistoricalMessage(message, includeUserHistory)
    if (!normalized) continue

    const tokens = estimateMessageTokens(normalized)
    if (tokens > remainingBudget) {
      if (typeof normalized.content !== 'string' || normalized.content.length <= 200) break
      normalized = { ...normalized, content: `${normalized.content.slice(0, 200)}... (truncated)` }
      const truncatedTokens = estimateMessageTokens(normalized)
      if (truncatedTokens > remainingBudget) break
      remainingBudget -= truncatedTokens
    } else {
      remainingBudget -= tokens
    }
    historyMessages.unshift(normalized)
  }

  if (historyMessages.length > 0) {
    mandatory.push({
      role: 'system',
      content: 'Conversation history follows. Older messages are historical context only.',
    })
  }
  return [...mandatory, ...historyMessages, ...activeMessages]
}

function buildSystemPrompt(settings: RuntimeSettings, traits?: string[]): string {
  const persona = settings.persona ?? {}
  const assistantName = typeof persona.assistantName === 'string' && persona.assistantName.trim() ? persona.assistantName : 'Ava'
  const userName = typeof persona.userName === 'string' && persona.userName.trim() ? persona.userName : 'User'
  const base = [
    `You are ${assistantName}, a reliable and practical AI assistant.`,
    `The user's name is ${userName}.`,
    'Your primary goal is to help the user successfully complete their task.',
    'Prioritize correctness, clarity, and usefulness over brevity.',
    'Answer in the same language as the user.',
    'Do not spend tokens on hidden reasoning. Provide the final answer directly.',
    'If the request is ambiguous or missing important information, ask follow-up questions before proceeding.',
    'Do not guess facts, requirements, or intent when uncertain.',
    'Point out mistakes, missing constraints, and important risks directly.',
    'For coding or design implementation tasks, final reports must state what changed, what validation was run, and any remaining risk.',
    'Do not say the task is complete if validation was skipped, failed, unavailable, or interrupted; state the exact status instead.',
    'For large coding/design tasks on local models, work in small planned steps: inspect, edit a small batch, validate/preview, repair, then continue.',
    'Task boundary rules:',
    '- Treat the latest user message as the current task.',
    '- If the latest user message gives a new concrete target, path, or scope, it replaces older unfinished requests.',
    '- Do not continue or retry older failed requests unless the user explicitly asks to continue or retry them.',
    '- Before every tool call, verify that the action is necessary for the latest user message, not merely related to older chat history.',
  ]
  const trait = traits?.[0] || 'chat'
  if (TRAIT_PROMPTS[trait]) base.push('', ...TRAIT_PROMPTS[trait])
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

function buildProjectContext(folderPath: string, brief: NonNullable<AvaChatClientContext['projectBrief']>): string {
  const lines = [
    'Project context (background only, do not repeat unless asked):',
    `Active folder: ${folderPath}`,
    `Files: ${brief.files.join(', ') || '(none)'}`,
  ]
  if (brief.tasksTotal > 0) lines.push(`Task progress: ${brief.tasksDone}/${brief.tasksTotal} completed`)
  return lines.join('\n')
}

function buildTaskMemoryState(plan: TaskExecutionPlan): string {
  const lines = [
    `Task goal: ${plan.goal}`,
    `Working directory: ${plan.workingDirectory}`,
    `Plan status: ${plan.status}`,
    `Current step: ${plan.currentStepId ?? '(none)'}`,
    `Validation: devServer=${plan.validation.devServerChecked}, console=${plan.validation.consoleChecked}, screenshot=${plan.validation.screenshotChecked}, build=${plan.validation.buildChecked}`,
  ]
  const active = plan.steps.find(step => step.id === plan.currentStepId)
  if (active?.lastError) lines.push(`Active step last error: ${active.lastError}`)
  return lines.join('\n')
}

function findLatestUserIndex(messages: AvaChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

function normalizeMessage(message: AvaChatMessage, includeImages: boolean): LlmMessage | null {
  if (message.role === 'system') return null
  const text = partsToText(message.content).trim()
  const imageParts = Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url')
    : []
  if (!text && imageParts.length === 0) return null
  const content = includeImages && message.role === 'user' && imageParts.length > 0
    ? [{ type: 'text' as const, text }, ...imageParts.map(part => ({ type: 'image_url' as const, image_url: { url: part.image_url.url } }))]
    : text
  return {
    role: message.role,
    content,
    taskId: message.taskId,
    ...(message.role === 'tool' && message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  }
}

function summarizeHistoricalMessage(message: AvaChatMessage, includeUserHistory: boolean): LlmMessage | null {
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
  return {
    role: 'system',
    taskId: message.taskId,
    content: `${taskPrefix}Historical assistant response, not an active task: ${text.length > 800 ? `${text.slice(0, 800)}...` : text}`,
  }
}

function wantsHistoricalContinuation(latestUserRequest: string): boolean {
  return /\b(continue|retry|again|previous|last|same)\b|继续|重试|再试|刚才|上次|之前|同一个/.test(latestUserRequest)
}

function partsToText(content: AvaChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  return Math.ceil((text.length - cjk) / 4) + cjk
}

function estimateMessageTokens(message: LlmMessage): number {
  if (typeof message.content === 'string') return estimateTokens(message.content) + 4
  return estimateTokens(message.content.filter(part => part.type === 'text').map(part => part.text).join('')) + 4
}

function contextBudgetForTraits(traits?: string[]): number {
  const trait = traits?.[0] || 'chat'
  return CONTEXT_BUDGET_BY_TRAIT[trait] ?? CONTEXT_BUDGET_BY_TRAIT.chat
}

function contextBudgetForModel(provider?: Pick<ModelProvider, 'id' | 'name' | 'defaultModel' | 'models'>): number {
  const text = [provider?.id, provider?.name, provider?.defaultModel, ...(provider?.models ?? [])].filter(Boolean).join(' ').toLowerCase()
  if (!text) return 8000
  if (/\b(1m|1000k|512k|256k|200k|128k)\b|claude|gemini|gpt-5|gpt-4\.1/.test(text)) return 32000
  if (/\b(64k|32k)\b|gpt-4o|o3|o4|deepseek|qwen3|qwen2\.5|kimi/.test(text)) return 24000
  if (/\b(16k|14b|32b|70b)\b|llama|mistral|mixtral|phi/.test(text)) return 16000
  return 8000
}

function planningContextBudgetForProviders(providers: ModelProvider[], traits?: string[]): number {
  const enabled = providers.find(provider => provider.enabled) ?? providers[0]
  return Math.max(contextBudgetForTraits(traits), contextBudgetForModel(enabled))
}
