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
  planningContextBudgetForProviders,
  sendChat,
} from '../lib/agent/chat'
import { getEnabledProviders } from '../lib/llm/providers'
import { shouldBlockLargeTaskWithoutPlan } from '../lib/agent/taskExecutionPolicy'
import { STTClient } from '../lib/voiceClient'
import { detectTraitsFromText } from '../lib/agent/traits'
import {
  blockPlan,
  completePlan,
  createCodingDesignTaskPlan,
  generateDynamicTaskPlan,
  evaluateStepCompletion,
  extractWorkingDirectoryFromText,
  finalValidationGateSatisfied,
  isCodingDesignBigTask,
  markStepDone,
  markStepRunning,
  markStepSkipped,
  nextTaskStep,
  recoverStepFromRound,
  updatePlanValidation,
  withValidation,
} from '../lib/agent/taskExecution'
import {
  shouldContinueAfterToolLimit,
  toolProgressContinuationText,
} from '../lib/agent/runtime/agentRuntime'
import { runAnalyzePhase } from '../lib/agent/roles/planner'
import type { CommandInvocation, ContentPart, Conversation, InitiativeTrait, Message, PluginCommand, TaskExecutionPlan, ProjectAnalysis } from '../types'

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
  content: string
  attachments: string[]
  commandInvocation?: CommandInvocation
  analysis?: ProjectAnalysis
  stage?: 'clarifying' | 'awaiting_summary_confirm'
  clarificationAnswers?: Array<{ question: string; answer: string }>
}

const TASK_INTAKE_INTENT_RE = /\b(build|create|make|generate|implement|fix|debug|refactor|modify|update|edit|write|add|remove|delete|site|app|component|page|feature|bug|code|html|css|javascript|typescript|react|three\.?js|3d)\b|创建|生成|实现|修复|调试|重构|修改|更新|添加|删除|网站|应用|组件|页面|功能|代码|三维|3d/i
const LARGE_TASK_INTENT_RE = /\b(3d|three\.?js|animation|animated|site|website|landing page|app|full app|project|professional|production ready|complete|responsive|dashboard|frontend|ui|ux|migrate|refactor|implement feature|create|build|generate)\b|三维|动画|网站|站点|落地页|应用|完整|专业|响应式|前端|界面|迁移|重构|项目/i
const ENGLISH_CONFIRM_TASK_RE = /^(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run)\b/i
const CHINESE_CONFIRM_TASK_RE = /^(执行|开始|继续|确认|可以|好的|好|没问题|就这样)$/i
const FEATURE_TEST_RE = /^\s*\[AVA-FEATURE-TEST:([A-Za-z0-9_.-]+)\]/i
const MAX_AUTO_CONTINUE_ROUNDS = 3
const MAX_TASK_ENGINE_ROUNDS = 24

function latestUserTextForTask(conversation: Conversation, taskId: string): string {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'system' && message.taskId === taskId) {
      const match = partsToText(message.content).match(/^Task:\s*([\s\S]*?)(?:\nWorking directory:|\nIf interrupted,|$)/m)
      if (match?.[1]?.trim()) return match[1].trim()
    }
  }
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'user' && (!message.taskId || message.taskId === taskId)) {
      return partsToText(message.content)
    }
  }
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'user') return partsToText(message.content)
  }
  return ''
}

function canRebindTaskPlan(plan: TaskExecutionPlan, taskId: string, goal: string, workingDirectory?: string): boolean {
  if (plan.taskId === taskId) return true
  if (plan.status === 'completed' || plan.status === 'aborted') return false
  if (workingDirectory && plan.workingDirectory !== workingDirectory) return false
  return isCodingDesignBigTask(goal) && plan.kind === 'coding-design'
}

function retryableTaskPlan(plan: TaskExecutionPlan | undefined, taskId: string): TaskExecutionPlan | undefined {
  if (!plan || plan.taskId !== taskId || plan.status !== 'blocked') return plan
  const failedStep = plan.steps.find(step => step.status === 'failed' || step.status === 'running')
  if (!failedStep) return { ...plan, status: 'running', updatedAt: Date.now() }

  return {
    ...plan,
    status: 'running',
    currentStepId: failedStep.id,
    steps: plan.steps.map(step =>
      step.id === failedStep.id
        ? { ...step, status: 'pending', lastError: undefined }
        : step
    ),
    updatedAt: Date.now(),
  }
}

function shouldRequireTaskIntake(content: string, commandInvocation?: CommandInvocation): boolean {
  if (commandInvocation) return true
  return TASK_INTAKE_INTENT_RE.test(content)
}

