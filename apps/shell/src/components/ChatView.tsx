import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Upload, FolderOpen, Terminal, Code, LayoutPanelLeft, MoreHorizontal,
  FolderPlus, Archive, Trash2, X, Pin, Edit2, Copy,
  HardDrive, FileText,
} from 'lucide-react'
import { useStore } from '../store'
import { EmptyState } from './EmptyState'
import { MessageBubble } from './MessageBubble'
import { PromptInput } from './PromptInput'
import {
  makeAssistantPlaceholder,
  makeMessageId,
  makeStreamId,
  makeTaskId,
  makeUserMessage,
  partsToText,
  estimateContextUsage,
  sendChat,
} from '../lib/agent/chat'
import { getEnabledProviders } from '../lib/llm/providers'
import { STTClient } from '../lib/voiceClient'
import { isSpeechEnabled } from '../lib/speechPlugin'
import { detectTraitsFromText } from '../lib/agent/traits'
import { extractWorkingDirectoryFromText, hasStrongCodingDesignTaskIntent, isCodingDesignBigTask } from '../lib/agent/taskBasics'
import type { CommandInvocation, ContentPart, Conversation, InitiativeTrait, Message, PluginCommand, ProjectBrief, TaskExecutionPlan, ProjectAnalysis } from '../types'

function hasFailedToolCall(conversation: Conversation, messageId: string): boolean {
  const message = conversation.messages.find(m => m.id === messageId)
  return Boolean(message?.content.some(part =>
    part.type === 'tool_call' && (part.status === 'error' || part.status === 'aborted'),
  ))
}

function lastStreamingAssistant(conversation: Conversation): string | null {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'assistant' && message.streaming) return message.id
  }
  return null
}

interface PendingTaskIntake {
  conversationId: string
  taskId: string
  sessionId?: string
  content: string
  attachments: string[]
  commandInvocation?: CommandInvocation
  analysis?: ProjectAnalysis
  stage?: 'clarifying' | 'awaiting_summary_confirm'
  clarificationAnswers?: Array<{ question: string; answer: string }>
}

const ENGLISH_CONFIRM_TASK_RE = /^(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run)\b/i
const CHINESE_CONFIRM_TASK_RE = /^(执行|开始|继续|确认|可以|好的|好|没问题|就这样)$/i
const FEATURE_TEST_RE = /^\s*\[AVA-FEATURE-TEST:([A-Za-z0-9_.-]+)\]/i
function localShouldRequireTaskIntake(content: string, commandInvocation?: CommandInvocation): boolean {
  if (commandInvocation) return true
  return hasStrongCodingDesignTaskIntent(content)
}

function isTaskConfirmation(content: string): boolean {
  const normalized = content.trim().replace(/[.!?。！？,，;；:：\s]+$/g, '')
  return ENGLISH_CONFIRM_TASK_RE.test(normalized) || CHINESE_CONFIRM_TASK_RE.test(normalized)
}

function isClarificationRedirect(pending: PendingTaskIntake, content: string): boolean {
  if (pending.stage !== 'clarifying') return false
  const normalized = content.trim()
  if (!normalized) return false

  const currentQuestion = nextClarification(pending)
  const options = currentQuestion?.options?.map(option => option.trim().toLowerCase()).filter(Boolean) ?? []
  if (options.includes(normalized.toLowerCase())) return false

  return /\b(not what i mean|misunderstood|misunderstand|actually|instead|change|cancel|stop|i want to|i need to|first)\b|不是|不对|误解|理解错|我的意思|其实|改成|取消|先看看|先看|先确认/i.test(normalized)
}

function highPriorityUnknowns(analysis?: ProjectAnalysis): ProjectAnalysis['unknowns'] {
  return analysis?.unknowns.filter(item => item.importance === 'high') ?? []
}

function answeredQuestions(pending: PendingTaskIntake): Set<string> {
  return new Set((pending.clarificationAnswers ?? []).map(item => item.question))
}

function nextClarification(pending: PendingTaskIntake): ProjectAnalysis['unknowns'][number] | null {
  const answered = answeredQuestions(pending)
  return highPriorityUnknowns(pending.analysis).find(item => !answered.has(item.question)) ?? null
}

function clarificationQuestionText(question: ProjectAnalysis['unknowns'][number], index: number, total: number): string {
  const options = question.options?.filter(Boolean) ?? []
  return [
    `需要先确认 1 个问题（${index}/${total}）：`,
    '',
    question.question,
    '',
    options.length > 0
      ? `请选择一个选项：${options.map(item => `「${item}」`).join('、')}`
      : '请直接回答这个问题。',
  ].join('\n')
}

function resolvedGoal(pending: PendingTaskIntake): string {
  const answers = pending.clarificationAnswers ?? []
  if (answers.length === 0) return pending.content
  return [
    pending.content,
    '',
    'Clarified requirements:',
    ...answers.map((item, idx) => `${idx + 1}. ${item.question}\nAnswer: ${item.answer}`),
  ].join('\n')
}

function analysisSummaryText(pending: PendingTaskIntake, workingDirectory?: string): string {
  const analysis = pending.analysis
  const answers = pending.clarificationAnswers ?? []
  return [
    '需求已澄清完毕，请确认下面 summary 是否正确。',
    '',
    `目标：${analysis?.projectSummary || pending.content}`,
    `工作目录：${workingDirectory || '(未关联工作目录)'}`,
    analysis?.architecture ? `架构判断：${analysis.architecture}` : '',
    answers.length > 0 ? '\n已确认：' : '',
    ...answers.map((item, idx) => `${idx + 1}. ${item.question}\n   答案：${item.answer}`),
    analysis?.risks?.length ? '\n主要风险：' : '',
    ...(analysis?.risks ?? []).map((risk, idx) => `${idx + 1}. ${risk.risk}\n   处理：${risk.mitigation}`),
    '',
    '如果正确，请回复「确认」。如果不正确，请直接补充要修改的地方。',
  ].filter(Boolean).join('\n')
}

function pendingWithAnswer(pending: PendingTaskIntake, answer: string): PendingTaskIntake {
  const question = nextClarification(pending)
  if (!question) return pending
  return {
    ...pending,
    clarificationAnswers: [
      ...(pending.clarificationAnswers ?? []),
      { question: question.question, answer },
    ],
  }
}

function hasWorkingDirectoryQuestion(analysis?: ProjectAnalysis): boolean {
  // Only count it as "already asked" if there's a HIGH-importance folder question.
  // Otherwise nextClarification (which filters to high) would skip a low/medium
  // folder question and silently fall through to the confirm card without ever
  // asking the user where to create the project.
  return Boolean(analysis?.unknowns.some(item =>
    item.importance === 'high' &&
    isWorkingDirectoryQuestion(item.question),
  ))
}

function isWorkingDirectoryQuestion(question: string): boolean {
  return /(working\s*directory|project\s*(folder|directory|path|location)|where.*(create|use)|folder|directory|path|工作目录|项目.*(目录|路径|位置)|创建.*(目录|路径|位置))/i.test(question)
}

function needsConcreteWorkingDirectoryAnswer(pending: PendingTaskIntake, answer: string): boolean {
  const question = nextClarification(pending)
  if (!question || !isWorkingDirectoryQuestion(question.question)) return false
  return !extractWorkingDirectoryFromText(answer)
}

function withRequiredWorkingDirectoryUnknown(
  analysis: ProjectAnalysis | null,
  content: string,
  conversation: Conversation,
): ProjectAnalysis | null {
  if (!isCodingDesignBigTask(content) || conversation.folderPath || extractWorkingDirectoryFromText(content)) {
    return analysis
  }
  if (hasWorkingDirectoryQuestion(analysis ?? undefined)) return analysis

  const requiredQuestion: ProjectAnalysis['unknowns'][number] = {
    question: 'Where should Ava create or use this code project? Provide a full Windows path.',
    options: ['D:\\Apps\\TestProject', 'I will provide another full path'],
    importance: 'high',
  }
  const base: ProjectAnalysis = analysis ?? {
    projectSummary: content.trim().split('\n')[0] || content,
    architecture: 'Unknown until the project folder is selected.',
    unknowns: [],
    risks: [{
      risk: 'Ava cannot safely create or inspect project files without a confirmed working directory.',
      mitigation: 'Ask for the project path before planning or executing tools.',
      impact: 'high',
    }],
  }
  return {
    ...base,
    unknowns: [requiredQuestion, ...base.unknowns],
  }
}

function planningTraitsFor(content: string, conversation: Conversation): string[] {
  if (isCodingDesignBigTask(content)) return ['code']
  return conversation.traits?.length ? conversation.traits : detectTraitsFromText(content)
}

type InputClassifyResult = {
  route?: string
  workflow?: string
  requiresTaskIntake?: boolean
  needsClarification?: boolean
  reason?: string
  confidence?: number
}

type InputDispatchResult = {
  classification?: InputClassifyResult
  action?: string
  workflow?: string
  status?: 'implemented' | 'planned'
  fallbackAction?: string
  actionPreview?: {
    text?: string
    requiresConfirmation?: boolean
    workflowPreview?: {
      kind: 'video_workflow'
      title: string
      outputTarget: string
      nextStep: string
      limitations: string[]
    }
  }
  reason?: string
}

type CodeAgentId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'openclaw'
type CodeAgentTaskKind = 'scaffold' | 'feature' | 'debug' | 'refactor' | 'research' | 'design' | 'unknown'

type CodeAgentDispatchResult = {
  status?: 'assigned' | 'blocked'
  reason?: string
  session?: {
    sessionId: string
    status: string
    process?: { pid?: number; command?: string; args?: string[] }
    events?: CodeAgentEvent[]
    selected: {
      agent: { id: CodeAgentId; name: string }
      score: number
      reasons: string[]
      probe?: { status: string; version?: string; error?: string }
    }
    taskPackage?: string
    task?: { conversationId?: string; goal?: string; workingDirectory?: string; taskKind?: string }
    completion?: {
      exitOk: boolean
      changedFilesMentioned: boolean
      validationMentioned: boolean
      finalReportMentioned: boolean
      requiredSignals: string[]
      missingSignals: string[]
      summary: string
    }
  }
  candidates?: Array<{
    agent: { id: CodeAgentId; name: string }
    score: number
    reasons: string[]
    probe?: { status: string; version?: string; error?: string }
  }>
}