function isTaskConfirmation(content: string): boolean {
  const normalized = content.trim().replace(/[.!?。！？,，;；:：\s]+$/g, '')
  return ENGLISH_CONFIRM_TASK_RE.test(normalized) || CHINESE_CONFIRM_TASK_RE.test(normalized)
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

function makeContinuationMessages(taskId: string, parts: ContentPart[], stopReason: string, round: number): Message[] {
  const assistant: Message = {
    id: makeMessageId(),
    taskId,
    role: 'assistant',
    content: parts,
    createdAt: Date.now(),
  }
  const instruction: Message = {
    id: makeMessageId(),
    taskId,
    role: 'system',
    content: [{
      type: 'text',
      text: [
        `Automatic continuation round ${round}.`,
        `Previous attempt stopped because: ${stopReason}.`,
        'Continue the same task from the existing project/file state.',
        'Do not restart from scratch and do not repeat completed work.',
        'Inspect files or run project.detect/search.ripgrep if needed, then complete the next smallest remaining step.',
        'Before final reporting on a coding/design task, validate with project.validate or an equivalent command when available.',
        'Final report must state changed files, validation result, and any unverified risk. If validation was not possible, say why.',
      ].join('\n'),
    }],
    createdAt: Date.now(),
  }
  return [assistant, instruction]
}

function stopReasonText(stopReason: string): string {
  if (stopReason === 'output_limit') return 'output token limit reached'
  if (stopReason === 'server_disconnected') return 'model server disconnected'
  if (stopReason === 'tool_loop_limit') return 'tool loop limit reached'
  if (stopReason === 'raw_command_no_tool') return 'model output raw command instead of tool call'
  return stopReason
}

function recentToolSummary(parts: ContentPart[], count = 5): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
    .slice(-count)
    .map(part => {
      const args = JSON.stringify(part.args).slice(0, 180)
      const result = part.status === 'ok'
        ? `ok: ${JSON.stringify(part.result).slice(0, 220)}`
        : part.error ?? part.status
      return `- ${part.name}(${args}): ${result}`
    })
    .join('\n')
}

function toolProgressContinuationMessage(taskId: string, stepTitle: string, parts: ContentPart[]): Message {
  return {
    id: makeMessageId(),
    taskId,
    role: 'system',
    content: [{ type: 'text', text: toolProgressContinuationText(stepTitle, parts) }],
    createdAt: Date.now(),
  }
}

function toolLoopUserMessage(parts: ContentPart[], taskStepTitle?: string): string {
  const recent = recentToolSummary(parts)
  return [
    'Stopped: tool loop limit exceeded.',
    taskStepTitle ? `Current step: ${taskStepTitle}` : '',
    '',
    'Ava stopped because the model kept using tools without reaching a stable next state. I did not keep executing commands to avoid an infinite loop or repeated filesystem changes.',
    '',
    recent ? `Recent tool calls:\n${recent}` : 'Recent tool calls: none recorded.',
    '',
    'What you can try:',
    '1. Click 「Inspect project state」 so Ava reads the current files before trying more changes.',
    '2. Click 「Retry with smaller step」 to ask Ava to do only the current missing action.',
    '3. If a command or dev server is stuck, stop the dev server and retry.',
    '4. If the same tool keeps failing, switch to a model with better tool-call support.',
    '',
    'Options: 「Inspect project state」 「Retry with smaller step」 「Stop task」',
  ].filter(Boolean).join('\n')
}

function taskRoundSummary(stepTitle: string, parts: ContentPart[]): string {
  const toolSummaries = parts
    .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
    .map(part => {
      const payload = part.status === 'ok'
        ? JSON.stringify(part.result).slice(0, 1800)
        : part.error ?? part.status
      return `- ${part.name}: ${part.status}${payload ? `\n  ${payload}` : ''}`
    })
  const text = partsToText(parts).trim()
  return [
    `Completed execution round for step: ${stepTitle}`,
    text ? `Visible assistant text:\n${text.slice(0, 1200)}` : '',
    toolSummaries.length > 0 ? `Tool results:\n${toolSummaries.join('\n')}` : 'No tool result was produced.',
  ].filter(Boolean).join('\n\n')
}

function finalReportRetryPrompt(parts: ContentPart[]): string {
  return [
    'The previous response did not complete the final report.',
    'Write the final visible report now. Do not call tools unless a required fact is missing. Do not explain what you will do next.',
    'Required sections: Changed files, Validation result, Preview result, Remaining risks.',
    taskRoundSummary('Final Report', parts),
  ].join('\n\n')
}

function roundHasFileEdit(parts: ContentPart[]): boolean {
  return parts.some(part =>
    part.type === 'tool_call' &&
    part.status === 'ok' &&
    (part.name === 'file.write_text' || part.name === 'file.patch')
  )
}

function featureStepRetryPrompt(stepTitle: string, parts: ContentPart[]): string {
  return [
    `The previous response did not implement feature step: ${stepTitle}.`,
    'This step requires a file edit. Reading or detecting the project is not enough.',
    'Call file.write_text or file.patch now. If you cannot edit, explain the exact blocker visibly instead of calling more inspection tools.',
    taskRoundSummary(stepTitle, parts),
  ].join('\n\n')
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
              onClick={() => window.ava.shell.openPath(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={folderPath}
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.ava.shell.openInVSCode(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.open_code', 'Open in VS Code')}
            >
              <Code size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.ava.shell.openInTerminal(folderPath)}
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
      const fileList = await window.ava.fs.listDir(folder)
      const files = fileList.map(f => f.name)
      
      let tasksDone = 0
      let tasksTotal = 0
      try {
        const tasksMd = await window.ava.fs.readFile(`${folder}/TASKS.md`)
        const lines = tasksMd.split('\n')
        lines.forEach(line => {
          if (line.includes('[ ]') || line.includes('[x]')) {
            tasksTotal++
            if (line.includes('[x]')) tasksDone++
          }
        })
      } catch { /* TASKS.md might not exist yet */ }

      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief: { tasksDone, tasksTotal, files } })
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
    if (!state.settings.voice?.enabled) return

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
  }, [isRecording, sttClient, state.settings.voice])

  // Tell STT server when bot is speaking for echo cancellation
  useEffect(() => {
    if (sttClient && isStreaming) {
      sttClient.sendBotState(true)
    } else if (sttClient && !isStreaming) {
      sttClient.sendBotState(false)
    }
  }, [isStreaming, sttClient])

  // Shared streaming driver. `conversationSnapshot.messages` is the full history
  // that should be sent to the LLM (NOT including the placeholder).
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
      let currentSnapshot = conversationSnapshot
      let accumulatedParts: ContentPart[] = []
      let continuationRound = 0
      let taskPlan = initialTaskPlan ?? conversationSnapshot.activeTaskPlan
      const latestTaskText = latestUserTextForTask(conversationSnapshot, activeTaskId)
      const isLargeTaskRun = isCodingDesignBigTask(latestTaskText)
      const workingDirectory = conversationSnapshot.folderPath || extractWorkingDirectoryFromText(latestTaskText)
      if (taskPlan?.taskId !== activeTaskId) {
        taskPlan = taskPlan && canRebindTaskPlan(taskPlan, activeTaskId, latestTaskText, workingDirectory)
          ? { ...taskPlan, taskId: activeTaskId, goal: latestTaskText || taskPlan.goal, updatedAt: Date.now() }
          : undefined
      }
      if (isLargeTaskRun && !taskPlan && workingDirectory) {
        taskPlan = createCodingDesignTaskPlan({
          taskId: activeTaskId,
          goal: latestTaskText,
          workingDirectory,
        })
        dispatch({ type: 'START_TASK_PLAN', conversationId, plan: taskPlan })
      }
      if (taskPlan?.status === 'blocked') {
        const error = `Task plan is blocked: ${taskPlan.steps.find(step => step.status === 'failed')?.lastError ?? 'no recovery step is available.'}`
        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId: placeholderId,
          patch: { streaming: false, error, runPhase: 'error' },
        })
        setIsStreaming(false)
        return
      }
      const planDecision = shouldBlockLargeTaskWithoutPlan({
        isLargeTask: isLargeTaskRun,
        hasTaskPlan: Boolean(taskPlan),
        hasActiveStep: Boolean(taskPlan ? nextTaskStep(taskPlan) : null),
      })
      if (planDecision.block) {
        const error = planDecision.reason ?? 'Large task execution requires an active task plan.'
        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId: placeholderId,
          patch: { streaming: false, error, runPhase: 'error' },
        })
        setIsStreaming(false)
        return
      }
      let taskEngineRound = 0
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

      try {
        while (true) {
          const activeStep = taskPlan ? nextTaskStep(taskPlan) : null
          if (taskPlan && !activeStep) {
            taskPlan = completePlan(taskPlan)
            dispatch({ type: 'COMPLETE_TASK_PLAN', conversationId, plan: taskPlan })
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { streaming: false, runPhase: 'completed', taskStepTitle: undefined },
            })
            break
          }
          if (taskPlan && activeStep) {
            taskPlan = markStepRunning(taskPlan, activeStep.id)
            dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan: taskPlan })
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { taskStepTitle: activeStep.title },
            })
          }
          const streamId = continuationRound === 0 ? id : makeStreamId()
          const roundStartPartIndex = accumulatedParts.length
          setStreamId(streamId)
          const result = await sendChat({
            conversation: currentSnapshot,
            settings: state.settings,
            projectBrief,
            folderPath: currentSnapshot.folderPath,
            streamId,
            activeTaskId,
            activeTaskPlan: taskPlan,
            activeStep: activeStep ?? undefined,
            finalReportAllowed: activeStep && taskPlan && (activeStep.role === 'final_report' || activeStep.id === 'final_report')
              ? finalValidationGateSatisfied(taskPlan.validation, taskPlan)
              : false,
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
          })

          if (result.ok) {
            accumulatedParts = mergeAuthoritativeParts(accumulatedParts, result.parts, activeTaskId)
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { content: accumulatedParts },
            })
          }
          const currentRoundParts = result.ok ? accumulatedParts.slice(roundStartPartIndex) : []

          if (taskPlan && activeStep && result.ok) {
            const roundParts = currentRoundParts
            taskPlan = recoverStepFromRound(taskPlan, activeStep.id, roundParts, result.fullContent)
            taskPlan = withValidation(taskPlan, updatePlanValidation(taskPlan, roundParts, activeStep))
            dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan: taskPlan })
            dispatch({ type: 'UPDATE_TASK_VALIDATION', conversationId, validation: taskPlan.validation })
            const evaluation = evaluateStepCompletion({
              plan: taskPlan,
              step: activeStep,
              parts: roundParts,
              fullContent: result.fullContent,
            })
            if (evaluation.complete) {
              taskPlan = markStepDone(taskPlan, activeStep.id)
              dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan: taskPlan })
              if (activeStep.id === 'final_report') {
                taskPlan = completePlan(taskPlan)
                dispatch({ type: 'COMPLETE_TASK_PLAN', conversationId, plan: taskPlan })
              } else if (taskEngineRound < MAX_TASK_ENGINE_ROUNDS) {
                taskEngineRound += 1
                currentSnapshot = {
                  ...conversationSnapshot,
                  activeTaskPlan: taskPlan,
                  messages: [
                    ...currentSnapshot.messages,
                    {
                      id: makeMessageId(),
                      taskId: activeTaskId,
                      role: 'system',
                      content: [{ type: 'text', text: taskRoundSummary(activeStep.title, roundParts) }],
                      createdAt: Date.now(),
                    },
                  ],
                }
                continue
              }
            } else if (evaluation.blocked) {
              taskPlan = blockPlan(taskPlan, activeStep.id, evaluation.blocked)
              dispatch({ type: 'BLOCK_TASK_PLAN', conversationId, plan: taskPlan })
              dispatch({
                type: 'UPDATE_MESSAGE',
                conversationId,
                messageId: placeholderId,
                patch: { streaming: false, error: evaluation.blocked, runPhase: 'error' },
              })
              await logFeatureTest({ status: 'failed', message: evaluation.blocked, fullContent: result.fullContent })
              return
            } else if (evaluation.needsRepair && taskEngineRound < MAX_TASK_ENGINE_ROUNDS) {
              // Validate failed with build errors → rewind the repair step so it runs again
              taskEngineRound += 1
              const repairStep = {
                id: 'repair',
                title: 'Repair validation or tool execution errors',
                status: 'pending' as const,
                requiredTools: ['file.patch', 'file.write_text', 'shell.run_command', 'project.map', 'file.read_text', 'file.list_dir', 'file.stat'],
                completionSignals: ['errors repaired'],
                attempts: 0,
                role: 'repair' as const,
                workflowType: 'debug' as const,
                lastError: evaluation.needsRepair,
                lastToolSummary: evaluation.needsRepair,
              }
              const hasRepairStep = taskPlan.steps.some(s => s.id === 'repair')
              taskPlan = {
                ...taskPlan,
                steps: hasRepairStep
                  ? taskPlan.steps.map(s =>
                    s.id === 'repair'
                      ? {
                          ...s,
                          status: 'pending',
                          attempts: 0,
                          requiredTools: ['file.patch', 'file.write_text', 'shell.run_command', 'project.map', 'file.read_text', 'file.list_dir', 'file.stat'],
                          lastError: evaluation.needsRepair,
                          lastToolSummary: evaluation.needsRepair,
                        }
                      : s
                  )
                  : [
                    ...taskPlan.steps.slice(0, taskPlan.steps.findIndex(s => s.id === activeStep.id)),
                    repairStep,
                    ...taskPlan.steps.slice(taskPlan.steps.findIndex(s => s.id === activeStep.id)),
                  ],
                currentStepId: 'repair',
                updatedAt: Date.now(),
              }
              dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan: taskPlan })
              currentSnapshot = {
                ...conversationSnapshot,
                activeTaskPlan: taskPlan,
                messages: [
                  ...currentSnapshot.messages,
                  {
                    id: makeMessageId(),
                    taskId: activeTaskId,
                    role: 'system',
                    content: [{ type: 'text', text: [
                      '🔧 Validation failed. Routing back to repair step.',
                      evaluation.needsRepair,
                      'Fix the errors above, then validate will re-run automatically.',
                    ].join('\n\n') }],
                    createdAt: Date.now(),
                  },
                ],
              }
              continue
            } else if (taskEngineRound < MAX_TASK_ENGINE_ROUNDS) {
              taskEngineRound += 1
              const retryText = activeStep.id === 'final_report' || activeStep.role === 'final_report'
                ? finalReportRetryPrompt(roundParts)
                : activeStep.role === 'feature' && !roundHasFileEdit(roundParts)
                  ? featureStepRetryPrompt(activeStep.title, roundParts)
                : taskRoundSummary(activeStep.title, roundParts)
              currentSnapshot = {
                ...conversationSnapshot,
                activeTaskPlan: taskPlan,
                messages: [
                  ...currentSnapshot.messages,
                  {
                    id: makeMessageId(),
                    taskId: activeTaskId,
                    role: 'system',
                    content: [{ type: 'text', text: retryText }],
                    createdAt: Date.now(),
                  },
                ],
              }
              continue
            } else {
              const error = `Task execution stopped after ${MAX_TASK_ENGINE_ROUNDS} automatic step round(s). Current step did not complete: ${activeStep.title}.`
              taskPlan = blockPlan(taskPlan, activeStep.id, error)
              dispatch({ type: 'BLOCK_TASK_PLAN', conversationId, plan: taskPlan })
              dispatch({
                type: 'UPDATE_MESSAGE',
                conversationId,
                messageId: placeholderId,
                patch: { streaming: false, error, runPhase: 'error' },
              })
              await logFeatureTest({ status: 'failed', message: error, fullContent: result.fullContent })
              return
            }
          }

          if (result.ok) {
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
            if (result.stopReason) {
              if (
                result.stopReason === 'tool_loop_limit' &&
                shouldContinueAfterToolLimit(currentRoundParts, activeStep ?? undefined) &&
                taskEngineRound < MAX_TASK_ENGINE_ROUNDS
              ) {
                taskEngineRound += 1
                currentSnapshot = {
                  ...conversationSnapshot,
                  activeTaskPlan: taskPlan,
                  messages: [
                    ...currentSnapshot.messages,
                    { id: makeMessageId(), taskId: activeTaskId, role: 'assistant', content: accumulatedParts, createdAt: Date.now() },
                    toolProgressContinuationMessage(activeTaskId, activeStep?.title ?? 'current task', currentRoundParts),
                  ],
                }
                continue
              }

              // ── Tool loop: inject a "break the loop" message and give the model one more chance ──
              if (result.stopReason === 'tool_loop_limit' && !(taskPlan && activeStep) && continuationRound < 1) {
                continuationRound += 1
                // Summarise the last few tool calls so the model can see what it was repeating
                const recentToolCalls = recentToolSummary(accumulatedParts, 4)

                const loopBreakMsg: Message = {
                  id: makeMessageId(),
                  taskId: activeTaskId,
                  role: 'system',
                  content: [{ type: 'text', text: [
                    '⚠️ TOOL LOOP DETECTED. You have been calling the same tool(s) repeatedly and reaching the same error.',
                    'Recent repeated tool calls:',
                    recentToolCalls || '(no tool calls recorded)',
                    '',
                    'Instructions:',
                    '1. Do NOT call the same tool with the same arguments again.',
                    '2. Diagnose the root cause from the error output above.',
                    '3. Try a fundamentally different approach (e.g. check if the resource exists first, use a different tool, or read files before writing).',
                    '4. If you cannot resolve this, output a visible explanation with options for the user instead of calling another tool.',
                  ].join('\n') }],
                  createdAt: Date.now(),
                }
                currentSnapshot = {
                  ...conversationSnapshot,
                  messages: [
                    ...currentSnapshot.messages,
                    { id: makeMessageId(), taskId: activeTaskId, role: 'assistant', content: accumulatedParts, createdAt: Date.now() },
                    loopBreakMsg,
                  ],
                }
                continue
              }

              // ── output_limit / server_disconnected: standard continuation ──
              if (
                (result.stopReason === 'output_limit' || result.stopReason === 'server_disconnected') &&
                continuationRound < MAX_AUTO_CONTINUE_ROUNDS
              ) {
                continuationRound += 1
                currentSnapshot = {
                  ...conversationSnapshot,
                  messages: [
                    ...currentSnapshot.messages,
                    ...makeContinuationMessages(activeTaskId, accumulatedParts, stopReasonText(result.stopReason), continuationRound),
                  ],
                }
                continue
              }

              // ── Tool loop inside a task step: skip the stuck step and recover ──
              // The step likely partially succeeded (e.g. directory was created on run 1,
              // so every retry fails with "already exists"). Skip it and tell the next
              // step to inspect the actual filesystem state before acting.
              if (result.stopReason === 'tool_loop_limit' && taskPlan && activeStep) {
                if (
                  shouldContinueAfterToolLimit(currentRoundParts, activeStep) &&
                  taskEngineRound < MAX_TASK_ENGINE_ROUNDS
                ) {
                  taskEngineRound += 1
                  currentSnapshot = {
                    ...conversationSnapshot,
                    activeTaskPlan: taskPlan,
                    messages: [
                      ...currentSnapshot.messages,
                      { id: makeMessageId(), taskId: activeTaskId, role: 'assistant', content: accumulatedParts, createdAt: Date.now() },
                      toolProgressContinuationMessage(activeTaskId, activeStep.title, currentRoundParts),
                    ],
                  }
                  continue
                }

                taskEngineRound += 1
                const recentLoopedTools = recentToolSummary(currentRoundParts, 4)

                if (activeStep.role === 'feature' && !roundHasFileEdit(currentRoundParts)) {
                  const error = [
                    `Step "${activeStep.title}" is stuck before implementation.`,
                    'The model only used read/inspect tools and did not edit files with file.write_text or file.patch.',
                    recentLoopedTools ? `Recent tools:\n${recentLoopedTools}` : '',
                    'Ava stopped instead of skipping this feature step because skipping would falsely mark unfinished work as complete.',
                  ].filter(Boolean).join('\n\n')
                  taskPlan = blockPlan(taskPlan, activeStep.id, error)
                  dispatch({ type: 'BLOCK_TASK_PLAN', conversationId, plan: taskPlan })
                  dispatch({
                    type: 'UPDATE_MESSAGE',
                    conversationId,
                    messageId: placeholderId,
                    patch: { streaming: false, error, runPhase: 'error' },
                  })
                  await logFeatureTest({ status: 'failed', message: error, fullContent: result.fullContent })
                  return
                }

                // Mark the stuck step as skipped (not failed) — partial success is assumed
                taskPlan = markStepSkipped(taskPlan, activeStep.id)
                dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan: taskPlan })
                currentSnapshot = {
                  ...conversationSnapshot,
                  activeTaskPlan: taskPlan,
                  messages: [
                    ...currentSnapshot.messages,
                    { id: makeMessageId(), taskId: activeTaskId, role: 'assistant', content: accumulatedParts, createdAt: Date.now() },
                    {
                      id: makeMessageId(),
                      taskId: activeTaskId,
                      role: 'system',
                      content: [{ type: 'text', text: [
                        `⚠️ Step "${activeStep.title}" was stuck in a tool loop and has been skipped.`,
                        `Repeated tools:\n${recentLoopedTools || '(none recorded)'}`,
                        '',
                        'IMPORTANT: Before doing anything in the next step, first READ the actual filesystem state:',
                        `- Run file.list_dir or project.map on: ${taskPlan.workingDirectory}`,
                        '- Check what already exists before creating or installing anything.',
                        '- Do not repeat the same command that was looping.',
                      ].join('\n') }],
                      createdAt: Date.now(),
                    },
                  ],
                }
                continue
              }

              // ── All other cases: hard stop with a clear error ──
              const error =
                result.stopReason === 'output_limit'
                  ? `Stopped: output token limit reached after ${MAX_AUTO_CONTINUE_ROUNDS} automatic continuation round(s). Ava preserved current file state but could not safely finish.`
                  : result.stopReason === 'server_disconnected'
                    ? `Stopped: model server disconnected after ${MAX_AUTO_CONTINUE_ROUNDS} automatic continuation round(s).`
                    : result.stopReason === 'raw_command_no_tool'
                      ? 'Stopped: model output a raw command instead of calling a tool. Ava did not execute the plain text command; please retry or switch to a model/profile that follows tool-call format.'
                      : result.stopReason === 'tool_loop_limit'
                      ? [
                          toolLoopUserMessage(currentRoundParts, activeStep?.title),
                        ].join('\n')
                        : `Stopped: ${stopReasonText(result.stopReason)}.`
              dispatch({
                type: 'UPDATE_MESSAGE',
                conversationId,
                messageId: placeholderId,
                patch: { streaming: false, error, runPhase: 'error' },
              })
              await logFeatureTest({
                status: 'failed',
                message: error,
                stopReason: result.stopReason,
                fullContent: result.fullContent,
              })
              return
            }

            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { streaming: false, runPhase: 'completed' },
            })
            await logFeatureTest({ status: 'passed', fullContent: result.fullContent })
          } else if (result.error === 'aborted') {
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { streaming: false, aborted: true, runPhase: 'aborted' },
            })
            await logFeatureTest({ status: 'failed', message: 'aborted' })
          } else {
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { streaming: false, error: result.error, runPhase: 'error' },
            })
            await logFeatureTest({ status: 'failed', message: result.error })
          }
          break
        }

        // After the initial message, classification changes are suggestions.
        // Category is user-owned organization, so never move sessions silently.
        const currentTraits = conversationSnapshot.traits || ['chat']
        if (conversationSnapshot.messages.length > 1) {
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
              patch: { streaming: false, aborted: true, runPhase: 'aborted' },
            })
            await logFeatureTest({ status: 'failed', message: 'aborted' })
        } else {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: msg, runPhase: 'error' },
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

      if (shouldRequireTaskIntake(nextText, original.commandInvocation)) {
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
        
        const providers = getEnabledProviders(state.settings)
        const workingDirectory = conversation.folderPath || extractWorkingDirectoryFromText(nextText)
        const analysis = await runAnalyzePhase({
          taskId,
          goal: nextText,
          workingDirectory,
          providers,
          settings: state.settings,
          contextBudget: planningContextBudgetForProviders(providers, planningTraitsFor(nextText, conversation)),
          messages: conversation.messages,
        })
        const preparedAnalysis = withRequiredWorkingDirectoryUnknown(analysis, nextText, conversation)

        const pendingBase: PendingTaskIntake = {
          conversationId,
          taskId,
          content: nextText,
          attachments,
          commandInvocation: original.commandInvocation,
          analysis: preparedAnalysis || undefined,
          clarificationAnswers: [],
        }
        const nextQuestion = nextClarification(pendingBase)
        const finalContent: ContentPart[] = preparedAnalysis
          ? nextQuestion
            ? [{
                type: 'text',
                text: clarificationQuestionText(nextQuestion, 1, highPriorityUnknowns(preparedAnalysis).length),
              }]
            : [{ type: 'text', text: analysisSummaryText(pendingBase, workingDirectory) }]
          : [{ type: 'text', text: `⚠️ Agent OS Pre-Flight Analysis failed.\n\nThe LLM could not parse the project constraints. Please try re-sending your request, or check your API key and model settings.` }]

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

        setPendingTaskIntake({
          ...pendingBase,
          stage: preparedAnalysis && nextQuestion ? 'clarifying' : 'awaiting_summary_confirm',
        })
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
        pendingTaskIntake.conversationId === conversation.id &&
        pendingTaskIntake.stage === 'awaiting_summary_confirm' &&
        isTaskConfirmation(content)
      ) {
        const pending = pendingTaskIntake
        const placeholder = makeAssistantPlaceholder(pending.taskId)
        const finalGoal = resolvedGoal(pending)
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
          const workingDirectory = conversation.folderPath || extractWorkingDirectoryFromText(finalGoal)
          if (!workingDirectory) {
            dispatch({
              type: 'ADD_MESSAGE',
              conversationId: conversation.id,
              message: {
                ...placeholder,
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
            try {
              await window.ava.fs.createDir(workingDirectory)
            } catch (err) {
              console.warn('Failed to auto-create working directory:', err)
            }
            dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path: workingDirectory })
          }

          dispatch({
            type: 'ADD_MESSAGE',
            conversationId: conversation.id,
            message: {
              ...placeholder,
              content: [{ type: 'text', text: '正在规划任务执行步骤...' }],
              streaming: false,
              runPhase: 'generating',
            },
          })

          taskPlan = await generateDynamicTaskPlan({
            taskId: pending.taskId,
            goal: finalGoal,
            workingDirectory,
            projectBrief,
            providers: getEnabledProviders(state.settings),
            settings: state.settings,
            traits: planningTraitsFor(finalGoal, conversation),
            analysis: pending.analysis
              ? { ...pending.analysis, unknowns: [] }
              : null,
            skipAnalysis: true,
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
          dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        }
        driveStream(
          { ...conversation, activeTaskPlan: taskPlan, messages: [...conversation.messages, confirmationContext] },
          conversation.id,
          placeholder.id,
          pending.taskId,
          taskPlan,
        )
        return
      }

      if (!pendingTaskIntake && shouldRequireTaskIntake(content, commandInvocation)) {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const intakeMsg = makeAssistantPlaceholder(taskId)
        const conversationId = conversation.id

        dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
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
        
        const providers = getEnabledProviders(state.settings)
        const workingDirectory = conversation.folderPath || extractWorkingDirectoryFromText(content)
        const analysis = await runAnalyzePhase({
          taskId,
          goal: content,
          workingDirectory,
          providers,
          settings: state.settings,
          contextBudget: planningContextBudgetForProviders(providers, planningTraitsFor(content, conversation)),
          messages: conversation.messages,
        })
        const preparedAnalysis = withRequiredWorkingDirectoryUnknown(analysis, content, conversation)

        let finalContent: ContentPart[] = []
        const pendingBase: PendingTaskIntake = {
          conversationId,
          taskId,
          content,
          attachments: attachments ?? [],
          commandInvocation,
          analysis: preparedAnalysis || undefined,
          clarificationAnswers: [],
        }

        if (preparedAnalysis) {
          const nextQuestion = nextClarification(pendingBase)
          if (nextQuestion) {
            const total = highPriorityUnknowns(preparedAnalysis).length
            const index = 1
            finalContent = [{ type: 'text', text: clarificationQuestionText(nextQuestion, index, total) }]
          } else {
            finalContent = [{ type: 'text', text: analysisSummaryText(pendingBase, workingDirectory) }]
          }
        } else {
          finalContent = [{ type: 'text', text: `⚠️ Agent OS Pre-Flight Analysis failed.` }]
        }

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

        setPendingTaskIntake({
          ...pendingBase,
          stage: preparedAnalysis && nextClarification(pendingBase) ? 'clarifying' : 'awaiting_summary_confirm',
        })
        return
      }



      if (
        pendingTaskIntake &&
        pendingTaskIntake.conversationId === conversation.id
      ) {
        const taskId = pendingTaskIntake.taskId
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: userMsg })

        const intakeMsgId = makeMessageId()
        const isSummaryFeedback = pendingTaskIntake.stage === 'awaiting_summary_confirm'
        dispatch({
          type: 'ADD_MESSAGE',
          conversationId: conversation.id,
          message: {
            id: intakeMsgId,
            role: 'assistant',
            content: [{ type: 'text', text: isSummaryFeedback ? '🔍 Updating summary with your feedback...' : '🔍 Recording your answer...' }],
            streaming: true,
            runPhase: 'generating',
            createdAt: Date.now(),
          },
        })

        if (!isSummaryFeedback) {
          if (needsConcreteWorkingDirectoryAnswer(pendingTaskIntake, content)) {
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId: conversation.id,
              messageId: intakeMsgId,
              patch: {
                content: [{
                  type: 'text',
                  text: '请直接输入完整 Windows 项目路径，例如：D:\\Apps\\GLBViewer。不能使用 “I will provide another full path” 作为路径。',
                }],
                streaming: false,
                runPhase: 'completed',
              }
            })
            setPendingTaskIntake({ ...pendingTaskIntake, stage: 'clarifying' })
            return
          }

          const answeredPending = pendingWithAnswer(pendingTaskIntake, content)
          const nextQuestion = nextClarification(answeredPending)
          const finalContent: ContentPart[] = nextQuestion
            ? [{
                type: 'text',
                text: clarificationQuestionText(
                  nextQuestion,
                  (answeredPending.clarificationAnswers?.length ?? 0) + 1,
                  highPriorityUnknowns(answeredPending.analysis).length,
                ),
              }]
            : [{ type: 'text' as const, text: analysisSummaryText(answeredPending, conversation.folderPath || extractWorkingDirectoryFromText(resolvedGoal(answeredPending))) }]

          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId: conversation.id,
            messageId: intakeMsgId,
            patch: {
              content: finalContent,
              streaming: false,
              runPhase: 'completed',
            }
          })

          setPendingTaskIntake({
            ...answeredPending,
            stage: nextQuestion ? 'clarifying' : 'awaiting_summary_confirm',
          })
          return
        }

        const combinedGoal = `${resolvedGoal(pendingTaskIntake)}\n\nUser correction before confirmation: ${content}`
        const providers = getEnabledProviders(state.settings)
        const analysis = await runAnalyzePhase({
          taskId,
          goal: combinedGoal,
          workingDirectory: conversation.folderPath || extractWorkingDirectoryFromText(combinedGoal),
          providers,
          settings: state.settings,
          contextBudget: planningContextBudgetForProviders(providers, planningTraitsFor(combinedGoal, conversation)),
          messages: conversation.messages,
        })
        const preparedAnalysis = withRequiredWorkingDirectoryUnknown(analysis, combinedGoal, conversation)

        let finalContent: ContentPart[] = []
        const nextPending: PendingTaskIntake = {
          ...pendingTaskIntake,
          content: combinedGoal,
          analysis: preparedAnalysis || pendingTaskIntake.analysis,
          clarificationAnswers: [],
        }

        if (preparedAnalysis) {
          const nextQuestion = nextClarification(nextPending)
          if (nextQuestion) {
            finalContent = [{
              type: 'text',
              text: clarificationQuestionText(nextQuestion, 1, highPriorityUnknowns(preparedAnalysis).length),
            }]
          } else {
            finalContent = [{ type: 'text', text: analysisSummaryText(nextPending, conversation.folderPath || extractWorkingDirectoryFromText(combinedGoal)) }]
          }
        } else {
          finalContent = [{ type: 'text', text: '⚠️ Analysis refinement failed.' }]
        }

        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId: conversation.id,
          messageId: intakeMsgId,
          patch: {
            content: finalContent,
            streaming: false,
            runPhase: 'completed',
          }
        })

        setPendingTaskIntake({
          ...nextPending,
          stage: preparedAnalysis && nextClarification(nextPending) ? 'clarifying' : 'awaiting_summary_confirm',
        })
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
      const retryPlan = retryableTaskPlan(activeConversation.activeTaskPlan, taskId)
      if (retryPlan && retryPlan !== activeConversation.activeTaskPlan) {
        dispatch({ type: 'ADVANCE_TASK_STEP', conversationId, plan: retryPlan })
      }

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
          voiceEnabled={state.settings.voice?.enabled}
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