type CodeAgentEvent = {
  id: string
  sessionId: string
  type: string
  message: string
  createdAt: number
}

type CodeAgentSession = NonNullable<CodeAgentDispatchResult['session']>

type CodeAgentSessionListResult = {
  sessions?: CodeAgentSession[]
}

type IntakeSessionResult = {
  session?: {
    sessionId: string
    conversationId: string
    taskId: string
    content: string
    workingDirectory?: string
    analysis?: ProjectAnalysis
    clarificationAnswers?: Array<{ question: string; answer: string }>
    stage?: 'clarifying' | 'awaiting_summary_confirm' | 'ready_to_plan' | 'canceled'
  }
  messageText?: string
  readyToPlan?: boolean
  canceled?: boolean
  finalGoal?: string
  workingDirectory?: string
  analysis?: ProjectAnalysis | null
}

function attachmentInputs(attachments?: string[]) {
  return (attachments ?? []).map(path => ({ path, name: path.split(/[\\/]/).pop() || path }))
}

function isPermissionDeny(content: string): boolean {
  return /\b(deny|denied|reject|rejected|do not|don't|no)\b|拒绝|不同意|不允许|不要/i.test(content)
}

function extractUrlFromText(content: string): string | null {
  return content.match(/\bhttps?:\/\/[^\s<>"']+|\b(?:localhost|127\.0\.0\.1):\d+\b/i)?.[0] ?? null
}

async function dispatchInputViaDaemon(input: {
  content: string
  commandInvocation?: CommandInvocation
  conversation: Conversation
  attachments?: string[]
  pendingIntake?: PendingTaskIntake | null
}): Promise<InputDispatchResult> {
  try {
    const result = await window.ava.agent.dispatchInput({
      content: input.content,
      hasCommandInvocation: Boolean(input.commandInvocation),
      pendingIntake: Boolean(input.pendingIntake),
      pendingIntakeStage: input.pendingIntake?.stage,
      workingDirectory: input.conversation.folderPath || extractWorkingDirectoryFromText(input.content),
      traits: planningTraitsFor(input.content, input.conversation),
      attachments: attachmentInputs(input.attachments),
    }) as InputDispatchResult
    return result
  } catch {
    const requiresTaskIntake = localShouldRequireTaskIntake(input.content, input.commandInvocation)
    return {
      classification: {
        route: requiresTaskIntake ? 'task_intake' : 'normal_chat',
        workflow: requiresTaskIntake ? 'intake' : 'chat',
        requiresTaskIntake,
        confidence: 0.4,
      },
      action: requiresTaskIntake ? 'start_task_intake' : 'run_chat',
      workflow: requiresTaskIntake ? 'intake' : 'chat',
      status: 'implemented',
    }
  }
}

async function startIntakeViaDaemon(input: {
  conversationId: string
  taskId: string
  content: string
  conversation: Conversation
  attachments?: string[]
  commandInvocation?: CommandInvocation
}): Promise<IntakeSessionResult> {
  return window.ava.agent.startIntakeSession({
    conversationId: input.conversationId,
    taskId: input.taskId,
    content: input.content,
    hasCommandInvocation: Boolean(input.commandInvocation),
    workingDirectory: input.conversation.folderPath || extractWorkingDirectoryFromText(input.content),
    messages: input.conversation.messages,
    traits: planningTraitsFor(input.content, input.conversation),
    attachments: attachmentInputs(input.attachments),
  }) as Promise<IntakeSessionResult>
}

async function replyIntakeViaDaemon(input: {
  pending: PendingTaskIntake
  content: string
  conversation: Conversation
}): Promise<IntakeSessionResult> {
  if (!input.pending.sessionId) throw new Error('Missing daemon intake session id.')
  return window.ava.agent.replyIntakeSession({
    sessionId: input.pending.sessionId,
    conversationId: input.pending.conversationId,
    content: input.content,
    workingDirectory: input.conversation.folderPath || extractWorkingDirectoryFromText(input.content),
    messages: input.conversation.messages,
    traits: planningTraitsFor(input.content, input.conversation),
  }) as Promise<IntakeSessionResult>
}

function inferPreferredCodeAgent(content: string): CodeAgentId | undefined {
  if (/\bclaude(?:\s+code)?\b/i.test(content)) return 'claude-code'
  if (/\bcodex\b|openai\s+codex/i.test(content)) return 'codex'
  if (/\bgemini\b/i.test(content)) return 'gemini'
  if (/\bopencode\b/i.test(content)) return 'opencode'
  if (/\bopenclaw\b/i.test(content)) return 'openclaw'
  return undefined
}

function inferCodeAgentTaskKind(content: string): CodeAgentTaskKind {
  if (/\b(debug|fix|error|bug|fail|failing|crash|broken)\b|修复|报错|错误|失败|崩溃/i.test(content)) return 'debug'
  if (/\b(refactor|rename|extract|restructure|cleanup)\b|重构|整理|拆分/i.test(content)) return 'refactor'
  if (/\b(research|compare|investigate|study|look into)\b|研究|调研|对比/i.test(content)) return 'research'
  if (/\b(design|ui|ux|layout|mockup|visual)\b|设计|界面|布局/i.test(content)) return 'design'
  if (/\b(create|build|scaffold|generate|new project|app|site)\b|创建|生成|搭建|新项目/i.test(content)) return 'scaffold'
  if (/\b(implement|add|change|update|feature)\b|实现|添加|修改|更新|功能/i.test(content)) return 'feature'
  return 'unknown'
}

function formatCodeAgentDispatchMessage(result: CodeAgentDispatchResult): string {
  if (result.status === 'assigned' && result.session) {
    return formatCodeAgentSessionMessage(result.session, result.reason)
  }

  const candidates = (result.candidates ?? []).slice(0, 5)
  const candidateText = candidates.length
    ? candidates.map(item => {
        const status = item.probe?.status ?? 'unknown'
        const detail = item.probe?.error || item.probe?.version || ''
        return `- ${item.agent.name}: ${status}${detail ? ` (${detail})` : ''}`
      }).join('\n')
    : '- no candidates returned'

  return [
    '暂时不能分派给 Code Agent。',
    '',
    `原因：${result.reason || 'No ready code agent is available.'}`,
    '',
    '候选代理：',
    candidateText,
    '',
    '请先在 Workspace 页面安装或修复可用的 code agent，然后重试。'
  ].join('\n')
}

function formatCodeAgentSessionMessage(session: CodeAgentSession, reason?: string): string {
  const selected = session.selected
  const probe = selected.probe?.version ? `（${selected.probe.version}）` : ''
  const pid = session.process?.pid ? `\n进程：pid ${session.process.pid}` : ''
  const reasons = selected.reasons.length
    ? selected.reasons.map(item => `- ${item}`).join('\n')
    : '- no selection reason returned'
  const events = formatCodeAgentEvents(session.events ?? [])
  const needsInput = [...(session.events ?? [])].reverse().find(event => event.type === 'needs_input')?.message
  const completion = session.completion
  const completionText = completion
    ? [
        `退出状态：${completion.exitOk ? 'ok' : 'failed'}`,
        `变更文件证据：${completion.changedFilesMentioned ? 'yes' : 'no'}`,
        `验证证据：${completion.validationMentioned ? 'yes' : 'no'}`,
        `最终报告证据：${completion.finalReportMentioned ? 'yes' : 'no'}`,
        completion.missingSignals.length ? `缺失：${completion.missingSignals.join(', ')}` : '缺失：none',
        `摘要：${completion.summary}`,
      ].join('\n')
    : ''
  return [
    'Code Agent 任务会话',
    '',
    `代理：${selected.agent.name}${probe}`,
    `会话：${session.sessionId}`,
    `状态：${session.status}${pid}`,
    reason ? `说明：${reason}` : '',
    needsInput ? `需要用户输入：\n${needsInput}` : '',
    completionText ? `完成证据：\n${completionText}` : '',
    '',
    '选择原因：',
    reasons,
    '',
    events ? `事件：\n${events}` : '事件：等待 daemon 返回进度...',
  ].filter(Boolean).join('\n')
}

function formatCodeAgentEvents(events: CodeAgentEvent[]): string {
  return events
    .slice(-12)
    .map(event => {
      const time = new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      const message = event.message.length > 500 ? `${event.message.slice(0, 500)}...` : event.message
      return `- ${time} [${event.type}] ${message}`
    })
    .join('\n')
}

function isCodeAgentTerminalStatus(status?: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'blocked'
}

async function listCodeAgentSessionsViaDaemon(): Promise<CodeAgentSessionListResult> {
  return window.ava.agent.listCodeAgentSessions() as Promise<CodeAgentSessionListResult>
}

async function sendCodeAgentSessionMessageViaDaemon(input: {
  sessionId: string
  message: string
}): Promise<CodeAgentSession> {
  return window.ava.agent.sendCodeAgentSessionMessage(input) as Promise<CodeAgentSession>
}

async function findBlockedCodeAgentSessionForConversation(conversationId: string): Promise<CodeAgentSession | undefined> {
  const list = await listCodeAgentSessionsViaDaemon()
  return (list.sessions ?? []).find(session => (
    session.status === 'blocked'
    && session.task?.conversationId === conversationId
    && (session.events ?? []).some(event => event.type === 'needs_input')
  ))
}

async function dispatchCodeAgentTaskViaDaemon(input: {
  content: string
  conversation: Conversation
}): Promise<CodeAgentDispatchResult> {
  return window.ava.agent.dispatchCodeAgentTask({
    goal: input.content,
    conversationId: input.conversation.id,
    workingDirectory: input.conversation.folderPath || extractWorkingDirectoryFromText(input.content),
    taskKind: inferCodeAgentTaskKind(input.content),
    preferredAgentId: inferPreferredCodeAgent(input.content),
    constraints: [
      'Do not modify unrelated files.',
      'Report changed files and validation results.',
    ],
    startImmediately: true,
  }) as Promise<CodeAgentDispatchResult>
}

function workflowSystemMessage(taskId: string, text: string): Message {
  return {
    id: `ctx_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    taskId,
    role: 'system',
    content: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

function hasExplicitVideoAssetSaveRequest(content: string): boolean {
  return /\b(save|write|export|create files?|generate files?|put (?:it|them) (?:in|under)|to files?|as files?|folder|directory)\b|保存|写入|导出|生成文件|创建文件|放到|目录|文件夹/i.test(content)
}

function hasVideoPromptPackRequest(content: string): boolean {
  return /\b(sora|runway|kling|veo|pika|video\s+prompts?|ai\s+video\s+prompt|prompt\s+pack)\b|视频提示词|生成视频提示词|提示词包/i.test(content)
}

function hasTtsVoiceoverRequest(content: string): boolean {
  return /\b(tts|voiceover|narration|audio|mp3|wav|spoken|speech|read\s+aloud)\b|旁白|配音|音频|语音|朗读/i.test(content)
}

function videoOutputTargetFor(content: string): string {
  if (/\b(remotion|editable\s+video|react\s+video|video\s+project)\b|可编辑视频|视频项目/i.test(content)) return 'remotion_project'
  if (hasVideoPromptPackRequest(content)) return 'video_prompts'
  if (hasTtsVoiceoverRequest(content)) return 'tts_voiceover'
  if (hasExplicitVideoAssetSaveRequest(content)) return 'file_assets'
  return 'chat_draft'
}

function makeCompletedAssistantMessage(taskId: string, text: string): Message {
  return {
    id: makeMessageId(),
    taskId,
    role: 'assistant',
    content: [{ type: 'text', text }],
    streaming: false,
    runPhase: 'completed',
    createdAt: Date.now(),
  }
}

function makeActionPreviewMessage(taskId: string, inputDecision: InputDispatchResult): Message | null {
  const actionPreview = inputDecision.actionPreview
  if (!actionPreview) return null
  const text = actionPreview.text?.trim()
  if (!text || actionPreview.requiresConfirmation) return null
  return {
    ...makeCompletedAssistantMessage(taskId, text),
    workflowPreview: actionPreview.workflowPreview,
  }
}

function maybeWithPreview(messages: Message[], preview: Message | null): Message[] {
  return preview ? [...messages, preview] : messages
}

async function pollCodeAgentSessionUpdates(input: {
  sessionId: string
  conversationId: string
  messageId: string
  dispatch: (action: any) => void
}): Promise<void> {
  const maxPolls = 1_200
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 800 : 1_500))
    const list = await listCodeAgentSessionsViaDaemon()
    const session = (list.sessions ?? []).find(item => item.sessionId === input.sessionId)
    if (!session) continue
    input.dispatch({
      type: 'UPDATE_MESSAGE',
      conversationId: input.conversationId,
      messageId: input.messageId,
      patch: {
        content: [{ type: 'text', text: formatCodeAgentSessionMessage(session) }],
        streaming: !isCodeAgentTerminalStatus(session.status),
        runPhase: isCodeAgentTerminalStatus(session.status)
          ? session.status === 'completed' ? 'completed' : 'error'
          : 'generating',
      },
    })
    if (isCodeAgentTerminalStatus(session.status)) return
  }
  input.dispatch({
    type: 'UPDATE_MESSAGE',
    conversationId: input.conversationId,
    messageId: input.messageId,
    patch: {
      streaming: false,
      runPhase: 'completed',
    },
  })
}

async function runDaemonAnalyzePhase(input: {
  taskId: string
  goal: string
  workingDirectory?: string
  messages: Message[]
  traits: string[]
}): Promise<ProjectAnalysis | null> {
  const result = await window.ava.agent.analyzeTask({
    taskId: input.taskId,
    goal: input.goal,
    workingDirectory: input.workingDirectory,
    traits: input.traits,
    messages: messagesForDaemon(input.messages),
  }) as { analysis?: ProjectAnalysis | null }
  return result.analysis ?? null
}

async function generateDaemonTaskPlan(input: {
  conversationId: string
  taskId: string
  goal: string
  workingDirectory?: string
  analysis?: ProjectAnalysis | null
  messages: Message[]
  traits: string[]
}): Promise<TaskExecutionPlan> {
  const result = await window.ava.agent.planTask({
    conversationId: input.conversationId,
    taskId: input.taskId,
    goal: input.goal,
    workingDirectory: input.workingDirectory,
    analysis: input.analysis ?? null,
    traits: input.traits,
    messages: messagesForDaemon(input.messages),
  }) as { plan?: TaskExecutionPlan }
  if (!result.plan) {
    throw new Error('Daemon did not return a TaskExecutionPlan.')
  }
  return result.plan
}

async function getDaemonActiveTaskPlan(conversationId: string): Promise<TaskExecutionPlan | undefined> {
  const result = await window.ava.agent.getActiveTaskPlan({ conversationId }) as { plan?: TaskExecutionPlan }
  return result.plan
}

async function setDaemonActiveTaskPlan(conversationId: string, plan: TaskExecutionPlan): Promise<void> {
  await window.ava.agent.setActiveTaskPlan({ conversationId, plan })
}

async function clearDaemonActiveTaskPlan(conversationId: string): Promise<void> {
  await window.ava.agent.clearActiveTaskPlan({ conversationId })
}

function messagesForDaemon(messages: Message[]) {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    taskId: message.taskId,
    toolCallId: message.toolCallId,
    createdAt: new Date(message.createdAt).toISOString(),
    content: message.content
      .filter(part => part.type === 'text' || part.type === 'image_url')
      .map(part => part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'image_url' as const, image_url: { url: part.image_url.url } }
      ),
  }))
}

function makeTaskIntakeText(content: string, conversation: Conversation): string {
  const folder = conversation.folderPath || extractWorkingDirectoryFromText(content) || '(未关联工作目录)'
  const firstLine = content.trim().split('\n')[0]
  return [
    '我先确认一下我的理解：',
    '',
    `目标：${firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine}`,
    `工作目录：${folder}`,
    '',
    '如果理解正确，请回复「确认」或「开始」。如果有误，请直接补充修正。',
  ].join('\n')
}

function makeConfirmedTaskPlanPrompt(content: string, conversation: Conversation): string {
  const folder = conversation.folderPath || extractWorkingDirectoryFromText(content) || '(no active folder)'
  return [
    'User confirmed the task plan. Execute it now.',
    `Task: ${content}`,
    `Working directory: ${folder}`,
    'If interrupted, continue from existing file state. Never restart from scratch unless explicitly asked.',
    'Do not mark the task complete unless validation/checks support that conclusion.',
  ].join('\n')
}

function appendLocalDelta(parts: ContentPart[], delta: string): ContentPart[] {
  const last = parts[parts.length - 1]
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + delta }]
  }
  return [...parts, { type: 'text', text: delta }]
}

function updateLocalToolPart(parts: ContentPart[], partIndex: number, partId: string | undefined, patch: Record<string, unknown>): ContentPart[] {
  return parts.map((part, idx) => {
    const isTarget = partId ? part.type === 'tool_call' && part.id === partId : idx === partIndex
    return isTarget && part.type === 'tool_call' ? { ...part, ...patch } : part
  })
}

function withTaskIdOnParts(parts: ContentPart[], taskId: string): ContentPart[] {
  return parts.map(part => part.type === 'tool_call' ? { ...part, taskId: part.taskId ?? taskId } : part)
}

function mergeAuthoritativeParts(existing: ContentPart[], authoritative: ContentPart[], taskId: string): ContentPart[] {
  if (authoritative.length === 0) return existing
  const normalized = withTaskIdOnParts(authoritative, taskId)
  const byId = new Map(
    normalized
      .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
      .map(part => [part.id, part]),
  )
  const merged = existing.map(part =>
    part.type === 'tool_call' && byId.has(part.id)
      ? byId.get(part.id)!
      : part,
  )
  const existingIds = new Set(
    merged
      .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
      .map(part => part.id),
  )
  const existingText = partsToText(merged)
  const missing = normalized.filter(part =>
    part.type === 'tool_call'
      ? !existingIds.has(part.id)
      : part.type !== 'text' || !part.text || !existingText.includes(part.text),
  )
  return missing.length > 0 ? [...merged, ...missing] : merged
}

function featureTestIdFromText(text: string): string | null {
  return text.match(FEATURE_TEST_RE)?.[1] ?? null
}

function toolCallsForLog(parts: ContentPart[]) {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
    .map(part => ({
      name: part.name,
      status: part.status,
      error: part.error,
      args: part.args,
    }))
}

function ChatSessionBar({
  conversation,
  suggestedTrait,
  onAcceptTraitSuggestion,
  onDismissTraitSuggestion,
  onOpenPreview,
  onDelete,
}: {
  conversation: Conversation | null
  suggestedTrait?: InitiativeTrait
  onAcceptTraitSuggestion?: () => void
  onDismissTraitSuggestion?: () => void
  onOpenPreview: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const { dispatch } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const menuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const folderPath = conversation?.folderPath
  const title = conversation?.title || t('sidebar.new_chat', 'New session')
  const primaryTrait = conversation?.traits?.[0] || 'chat'
  const canPreview = Boolean(conversation && (
    primaryTrait === 'design' ||
    primaryTrait === 'code' ||
    primaryTrait === 'video' ||
    conversation.messages.length > 0
  ))

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setMenuOpen(false)
  }

  const copyMarkdown = async () => {
    if (!conversation) return
    const markdown = [
      `# ${conversation.title}`,
      '',
      ...conversation.messages.map(message => {
        const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role
        const body = partsToText(message.content).trim()
        return `## ${label}\n\n${body || '_No text content_'}`
      }),
      '',
    ].join('\n')
    await copyText(markdown)
  }

  const startRename = () => {
    if (!conversation) return
    setRenameTitle(conversation.title)
    setRenaming(true)
    setMenuOpen(false)
  }

  const saveRename = () => {
    if (conversation && renameTitle.trim()) {
      dispatch({ type: 'RENAME_CONVERSATION', id: conversation.id, title: renameTitle.trim() })
    }
    setRenaming(false)
  }

  const handlePin = () => {
    if (!conversation) return
    dispatch({ type: 'TOGGLE_PIN_CONVERSATION', id: conversation.id })
    setMenuOpen(false)
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!renaming) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renaming])

  const handleLinkFolder = async () => {
    if (!conversation) return
    setMenuOpen(false)
    const path = await window.ava.dialog.pickDirectory()
    if (path) {
      const trait = conversation.traits?.[0] || 'chat'
      await window.ava.workspace.ensureProjectDocs({ folderPath: path, title: conversation.title, trait })
      dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path })
    }
  }

  const handleUnlinkFolder = () => {
    if (!conversation) return
    setMenuOpen(false)
    dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path: '' })
  }

  const handleArchive = () => {
    if (!conversation) return
    setMenuOpen(false)
    dispatch({ type: 'ARCHIVE_CONVERSATION', id: conversation.id })
  }

  return (
    <div className="relative z-50 flex h-10 shrink-0 items-center justify-between bg-bg/20 px-4 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-1.5">
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameTitle}
            onChange={e => setRenameTitle(e.target.value)}
            onBlur={saveRename}
            onKeyDown={e => {
              if (e.key === 'Enter') saveRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="min-w-0 rounded-md border border-accent/40 bg-black/30 px-2 py-1 text-[13px] font-semibold text-text outline-none"
          />
        ) : (
          <div className="truncate text-[13px] font-semibold text-text">{title}</div>
        )}
        {suggestedTrait && (
          <div className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            <span>{t('chat.move_to_trait', 'Looks like {{trait}}', { trait: t(`traits.${suggestedTrait}`, suggestedTrait) })}</span>
            <button
              type="button"
              onClick={onAcceptTraitSuggestion}
              className="rounded px-1 font-medium hover:bg-accent/15"
            >
              {t('chat.move', 'Move')}
            </button>
            <button
              type="button"
              onClick={onDismissTraitSuggestion}
              className="rounded px-1 text-text-3 hover:bg-white/10 hover:text-text"
              aria-label={t('chat.dismiss', 'Dismiss')}
            >
              ×
            </button>
          </div>
        )}
        {conversation && (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(v => !v)}
              className="rounded p-1 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.session_actions', 'Session actions')}
            >
              <MoreHorizontal size={14} />
            </button>

            {menuOpen && (
              <div className="ava-menu absolute left-0 top-7 z-[999] w-68 py-1.5">
                <button onClick={handlePin} className="ava-menu-item">
                  <Pin size={13} className={conversation.pinned ? 'text-accent' : 'text-text-3'} fill={conversation.pinned ? 'currentColor' : 'none'} />
                  <span>{conversation.pinned ? t('sidebar.unpin', 'Unpin chat') : t('sidebar.pin', 'Pin chat')}</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+P</span>
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    startRename()
                  }}
                  className="ava-menu-item"
                >
                  <Edit2 size={13} className="text-text-3" />
                  <span>{t('sidebar.rename', 'Rename chat')}</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+R</span>
                </button>
                <button onClick={handleArchive} className="ava-menu-item">
                  <Archive size={13} className="text-text-3" />
                  <span>{t('sidebar.archive', 'Archive chat')}</span>
                  <span className="ava-menu-shortcut">Ctrl+Shift+A</span>
                </button>

                <div className="ava-menu-separator" />

                <button
                  onClick={() => folderPath && copyText(folderPath)}
                  disabled={!folderPath}
                  className="ava-menu-item disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <HardDrive size={13} className="text-text-3" />
                  <span>Copy working directory</span>
                  <span className="ava-menu-shortcut">Ctrl+Shift+C</span>
                </button>
                <button onClick={() => copyText(conversation.id)} className="ava-menu-item">
                  <Copy size={13} className="text-text-3" />
                  <span>Copy session ID</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+C</span>
                </button>
                <button onClick={() => copyText(`ava://session/${conversation.id}`)} className="ava-menu-item">
                  <Copy size={13} className="text-text-3" />
                  <span>Copy deeplink</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+L</span>
                </button>
                <button onClick={copyMarkdown} className="ava-menu-item">
                  <FileText size={13} className="text-text-3" />
                  <span>Copy as Markdown</span>
                </button>

                <div className="ava-menu-separator" />

                {folderPath ? (
                  <button onClick={handleUnlinkFolder} className="ava-menu-item">
                    <X size={13} className="text-text-3" />
                    <span>{t('sidebar.unlink_folder', 'Unlink folder')}</span>
                  </button>
                ) : (
                  <button onClick={handleLinkFolder} className="ava-menu-item">
                    <FolderPlus size={13} className="text-text-3" />
                    <span>{t('sidebar.link_folder', 'Link folder')}</span>
                  </button>
                )}
                {onDelete && (
                  <button onClick={onDelete} className="ava-menu-item">
                    <Trash2 size={13} />
                    <span>{t('sidebar.delete', 'Delete')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {folderPath && (
          <>
            <button
              type="button"
              onClick={() => window.ava.workspace.openPath(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={folderPath}
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.ava.workspace.openInVSCode(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.open_code', 'Open in VS Code')}
            >
              <Code size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.ava.workspace.openInTerminal(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.open_terminal', 'Open in Terminal')}
            >
              <Terminal size={14} />
            </button>
          </>
        )}
        {canPreview && (
          <button
            type="button"
            onClick={onOpenPreview}
            className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
            title={t('chat.open_preview', 'Open Design Preview Window')}
          >
            <LayoutPanelLeft size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export function ChatView() {
  const { t } = useTranslation()
  const { state, dispatch, activeConversation, createConversation } = useStore()
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamId, setStreamId] = useState<string | null>(null)
  const [commands, setCommands] = useState<PluginCommand[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [sttClient, setSttClient] = useState<STTClient | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [sttText, setSttText] = useState<string | undefined>(undefined)
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
  const [editDraft, setEditDraft] = useState<{ messageId: string; text: string } | null>(null)
  const [traitSuggestion, setTraitSuggestion] = useState<{ conversationId: string; trait: InitiativeTrait } | null>(null)
  const [dismissedTraitSuggestions, setDismissedTraitSuggestions] = useState<Record<string, InitiativeTrait>>({})
  const [pendingTaskIntake, setPendingTaskIntake] = useState<PendingTaskIntake | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const hasProvider = useMemo(
    () => getEnabledProviders(state.settings).length > 0,
    [state.settings],
  )

  const userInitial = (state.settings.persona.userName || 'U').slice(0, 1).toUpperCase()
  const assistantInitial = (state.settings.persona.assistantName || 'A').slice(0, 1).toUpperCase()
  const projectBrief = state.projectBriefs[activeConversation?.id ?? '']
  const contextUsage = useMemo(() => {
    if (!activeConversation) return undefined
    return estimateContextUsage(
      activeConversation,
      state.settings,
      projectBrief,
      activeConversation.folderPath,
    )
  }, [activeConversation, projectBrief, state.settings])

  const refreshCommands = useCallback(async () => {
    setCommandsLoading(true)
    try {
      const list = await window.ava.plugins.listCommands(state.settings.pluginStates)
      setCommands(list)
    } catch {
      setCommands([])
    } finally {
      setCommandsLoading(false)
    }
  }, [state.settings.pluginStates])

  useEffect(() => {
    refreshCommands()
  }, [refreshCommands])

  useEffect(() => {
    setEditDraft(null)
    setTraitSuggestion(null)
    setPendingTaskIntake(null)
  }, [activeConversation?.id])

  useEffect(() => {
    if (!activeConversation?.id) return
    let alive = true
    getDaemonActiveTaskPlan(activeConversation.id)
      .then(plan => {
        if (!alive || !plan) return
        dispatch({ type: 'START_TASK_PLAN', conversationId: activeConversation.id, plan })
      })
      .catch(err => console.warn('[task-plan] failed to sync daemon plan:', err))
    return () => {
      alive = false
    }
  }, [activeConversation?.id, dispatch])

  // Auto-scroll on new messages / streaming
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeConversation?.messages, isStreaming])

  const syncProjectContext = useCallback(async () => {
    if (!activeConversation) return
    if (!activeConversation.folderPath) {
      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief: null })
      return
    }
    try {
      const folder = activeConversation.folderPath
      const brief = await window.ava.agent.getProjectBrief({ folderPath: folder }) as ProjectBrief | null
      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief })
    } catch (err) {
      console.warn('Project sync failed:', err)
      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief: null })
    }
  }, [activeConversation?.folderPath, activeConversation?.id, dispatch])

  useEffect(() => {
    syncProjectContext()
  }, [syncProjectContext])

  // Real-time Preview Sync (Level 4: Design Awareness)
  useEffect(() => {
    if (!activeConversation) return
    const messages = activeConversation.messages
    if (messages.length === 0) return

    const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistantMessage) return

    const text = partsToText(lastAssistantMessage.content)
    
    // 優先匹配 ``` 塊內的內容，如果沒有，則匹配標籤本身
    let htmlContent = ''
    const blockMatch = text.match(/```(?:html|svg)\s*([\s\S]*?)\s*```/i)
    if (blockMatch) {
      htmlContent = blockMatch[1]
    } else {
      const tagMatch = text.match(/<(html|svg)[\s\S]*?<\/\1>/i) || text.match(/<svg[\s\S]*?>[\s\S]*/i)
      if (tagMatch) htmlContent = tagMatch[0]
    }
    
    if (htmlContent) {
      // 延遲一小會兒確保預覽窗口已經 Ready
      setTimeout(() => {
        window.ava.window.updatePreview(htmlContent)
      }, 500)
    }
  }, [activeConversation?.messages, activeConversation?.id])


  const toggleStt = useCallback(async () => {
    if (!isSpeechEnabled(state.settings)) return

    if (isRecording) {
      sttClient?.stop()
      setIsRecording(false)
      setSttClient(null)
      return
    }

    try {
      const client = new STTClient(state.settings.voice.sttServerUrl)
      client.onFinalTranscript = (text) => {
        setSttText(text)
        // Reset after a short delay so the effect triggers again if the same text is spoken
        setTimeout(() => setSttText(undefined), 100)
      }
      client.onEndpoint = () => {
        client.stop()
        setIsRecording(false)
        setSttClient(null)
      }
      await client.start()
      setSttClient(client)
      setIsRecording(true)
    } catch (err) {
      console.warn('Failed to start STT:', err)
      setIsRecording(false)
    }
  }, [isRecording, sttClient, state.settings])

  // Tell STT server when bot is speaking for echo cancellation
  useEffect(() => {
    if (sttClient && isStreaming) {
      sttClient.sendBotState(true)
    } else if (sttClient && !isStreaming) {
      sttClient.sendBotState(false)
    }
  }, [isStreaming, sttClient])

  // Shared streaming driver. Desktop only owns UI state here.
  // Task step execution, validation gates, repair, and auto-continuation are owned by the daemon.
  const driveStream = useCallback(
    async (
      conversationSnapshot: Conversation,
      conversationId: string,
      placeholderId: string,
      activeTaskId: string,
      initialTaskPlan?: TaskExecutionPlan,
    ) => {
      const id = makeStreamId()
      setIsStreaming(true)
      setStreamId(id)

      let accumulatedParts: ContentPart[] = []
      let latestPlan = initialTaskPlan ?? conversationSnapshot.activeTaskPlan
      if (!latestPlan) {
        try {
          latestPlan = await getDaemonActiveTaskPlan(conversationId)
          if (latestPlan) dispatch({ type: 'START_TASK_PLAN', conversationId, plan: latestPlan })
        } catch (err) {
          console.warn('[task-plan] failed to load daemon active plan:', err)
        }
      } else if (initialTaskPlan) {
        void setDaemonActiveTaskPlan(conversationId, initialTaskPlan).catch(err => {
          console.warn('[task-plan] failed to mirror initial plan to daemon:', err)
        })
      }
      let daemonCompleted = latestPlan?.status === 'completed'
      let daemonBlockedError: string | undefined
      const initialStep = latestPlan?.currentStepId
        ? latestPlan.steps.find(step => step.id === latestPlan?.currentStepId)
        : undefined

      const featureTestRequest = (() => {
        for (let i = conversationSnapshot.messages.length - 1; i >= 0; i -= 1) {
          const message = conversationSnapshot.messages[i]
          if (message.role !== 'user') continue
          const text = partsToText(message.content)
          const testId = featureTestIdFromText(text)
          if (testId) return { testId, text }
        }
        return null
      })()
      let featureTestLogged = false
      const logFeatureTest = async (input: {
        status: 'passed' | 'failed'
        message?: string
        stopReason?: string
        fullContent?: string
      }) => {
        if (!featureTestRequest || featureTestLogged || !window.ava.dev?.appendUnitTestResult) return
        featureTestLogged = true
        try {
          await window.ava.dev.appendUnitTestResult({
            id: `feature-test:${featureTestRequest.testId}`,
            kind: 'feature',
            name: featureTestRequest.testId,
            status: input.status,
            message: input.message,
            request: featureTestRequest.text,
            toolCalls: toolCallsForLog(accumulatedParts),
            stopReason: input.stopReason,
            fullContent: input.fullContent ?? partsToText(accumulatedParts),
          })
        } catch (err) {
          console.warn('[feature-test] failed to write log:', err)
        }
      }

      if (initialStep) {
        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId: placeholderId,
          patch: { taskStepTitle: initialStep.title },
        })
      }

      try {
        const result = await sendChat({
          conversation: conversationSnapshot,
          settings: state.settings,
          projectBrief,
          folderPath: conversationSnapshot.folderPath,
          streamId: id,
          activeTaskId,
          activeTaskPlan: latestPlan,
          onStatus: ({ taskId, phase }) => {
            if (taskId && taskId !== activeTaskId) return
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { runPhase: phase },
            })
          },
          onDelta: delta => {
            accumulatedParts = appendLocalDelta(accumulatedParts, delta)
            dispatch({
              type: 'APPEND_DELTA',
              conversationId,
              messageId: placeholderId,
              delta,
            })
          },
          onReasoningDelta: delta => {
            dispatch({
              type: 'APPEND_REASONING_DELTA',
              conversationId,
              messageId: placeholderId,
              delta,
            })
          },
          onPart: ({ taskId, part }) => {
            if (taskId && taskId !== activeTaskId) return
            const nextPart = part.type === 'tool_call' ? { ...part, taskId: part.taskId ?? activeTaskId } : part
            accumulatedParts = [...accumulatedParts, nextPart]
            dispatch({
              type: 'ADD_PART',
              conversationId,
              messageId: placeholderId,
              part: nextPart,
            })
          },
          onPartUpdate: ({ taskId, partIndex, partId, patch }) => {
            if (taskId && taskId !== activeTaskId) return
            accumulatedParts = updateLocalToolPart(accumulatedParts, partIndex, partId, patch)
            dispatch({
              type: 'UPDATE_PART',
              conversationId,
              messageId: placeholderId,
              partIndex,
              partId,
              patch,
            })
          },
          onTaskPlanUpdate: ({ taskId, phase, plan, validation, stepTitle, error }) => {
            if (taskId && taskId !== activeTaskId) return
            latestPlan = plan
            daemonCompleted = phase === 'completed' || plan.status === 'completed'
            if (phase === 'blocked') {
              daemonBlockedError = error ?? 'Task plan blocked in daemon.'
              dispatch({ type: 'BLOCK_TASK_PLAN', conversationId, plan })
            } else if (phase === 'completed') {
              dispatch({ type: 'COMPLETE_TASK_PLAN', conversationId, plan })
            } else {
              dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan })
            }
            if (validation) dispatch({ type: 'UPDATE_TASK_VALIDATION', conversationId, validation })
            if (stepTitle || phase === 'completed' || phase === 'blocked') {
              dispatch({
                type: 'UPDATE_MESSAGE',
                conversationId,
                messageId: placeholderId,
                patch: { taskStepTitle: phase === 'completed' || phase === 'blocked' ? undefined : stepTitle },
              })
            }
          },
        })

        if (!result.ok) {
          if (result.error === 'aborted') {
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { streaming: false, aborted: true, runPhase: 'aborted', taskStepTitle: undefined },
            })
            await logFeatureTest({ status: 'failed', message: 'aborted' })
            return
          }
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: result.error, runPhase: 'error', taskStepTitle: undefined },
          })
          await logFeatureTest({ status: 'failed', message: result.error })
          return
        }

        accumulatedParts = mergeAuthoritativeParts(accumulatedParts, result.parts, activeTaskId)
        const patch: Partial<Message> = { content: accumulatedParts }
        if (daemonBlockedError) {
          patch.streaming = false
          patch.error = daemonBlockedError
          patch.runPhase = 'error'
          patch.taskStepTitle = undefined
        } else if (latestPlan && !daemonCompleted && latestPlan.status !== 'completed') {
          patch.streaming = false
          patch.error = result.stopReason
            ? `Daemon task loop stopped with ${result.stopReason}.`
            : 'Daemon task loop ended before completing or blocking the active task plan.'
          patch.runPhase = 'error'
          patch.taskStepTitle = undefined
        } else if (result.stopReason) {
          patch.streaming = false
          patch.error = `Stopped: ${result.stopReason}.`
          patch.runPhase = 'error'
          patch.taskStepTitle = undefined
        } else {
          patch.streaming = false
          patch.runPhase = 'completed'
          patch.taskStepTitle = undefined
        }

        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId: placeholderId,
          patch,
        })

        if (result.detectedToolFormat !== 'none') {
          const key = `${result.providerId}:${result.model}`
          dispatch({
            type: 'UPDATE_SETTINGS',
            settings: {
              ...state.settings,
              modelToolFormatMap: {
                ...state.settings.modelToolFormatMap,
                [key]: result.detectedToolFormat,
              },
            },
          })
        }

        await logFeatureTest({
          status: patch.error ? 'failed' : 'passed',
          message: typeof patch.error === 'string' ? patch.error : undefined,
          stopReason: result.stopReason,
          fullContent: result.fullContent,
        })

        const currentTraits = conversationSnapshot.traits || ['chat']
        if (!patch.error && conversationSnapshot.messages.length > 1) {
          const lastMsg = conversationSnapshot.messages[conversationSnapshot.messages.length - 1]
          const combinedText = partsToText(lastMsg.content)
          const newTraits = detectTraitsFromText(combinedText)
          const suggested = newTraits[0] as InitiativeTrait | undefined
          if (
            suggested &&
            suggested !== 'chat' &&
            suggested !== currentTraits[0] &&
            dismissedTraitSuggestions[conversationId] !== suggested
          ) {
            setTraitSuggestion({ conversationId, trait: suggested })
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'aborted') {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, aborted: true, runPhase: 'aborted', taskStepTitle: undefined },
          })
          await logFeatureTest({ status: 'failed', message: 'aborted' })
        } else {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: msg, runPhase: 'error', taskStepTitle: undefined },
          })
          await logFeatureTest({ status: 'failed', message: msg })
        }
      } finally {
        setIsStreaming(false)
        setStreamId(null)
      }
    },
    [dismissedTraitSuggestions, dispatch, state.settings],
  )

  const runSend = useCallback(
    async (content: string, attachments: string[] = [], conversation: Conversation, commandInvocation?: CommandInvocation) => {
      const taskId = makeTaskId()
      const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments)
      const placeholder = makeAssistantPlaceholder(taskId)
      const conversationId = conversation.id

      dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })

      // Auto-title from first user message
      if (conversation.messages.length === 0) {
        const title = content.length > 30 ? `${content.slice(0, 30)}…` : content
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
        
        // 🟢 首次發送或當前為通用狀態時，立即識別特性
        const currentTraits = conversation.traits || ['chat']
        if (currentTraits.length === 0 || currentTraits[0] === 'chat') {
          const initialTraits = detectTraitsFromText(content)
          if (initialTraits.length > 0 && initialTraits[0] !== 'chat') {
            dispatch({ type: 'SET_TRAITS', id: conversationId, traits: initialTraits })
          }
        }
      }

      await driveStream(
        {
          ...conversation,
          messages: [...conversation.messages, userMsg],
        },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [dispatch, driveStream],
  )

  const runEditedResend = useCallback(
    async (messageId: string, content: string, attachments: string[] = [], conversation: Conversation) => {
      const idx = conversation.messages.findIndex(m => m.id === messageId)
      if (idx < 0) {
        setEditDraft(null)
        await runSend(content, attachments, conversation)
        return
      }
      const original = conversation.messages[idx]
      if (original.role !== 'user') {
        setEditDraft(null)
        await runSend(content, attachments, conversation)
        return
      }

      const nextText = content.trim()
      if (!nextText) return
      setEditDraft(null)

      const taskId = makeTaskId()
      const editedUser = makeUserMessage(nextText, original.commandInvocation, taskId, attachments)
      const conversationId = conversation.id

      const editedInputDecision = await dispatchInputViaDaemon({
        content: nextText,
        commandInvocation: original.commandInvocation,
        conversation,
        attachments,
      })
      if (editedInputDecision.action === 'start_task_intake' || editedInputDecision.classification?.requiresTaskIntake) {
        const intakeMsg = makeAssistantPlaceholder(taskId)
        dispatch({
          type: 'REPLACE_MESSAGES_FROM',
          conversationId,
          fromMessageId: messageId,
          messages: [
            editedUser,
            {
              ...intakeMsg,
              content: [{ type: 'text', text: '🔍 Analyzing project constraints...' }],
              streaming: true,
              runPhase: 'generating',
            },
          ],
        })

        const intake = await startIntakeViaDaemon({
          taskId,
          conversationId,
          content: nextText,
          conversation,
          attachments,
          commandInvocation: original.commandInvocation,
        })
        const session = intake.session
        const finalContent: ContentPart[] = [{
          type: 'text',
          text: intake.messageText || '⚠️ Agent OS Pre-Flight Analysis failed.',
        }]

        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId: intakeMsg.id,
          patch: {
            content: finalContent,
            streaming: false,
            runPhase: 'completed',
          }
        })

        if (session) {
          setPendingTaskIntake({
            conversationId,
            taskId,
            sessionId: session.sessionId,
            content: session.content,
            attachments,
            commandInvocation: original.commandInvocation,
            stage: session.stage === 'awaiting_summary_confirm' ? 'awaiting_summary_confirm' : 'clarifying',
          })
        }
        return
      }

      const placeholder = makeAssistantPlaceholder(taskId)

      dispatch({
        type: 'REPLACE_MESSAGES_FROM',
        conversationId,
        fromMessageId: messageId,
        messages: [editedUser, placeholder],
      })

      if (idx === 0) {
        const title = nextText.length > 30 ? `${nextText.slice(0, 30)}…` : nextText
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
        const traits = detectTraitsFromText(nextText)
        dispatch({ type: 'SET_TRAITS', id: conversationId, traits })
      }

      await driveStream(
        {
          ...conversation,
          messages: [...conversation.messages.slice(0, idx), editedUser],
        },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [dispatch, driveStream, runSend],
  )

  const handleSend = useCallback(
    async (content: string, attachments?: string[], commandInvocation?: CommandInvocation) => {
      const conversation = activeConversation ?? createConversation()
      if (editDraft && activeConversation) {
        runEditedResend(editDraft.messageId, content, attachments ?? [], activeConversation)
        return
      }

      if (
        pendingTaskIntake &&
        pendingTaskIntake.conversationId === conversation.id
      ) {
        const pending = pendingTaskIntake
        const placeholder = makeAssistantPlaceholder(pending.taskId)
        const userMsg = makeUserMessage(content, commandInvocation, pending.taskId, attachments ?? [])
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        dispatch({
          type: 'ADD_MESSAGE',
          conversationId: conversation.id,
          message: {
            ...placeholder,
            content: [{ type: 'text', text: pending.stage === 'awaiting_summary_confirm' ? '🔍 Updating summary with your feedback...' : '🔍 Recording your answer...' }],
            streaming: true,
            runPhase: 'generating',
          },
        })

        const intake = await replyIntakeViaDaemon({ pending, content, conversation })
        const session = intake.session

        if (!intake.readyToPlan || !intake.finalGoal) {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: placeholder.id,
            patch: {
              content: [{ type: 'text', text: intake.messageText || '需求澄清状态已更新。' }],
              streaming: false,
              runPhase: intake.canceled ? 'completed' : 'completed',
            },
          })
          setPendingTaskIntake(intake.canceled || !session ? null : {
            conversationId: conversation.id,
            taskId: session.taskId,
            sessionId: session.sessionId,
            content: session.content,
            attachments: pending.attachments,
            commandInvocation: pending.commandInvocation,
            stage: session.stage === 'awaiting_summary_confirm' ? 'awaiting_summary_confirm' : 'clarifying',
          })
          return
        }

        const finalGoal = intake.finalGoal
        const confirmationContext = {
          id: `ctx_${pending.taskId}_confirmed`,
          taskId: pending.taskId,
          role: 'system' as const,
          content: [{ type: 'text' as const, text: makeConfirmedTaskPlanPrompt(finalGoal, conversation) }],
          createdAt: Date.now(),
        }
        const isBigTask = isCodingDesignBigTask(finalGoal)
        let taskPlan = undefined
        if (isBigTask) {
          const workingDirectory = intake.workingDirectory || conversation.folderPath || extractWorkingDirectoryFromText(finalGoal)
          if (!workingDirectory) {
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId: conversation.id,
              messageId: placeholder.id,
              patch: {
                content: [{
                  type: 'text',
                  text: '无法开始执行：这个大任务需要一个工作目录，但当前会话没有绑定 Active Folder，且请求里没有明确路径。请先把目标项目目录设为 Active Folder，或在请求里写清楚路径，例如 D:\\Apps\\TestProject。',
                }],
                streaming: false,
                runPhase: 'error',
              },
            })
            return
          }

          if (workingDirectory && workingDirectory !== conversation.folderPath) {
            dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path: workingDirectory })
          }

          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: placeholder.id,
            patch: {
              content: [{ type: 'text', text: '正在规划任务执行步骤...' }],
              streaming: false,
              runPhase: 'generating',
            },
          })

          taskPlan = await generateDaemonTaskPlan({
            conversationId: conversation.id,
            taskId: pending.taskId,
            goal: finalGoal,
            workingDirectory,
            traits: planningTraitsFor(finalGoal, conversation),
            analysis: intake.analysis
              ? { ...intake.analysis, unknowns: [] }
              : null,
            messages: conversation.messages,
          })

          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: placeholder.id,
            patch: { content: [], runPhase: 'connecting' }
          })
        }

        setPendingTaskIntake(null)
        if (taskPlan) {
          dispatch({ type: 'START_TASK_PLAN', conversationId: conversation.id, plan: taskPlan })
        }
        if (!isBigTask) {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: placeholder.id,
            patch: { content: [], runPhase: 'connecting' },
          })
        }
        driveStream(
          { ...conversation, activeTaskPlan: taskPlan, messages: [...conversation.messages, userMsg, confirmationContext] },
          conversation.id,
          placeholder.id,
          pending.taskId,
          taskPlan,
        )
        return
      }

      const inputDecision = await dispatchInputViaDaemon({
        content,
        commandInvocation,
        conversation,
        attachments: attachments ?? [],
      })

      if (!pendingTaskIntake && inputDecision.action === 'ask_clarifying_question') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        dispatch({
          type: 'ADD_MESSAGE',
          conversationId: conversation.id,
          message: makeCompletedAssistantMessage(
            taskId,
            '我不确定你想让我继续哪个具体任务。请说明目标和对象，例如：继续上一个 build、查看某个 URL、读取某个文件，或创建/修改哪个项目。',
          ),
        })
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'handle_url') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const url = extractUrlFromText(content)
        const urlContext = workflowSystemMessage(taskId, [
          'Workflow action: handle_url.',
          url ? `Detected URL: ${url}` : '',
          'Classify what the user wants to do with the URL before acting: open/preview local URL, diagnose refused connection or console errors, summarize/research remote URL, or explain what the URL points to.',
          'For local preview URLs, use preview.open/preview.console/preview.screenshot when relevant. For remote URLs without a browser/fetch tool, explain the limitation and ask for pasted content if needed.',
          'Do not start task intake unless the user explicitly asks to build or modify a project from this URL.',
        ].filter(Boolean).join(' '))

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...conversation, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), urlContext] },
          conversation.id,
          placeholder.id,
          taskId,
        )
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'handle_file_media') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const attachmentList = (attachments ?? []).map(path => `- ${path}`).join('\n') || '- (attachment metadata only)'
        const fileMediaContext = workflowSystemMessage(taskId, [
          'Workflow action: handle_file_media.',
          'The user input includes files, images, audio, video, documents, archives, or mixed attachments.',
          'Treat the attachments as first-class input. Do not ignore them and do not start coding task intake unless the user explicitly asks to create/modify a project.',
          'If a file can be inspected with available tools, inspect it before answering. If the model cannot view or transcribe a media type, state that limitation and ask for the needed content or a supported tool.',
          `Attachments:\n${attachmentList}`,
        ].join('\n'))

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...conversation, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), fileMediaContext] },
          conversation.id,
          placeholder.id,
          taskId,
        )
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'update_preference') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const preferenceContext = workflowSystemMessage(taskId, [
          'Workflow action: update_preference.',
          'The user is expressing a preference, default behavior, or setting.',
          'Do not treat this as a coding task. Determine whether this can be applied to the current conversation, an existing Settings field, or requires a new preference store.',
          'Be explicit about scope: current conversation, persisted setting, or not yet supported. Do not claim persistence unless a setting was actually changed.',
        ].join(' '))

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...conversation, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), preferenceContext] },
          conversation.id,
          placeholder.id,
          taskId,
        )
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'start_video_creation') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const videoOutputTarget = videoOutputTargetFor(content)
        const shouldSaveVideoAssets = videoOutputTarget === 'file_assets' && hasExplicitVideoAssetSaveRequest(content)
        const videoContext = workflowSystemMessage(taskId, [
          'Workflow action: start_video_creation.',
          'The user wants help creating a short-form video or video assets.',
          `Selected video output target: ${videoOutputTarget}.`,
          'Do not start coding task intake and do not claim an MP4/video file was generated.',
          'Use this output target policy: chat_draft means answer in chat with a practical V1 package; file_assets means write markdown/SRT asset files when a target folder is provided; remotion_project means ask for or confirm a target folder before starting a coding/project workflow; video_prompts means produce prompts for Sora/Runway/Kling/Veo-style tools; tts_voiceover means produce voiceover-ready text and ask before using any speech tool.',
          'First determine whether enough information exists for the selected output target. If one key detail is missing, ask only one question with concise options.',
          'If enough information exists, produce the selected output: target platform assumption, hook, 3-6 beat outline, storyboard/shot list, voiceover script, captions/subtitle draft, visual asset prompts, and optional next production paths.',
          shouldSaveVideoAssets
            ? [
                'The latest user request explicitly asks to save/export/write video assets.',
                'If no target folder or file path is specified, ask one concise question for the target folder before calling file tools.',
                'If a target folder/path is specified, create a small durable asset package with file.write_text. Prefer these files: script.md, storyboard.md, captions.srt, visual-prompts.md, production-notes.md.',
                'Do not write binary video/audio files. Do not claim a playable video was generated. After writing, report the created paths and any assumptions.',
              ].join(' ')
            : videoOutputTarget === 'remotion_project'
              ? [
                  'The latest user request selected a Remotion editable video project.',
                  'If no target folder or full Windows path is specified, ask one concise question for the target folder before calling tools.',
                  'If a target folder/path is specified, create or scaffold the Remotion project there.',
                  'Preferred scaffold: use shell.run_command with command "npx" and args ["create-video@latest","--yes","--blank","--no-tailwind", projectName] in the target parent folder, then write the video-specific composition files with file.write_text or file.patch.',
                  'If the scaffold command fails or cannot run safely, fall back to a minimal Remotion project by writing package.json, src/Root.tsx, src/Composition.tsx, src/index.ts, and README.md with file.write_text.',
                  'After project creation, run a non-long-running validation command such as npm run build when available, or report that install/build was not run. Do not start Remotion Studio unless the user asks for preview.',
                ].join(' ')
              : videoOutputTarget === 'video_prompts'
                ? [
                    'The latest user request selected Sora/Runway/Kling/Veo-style video prompt pack output.',
                    'If the user asks to save/export/write the prompt pack but no target folder/path is specified, ask one concise question for the target folder before calling file tools.',
                    'If a target folder/path is specified, write a durable prompt pack with file.write_text. Prefer these files: prompt-pack.md, sora-prompts.md, runway-prompts.md, kling-prompts.md, veo-prompts.md, shot-list.md.',
                    'Each platform prompt file should contain scene-by-scene prompts, duration/aspect ratio notes, camera motion, visual style, negative prompts or avoid-list, and continuity notes.',
                    'Do not call a real video generation API and do not claim a video was generated. After writing, report created paths and how to use the prompts.',
                  ].join(' ')
                : videoOutputTarget === 'tts_voiceover'
                  ? [
                      'The latest user request selected TTS/voiceover output.',
                      'Produce voiceover-ready text with timing, pacing, pronunciation notes, and optional SSML-style cues.',
                      'If the user asks to save/export/write the voiceover pack but no target folder/path is specified, ask one concise question for the target folder before calling file tools.',
                      'If a target folder/path is specified, write a durable voiceover pack with file.write_text. Prefer these files: voiceover-script.md, voiceover-ssml.xml, pronunciation-notes.md, captions.srt.',
                      'If the user explicitly asks for an audio file and a target output path/folder is known, call speech.tts_save with the final voiceover text. If only a folder is provided, use voiceover.wav in that folder.',
                      'Do not claim an MP3/WAV/audio file was generated unless speech.tts_save returns ok. If speech.tts_save fails because TTS is not configured, report the exact configuration gap and keep the text voiceover pack.',
                      'If the user only wants spoken preview, explain they can use Ava Speech playback when configured; do not save audio unless requested.',
                    ].join(' ')
                  : 'Mention available paths only as options: save script to files, generate a Remotion project, prepare Sora/video prompts, or use TTS/STT if enabled. Do not call those tools unless the user explicitly asks.',
        ].join(' '))

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...conversation, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), videoContext] },
          conversation.id,
          placeholder.id,
          taskId,
        )
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'delegate_to_code_agent') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })

        try {
          const result = await dispatchCodeAgentTaskViaDaemon({ content, conversation })
          const codeAgentSession = result.session
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: placeholder.id,
            patch: {
              content: [{ type: 'text', text: formatCodeAgentDispatchMessage(result) }],
              streaming: result.status === 'assigned' && Boolean(codeAgentSession) && !isCodeAgentTerminalStatus(codeAgentSession?.status),
              runPhase: result.status === 'assigned' ? 'generating' : 'error',
            },
          })
          if (result.status === 'assigned' && codeAgentSession) {
            await pollCodeAgentSessionUpdates({
              sessionId: codeAgentSession.sessionId,
              conversationId: conversation.id,
              messageId: placeholder.id,
              dispatch,
            })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: placeholder.id,
            patch: {
              content: [{
                type: 'text',
                text: [
                  'Code Agent Dispatcher 调用失败。',
                  '',
                  `错误：${message}`,
                  '',
                  '请确认 Ava Daemon 正在运行，然后重试。',
                ].join('\n'),
              }],
              streaming: false,
              runPhase: 'error',
            },
          })
        }
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'recover_task') {
        const plan = await getDaemonActiveTaskPlan(conversation.id).catch(() => undefined) ?? conversation.activeTaskPlan
        if (!plan || plan.status === 'completed' || plan.status === 'aborted') {
          await runSend(content, attachments ?? [], conversation, commandInvocation)
          return
        }

        const taskId = plan.taskId
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const retryPlan = plan
        const recoveryContext = workflowSystemMessage(taskId, [
          'Workflow action: recover_task.',
          'The user explicitly asked to retry or continue the interrupted task.',
          'Resume from the current TaskExecutionPlan and existing project state.',
          'Do not restart from scratch. Inspect current files or process state only if needed.',
        ].join(' '))

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...conversation, activeTaskPlan: retryPlan, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), recoveryContext] },
          conversation.id,
          placeholder.id,
          taskId,
          retryPlan,
        )
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'handle_permission') {
        const blockedCodeAgent = await findBlockedCodeAgentSessionForConversation(conversation.id).catch(() => undefined)
        if (blockedCodeAgent && !isPermissionDeny(content)) {
          const taskId = makeTaskId()
          const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
          const placeholder = makeAssistantPlaceholder(taskId)

          dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
          dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })

          try {
            const session = await sendCodeAgentSessionMessageViaDaemon({
              sessionId: blockedCodeAgent.sessionId,
              message: content,
            })
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId: conversation.id,
              messageId: placeholder.id,
              patch: {
                content: [{ type: 'text', text: formatCodeAgentSessionMessage(session, '已把你的回复发送给等待输入的 Code Agent。') }],
                streaming: !isCodeAgentTerminalStatus(session.status),
                runPhase: isCodeAgentTerminalStatus(session.status) ? 'completed' : 'generating',
              },
            })
            await pollCodeAgentSessionUpdates({
              sessionId: session.sessionId,
              conversationId: conversation.id,
              messageId: placeholder.id,
              dispatch,
            })
          } catch (err) {
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId: conversation.id,
              messageId: placeholder.id,
              patch: {
                content: [{ type: 'text', text: `发送给 Code Agent 失败：${err instanceof Error ? err.message : String(err)}` }],
                streaming: false,
                runPhase: 'error',
              },
            })
          }
          return
        }

        const existingPlan = await getDaemonActiveTaskPlan(conversation.id).catch(() => undefined) ?? conversation.activeTaskPlan
        const taskId = existingPlan?.taskId ?? makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })

        if (isPermissionDeny(content)) {
          dispatch({
            type: 'ADD_MESSAGE',
            conversationId: conversation.id,
            message: {
              id: makeMessageId(),
              taskId,
              role: 'assistant',
              content: [{ type: 'text', text: '已拒绝该权限请求。Ava 不会继续执行依赖该权限的操作。' }],
              streaming: false,
              runPhase: 'completed',
              createdAt: Date.now(),
            },
          })
          return
        }

        const grantedPath = extractWorkingDirectoryFromText(content)
        const retryPlan = existingPlan
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const nextConversation = grantedPath
          ? { ...conversation, folderPath: grantedPath }
          : conversation
        const permissionContext = workflowSystemMessage(taskId, [
          'Workflow action: handle_permission.',
          'The user granted permission or access needed by the previous blocked operation.',
          grantedPath ? `Approved working directory/path: ${grantedPath}` : '',
          'Continue only the operation that was blocked by this permission. If no blocked operation exists, explain what permission was recorded.',
        ].filter(Boolean).join(' '))

        if (grantedPath) {
          dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path: grantedPath })
        }
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...nextConversation, activeTaskPlan: retryPlan, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), permissionContext] },
          conversation.id,
          placeholder.id,
          taskId,
          retryPlan,
        )
        return
      }

      if (!pendingTaskIntake && inputDecision.action === 'run_direct_tool') {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const placeholder = makeAssistantPlaceholder(taskId)
        const directToolContext = workflowSystemMessage(taskId, [
          'Workflow action: run_direct_tool.',
          'This is a small direct task. Do not start requirement intake or create a multi-step plan.',
          'Use the smallest necessary tool calls, then answer with the observed result. If a required path or permission is missing, ask for that exact missing input.',
        ].join(' '))

        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: previewMsg })
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        await driveStream(
          { ...conversation, messages: [...maybeWithPreview([...conversation.messages, userMsg], previewMsg), directToolContext] },
          conversation.id,
          placeholder.id,
          taskId,
        )
        return
      }

      if (!pendingTaskIntake && (inputDecision.action === 'start_task_intake' || inputDecision.classification?.requiresTaskIntake)) {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const previewMsg = makeActionPreviewMessage(taskId, inputDecision)
        const intakeMsg = makeAssistantPlaceholder(taskId)
        const conversationId = conversation.id

        dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
        if (previewMsg) dispatch({ type: 'ADD_MESSAGE', conversationId, message: previewMsg })
        dispatch({
          type: 'ADD_MESSAGE',
          conversationId,
          message: {
            ...intakeMsg,
            content: [{ type: 'text', text: '🔍 Analyzing project constraints...' }],
            streaming: true,
            runPhase: 'generating',
          },
        })

        if (conversation.messages.length === 0) {
          const title = content.length > 30 ? `${content.slice(0, 30)}…` : content
          dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
          const initialTraits = detectTraitsFromText(content)
          if (initialTraits.length > 0 && initialTraits[0] !== 'chat') {
            dispatch({ type: 'SET_TRAITS', id: conversationId, traits: initialTraits })
          }
        }
        
        const intake = await startIntakeViaDaemon({
          conversationId,
          taskId,
          content,
          conversation,
          attachments: attachments ?? [],
          commandInvocation,
        })
        const session = intake.session
        const finalContent: ContentPart[] = [{
          type: 'text',
          text: intake.messageText || '⚠️ Agent OS Pre-Flight Analysis failed.',
        }]

        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId: intakeMsg.id,
          patch: {
            content: finalContent,
            streaming: false,
            runPhase: 'completed',
          }
        })

        if (session) {
          setPendingTaskIntake({
            conversationId,
            taskId,
            sessionId: session.sessionId,
            content: session.content,
            attachments: attachments ?? [],
            commandInvocation,
            stage: session.stage === 'awaiting_summary_confirm' ? 'awaiting_summary_confirm' : 'clarifying',
          })
        }
        return
      }

      runSend(content, attachments ?? [], conversation, commandInvocation)
    },
    [activeConversation, createConversation, dispatch, driveStream, editDraft, pendingTaskIntake, runEditedResend, runSend],
  )

  const handleStop = useCallback(() => {
    if (streamId) {
      const lastAssistantId = activeConversation ? lastStreamingAssistant(activeConversation) : null
      if (activeConversation && lastAssistantId) {
        dispatch({
          type: 'ABORT_RUNNING_PARTS',
          conversationId: activeConversation.id,
          messageId: lastAssistantId,
        })
        dispatch({ type: 'ABORT_TASK_PLAN', conversationId: activeConversation.id })
        void clearDaemonActiveTaskPlan(activeConversation.id).catch(err => {
          console.warn('[task-plan] failed to clear daemon plan:', err)
        })
      }
      window.ava.llm.abort(streamId).catch(() => { /* noop */ })
    }
  }, [activeConversation, dispatch, streamId])

  const handleDeleteMessage = useCallback(
    (id: string) => {
      if (!activeConversation) return
      dispatch({ type: 'DELETE_MESSAGE', conversationId: activeConversation.id, messageId: id })
    },
    [activeConversation, dispatch],
  )

  const handleNewConversation = useCallback(() => {
    createConversation()
  }, [createConversation])


  const handleDeleteConversation = useCallback(() => {
    if (!activeConversation) return
    dispatch({ type: 'DELETE_CONVERSATION', id: activeConversation.id })
  }, [activeConversation, dispatch])

  const handleOpenPreview = useCallback(async () => {
    await window.ava.window.openPreview(state.settings.theme)
    if (!activeConversation) return

    const lastAssistantMessage = [...activeConversation.messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistantMessage) return

    const text = partsToText(lastAssistantMessage.content)
    const htmlMatch = text.match(/```(?:html|svg)\s*([\s\S]*?)\s*```/i) ||
                      text.match(/<(html|svg)[\s\S]*?<\/\1>/i) ||
                      text.match(/<svg[\s\S]*?>[\s\S]*/i)

    if (htmlMatch) {
      const htmlContent = htmlMatch[1] || htmlMatch[0]
      setTimeout(() => {
        window.ava.window.updatePreview(htmlContent)
      }, 800)
    }
  }, [activeConversation, state.settings.theme])

  const handleOpenSettings = useCallback(() => {
    dispatch({ type: 'SET_VIEW', view: 'settings' })
  }, [dispatch])

  const handleToggleSidebar = useCallback(() => {
    dispatch({ type: 'SET_SIDEBAR', open: !state.sidebarOpen })
  }, [dispatch, state.sidebarOpen])

  const activeTraitSuggestion = traitSuggestion && traitSuggestion.conversationId === activeConversation?.id
    ? traitSuggestion.trait
    : undefined

  const acceptTraitSuggestion = useCallback(() => {
    if (!activeConversation || !activeTraitSuggestion) return
    dispatch({ type: 'SET_TRAITS', id: activeConversation.id, traits: [activeTraitSuggestion] })
    setTraitSuggestion(null)
  }, [activeConversation, activeTraitSuggestion, dispatch])

  const dismissTraitSuggestion = useCallback(() => {
    if (!activeConversation || !activeTraitSuggestion) return
    setDismissedTraitSuggestions(prev => ({ ...prev, [activeConversation.id]: activeTraitSuggestion }))
    setTraitSuggestion(null)
  }, [activeConversation, activeTraitSuggestion])

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    // Only set dragging false if we actually leave the container (not entering a child)
    if (e.currentTarget === e.target) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setDroppedFiles(files)
      // Reset after a tick to allow PromptInput to see the change
      setTimeout(() => setDroppedFiles([]), 100)
    }
  }

  const handleRetry = useCallback(
    async (failedId: string) => {
      if (!activeConversation || isStreaming) return
      const msgs = activeConversation.messages
      const idx = msgs.findIndex(m => m.id === failedId)
      if (idx < 0) return
      const target = msgs[idx]
      if (
        target.role !== 'assistant' ||
        (!target.error && !target.aborted && !hasFailedToolCall(activeConversation, failedId))
      ) return
      // Only allow retrying the last message, to avoid desynchronizing later turns.
      if (idx !== msgs.length - 1) return

      const conversationId = activeConversation.id
      dispatch({ type: 'DELETE_MESSAGE', conversationId, messageId: failedId })

      const previousUser = (() => {
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (msgs[i].role === 'user') return msgs[i]
        }
        return null
      })()
      const taskId = target.taskId ?? previousUser?.taskId ?? makeTaskId()
      const placeholder = makeAssistantPlaceholder(taskId)
      const retryMessages = msgs.slice(0, idx)
      if (target.error?.includes('output token limit')) {
        retryMessages.push({
          id: `ctx_${taskId}_continue_after_output_limit`,
          taskId,
          role: 'system',
          content: [{
            type: 'text',
            text: [
              'The previous assistant attempt stopped because the output token limit was reached.',
              'Continue the same task from the existing project/file state.',
              'Do not restart from scratch and do not repeat already-written code.',
              'Inspect existing files if needed, then complete the next smallest remaining step.',
            ].join(' '),
          }],
          createdAt: Date.now(),
        })
      }
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })
      const retryPlan = await getDaemonActiveTaskPlan(conversationId).catch(() => undefined) ?? activeConversation.activeTaskPlan

      await driveStream(
        { ...activeConversation, activeTaskPlan: retryPlan, messages: retryMessages },
        conversationId,
        placeholder.id,
        taskId,
        retryPlan,
      )
    },
    [activeConversation, isStreaming, dispatch, driveStream],
  )

  const handleCommandRetry = useCallback(
    async (messageId: string) => {
      if (!activeConversation || isStreaming) return
      const message = activeConversation.messages.find(m => m.id === messageId)
      if (!message || message.role !== 'user' || !message.commandInvocation) return
      const content = partsToText(message.content)
      if (!content.trim()) return
      await runSend(content, [], activeConversation, message.commandInvocation)
    },
    [activeConversation, isStreaming, runSend],
  )

  const handleEditResend = useCallback(
    (messageId: string) => {
      if (!activeConversation || isStreaming) return
      const idx = activeConversation.messages.findIndex(m => m.id === messageId)
      if (idx < 0) return
      const message = activeConversation.messages[idx]
      if (message.role !== 'user') return

      const currentText = partsToText(message.content)
      if (!currentText.trim()) return
      setEditDraft({ messageId, text: currentText })
    },
    [activeConversation, isStreaming],
  )

  const messages = (activeConversation?.messages ?? []).filter(m => {
    // Skip ghost assistant messages: empty content, not streaming, no error/abort
    if (
      m.role === 'assistant' &&
      !m.streaming &&
      !m.error &&
      !m.aborted &&
      m.content.length === 0
    ) return false
    return true
  })
  const showEmpty = !activeConversation || messages.length === 0

  return (
    <div 
      className="flex flex-col flex-1 min-h-0 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ChatSessionBar
        conversation={activeConversation}
        suggestedTrait={activeTraitSuggestion}
        onAcceptTraitSuggestion={acceptTraitSuggestion}
        onDismissTraitSuggestion={dismissTraitSuggestion}
        onOpenPreview={handleOpenPreview}
        onDelete={activeConversation ? handleDeleteConversation : undefined}
      />

      {/* Top Blur Overlay */}
      <div className="absolute top-10 left-0 right-0 h-8 z-20 pointer-events-none bg-gradient-to-b from-bg/80 via-bg/40 to-transparent backdrop-blur-md [mask-image:linear-gradient(to_bottom,black,transparent)]" />

      {/* Task plan now lives exclusively in the right panel. */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bg/80 backdrop-blur-sm border-2 border-dashed border-accent m-4 rounded-3xl pointer-events-none transition-all animate-in fade-in zoom-in duration-200">
          <div className="w-20 h-20 bg-accent/10 rounded-full flex items-center justify-center text-accent mb-4">
            <Upload size={32} className="animate-bounce" />
          </div>
          <div className="text-xl font-medium text-text">{t('chat.drop_to_upload', 'Drop to upload files')}</div>
          <div className="text-sm text-text-3 mt-1">{t('chat.drop_types', 'Images, documents, code, etc.')}</div>
        </div>
      )}

      <div
        ref={scrollRef}
        className="relative z-0 flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col no-scrollbar-x"
      >
        {showEmpty ? (
          <EmptyState
            userName={state.settings.persona.userName}
            onPick={content => handleSend(content)}
            disabled={!hasProvider}
          />
        ) : (
          <div className="pt-4 pb-0">
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1
              const canRetry =
                isLast &&
                m.role === 'assistant' &&
                !m.streaming &&
                (Boolean(m.error) || Boolean(m.aborted) || (m.runPhase !== 'completed' && hasFailedToolCall(activeConversation, m.id)))
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  userInitial={userInitial}
                  assistantInitial={assistantInitial}
                  onDelete={handleDeleteMessage}
                  onRetry={canRetry ? () => handleRetry(m.id) : undefined}
                  onCommandRetry={
                    !isStreaming && m.role === 'user' && m.commandInvocation
                      ? () => handleCommandRetry(m.id)
                      : undefined
                  }
                  onEditResend={!isStreaming && m.role === 'user' ? () => handleEditResend(m.id) : undefined}
                  isLast={isLast}
                  onQuickReply={(text) => handleSend(text)}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Bottom Blur Overlay */}
      <div className="relative">
        <div className="absolute -top-8 left-0 right-0 h-8 z-20 pointer-events-none bg-gradient-to-t from-bg/80 via-bg/40 to-transparent backdrop-blur-md [mask-image:linear-gradient(to_top,black,transparent)]" />
        <PromptInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={!hasProvider}
          disabledReason={!hasProvider ? t('chat.no_provider_error', 'Please configure and enable LLM in settings') : undefined}
          commands={commands}
          commandsLoading={commandsLoading}
          onRefreshCommands={refreshCommands}
          voiceEnabled={isSpeechEnabled(state.settings)}
          isRecording={isRecording}
          onSttToggle={toggleStt}
          sttText={sttText}
          externalDroppedFiles={droppedFiles}
          contextUsage={contextUsage}
          editDraft={editDraft ? { id: editDraft.messageId, text: editDraft.text } : undefined}
          onCancelEditDraft={() => setEditDraft(null)}
        />
      </div>
    </div>
  )
}
