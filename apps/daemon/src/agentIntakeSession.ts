import type {
  AvaTaskIntakeReplyRequest,
  AvaTaskIntakeResult,
  AvaTaskIntakeSession,
  AvaTaskIntakeStartRequest,
  ProjectAnalysis,
} from '@ava/contracts'
import { analyzeTask } from './agentPlanner'
import { classifyInputWithFallback } from './agentInputRouter'

const sessions = new Map<string, AvaTaskIntakeSession>()

const ENGLISH_CONFIRM_TASK_RE = /^(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run)\b/i
const CHINESE_CONFIRM_TASK_RE = /^(执行|开始|继续|确认|可以|好的|好|没问题|就这样)$/i
const LARGE_TASK_INTENT_RE = /\b(3d|three\.?js|animation|animated|site|website|landing page|app|full app|project|professional|production ready|complete|responsive|dashboard|frontend|ui|ux|migrate|refactor|implement feature|create|build|generate)\b|三维|动画|网站|站点|落地页|应用|完整|专业|响应式|前端|界面|迁移|重构|项目/i

function makeSessionId(taskId: string) {
  return `intake_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function highPriorityUnknowns(analysis?: ProjectAnalysis): ProjectAnalysis['unknowns'] {
  return analysis?.unknowns.filter(item => item.importance === 'high') ?? []
}

function answeredQuestions(session: Pick<AvaTaskIntakeSession, 'clarificationAnswers'>): Set<string> {
  return new Set(session.clarificationAnswers.map(item => item.question))
}

function nextClarification(session: Pick<AvaTaskIntakeSession, 'analysis' | 'clarificationAnswers'>): ProjectAnalysis['unknowns'][number] | null {
  const answered = answeredQuestions(session)
  return highPriorityUnknowns(session.analysis).find(item => !answered.has(item.question)) ?? null
}

function isTaskConfirmation(content: string): boolean {
  const normalized = content.trim().replace(/[.!?。！？,，;；:：\s]+$/g, '')
  return ENGLISH_CONFIRM_TASK_RE.test(normalized) || CHINESE_CONFIRM_TASK_RE.test(normalized)
}

function isCodingDesignBigTask(content: string): boolean {
  return LARGE_TASK_INTENT_RE.test(content)
}

function extractWorkingDirectoryFromText(text: string): string | undefined {
  const match = text.match(/[A-Za-z]:\\[^\n\r"'`<>|?*]+/)
  return match?.[0]?.trim()
}

function isWorkingDirectoryQuestion(question: string): boolean {
  return /(working\s*directory|project\s*(folder|directory|path|location)|where.*(create|use)|folder|directory|path|工作目录|项目.*(目录|路径|位置)|创建.*(目录|路径|位置))/i.test(question)
}

function hasWorkingDirectoryQuestion(analysis?: ProjectAnalysis): boolean {
  return Boolean(analysis?.unknowns.some(item =>
    item.importance === 'high' &&
    isWorkingDirectoryQuestion(item.question),
  ))
}

function withRequiredWorkingDirectoryUnknown(
  analysis: ProjectAnalysis | null,
  content: string,
  workingDirectory?: string,
): ProjectAnalysis | null {
  if (!isCodingDesignBigTask(content) || workingDirectory || extractWorkingDirectoryFromText(content)) return analysis
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

function finalGoal(session: AvaTaskIntakeSession): string {
  if (session.clarificationAnswers.length === 0) return session.content
  return [
    session.content,
    '',
    'Clarified requirements:',
    ...session.clarificationAnswers.map((item, idx) => `${idx + 1}. ${item.question}\nAnswer: ${item.answer}`),
  ].join('\n')
}

function summaryText(session: AvaTaskIntakeSession): string {
  const analysis = session.analysis
  const answers = session.clarificationAnswers
  return [
    '需求已澄清完毕，请确认下面 summary 是否正确。',
    '',
    `目标：${analysis?.projectSummary || session.content}`,
    `工作目录：${session.workingDirectory || '(未关联工作目录)'}`,
    analysis?.architecture ? `架构判断：${analysis.architecture}` : '',
    answers.length > 0 ? '\n已确认：' : '',
    ...answers.map((item, idx) => `${idx + 1}. ${item.question}\n   答案：${item.answer}`),
    analysis?.risks?.length ? '\n主要风险：' : '',
    ...(analysis?.risks ?? []).map((risk, idx) => `${idx + 1}. ${risk.risk}\n   处理：${risk.mitigation}`),
    '',
    '如果正确，请回复「确认」。如果不正确，请直接补充要修改的地方。',
  ].filter(Boolean).join('\n')
}

function needsConcreteWorkingDirectoryAnswer(session: AvaTaskIntakeSession, answer: string): boolean {
  const question = nextClarification(session)
  if (!question || !isWorkingDirectoryQuestion(question.question)) return false
  return !extractWorkingDirectoryFromText(answer)
}

function resultForSession(session: AvaTaskIntakeSession): AvaTaskIntakeResult {
  const nextQuestion = nextClarification(session)
  const messageText = nextQuestion
    ? clarificationQuestionText(
      nextQuestion,
      session.clarificationAnswers.length + 1,
      highPriorityUnknowns(session.analysis).length,
    )
    : summaryText({ ...session, stage: 'awaiting_summary_confirm' })

  return {
    session: {
      ...session,
      stage: nextQuestion ? 'clarifying' : 'awaiting_summary_confirm',
    },
    messageText,
    readyToPlan: false,
    workingDirectory: session.workingDirectory,
    analysis: session.analysis ?? null,
  }
}

function saveSession(session: AvaTaskIntakeSession): AvaTaskIntakeSession {
  sessions.set(session.sessionId, session)
  return session
}

export async function startIntakeSession(request: AvaTaskIntakeStartRequest): Promise<AvaTaskIntakeResult> {
  const workingDirectory = request.workingDirectory || extractWorkingDirectoryFromText(request.content)
  const analysisResult = await analyzeTask({
    taskId: request.taskId,
    goal: request.content,
    workingDirectory,
    messages: request.messages,
    traits: request.traits,
  })
  const analysis = withRequiredWorkingDirectoryUnknown(analysisResult.analysis, request.content, workingDirectory) ?? undefined
  const now = Date.now()
  const session = saveSession({
    sessionId: makeSessionId(request.taskId),
    conversationId: request.conversationId,
    taskId: request.taskId,
    content: request.content,
    workingDirectory,
    analysis,
    clarificationAnswers: [],
    stage: 'clarifying',
    createdAt: now,
    updatedAt: now,
  })
  const next = resultForSession(session)
  saveSession(next.session)
  return next
}

export async function replyIntakeSession(request: AvaTaskIntakeReplyRequest): Promise<AvaTaskIntakeResult> {
  const existing = sessions.get(request.sessionId)
  if (!existing || existing.conversationId !== request.conversationId) {
    throw new Error('Unknown task intake session.')
  }

  const now = Date.now()
  if (existing.stage === 'awaiting_summary_confirm' && isTaskConfirmation(request.content)) {
    const session = saveSession({ ...existing, stage: 'ready_to_plan', updatedAt: now })
    return {
      session,
      messageText: '已确认需求，准备生成执行计划。',
      readyToPlan: true,
      finalGoal: finalGoal(session),
      workingDirectory: session.workingDirectory,
      analysis: session.analysis ?? null,
    }
  }

  const classification = await classifyInputWithFallback({
    content: request.content,
    pendingIntake: true,
    pendingIntakeStage: existing.stage === 'awaiting_summary_confirm' ? 'awaiting_summary_confirm' : 'clarifying',
    workingDirectory: request.workingDirectory || existing.workingDirectory,
    traits: request.traits,
  })

  if (classification.route === 'cancel_or_pause') {
    const session = saveSession({ ...existing, stage: 'canceled', updatedAt: now })
    return {
      session,
      messageText: '已取消当前需求澄清。你可以直接发送新的问题或任务。',
      readyToPlan: false,
      canceled: true,
    }
  }

  if (classification.route === 'meta_question') {
    return {
      session: existing,
      messageText: '这是需求澄清流程：我会先确认关键需求，再生成执行计划。请直接回答当前问题，或回复「取消」停止澄清。',
      readyToPlan: false,
      workingDirectory: existing.workingDirectory,
      analysis: existing.analysis ?? null,
    }
  }

  if (existing.stage === 'awaiting_summary_confirm' || classification.route === 'requirement_correction') {
    const combinedGoal = `${finalGoal(existing)}\n\nUser correction before confirmation: ${request.content}`
    const workingDirectory = request.workingDirectory || existing.workingDirectory || extractWorkingDirectoryFromText(combinedGoal)
    const analysisResult = await analyzeTask({
      taskId: existing.taskId,
      goal: combinedGoal,
      workingDirectory,
      messages: request.messages,
      traits: request.traits,
    })
    const analysis = withRequiredWorkingDirectoryUnknown(analysisResult.analysis, combinedGoal, workingDirectory) ?? existing.analysis
    const session = saveSession({
      ...existing,
      content: combinedGoal,
      workingDirectory,
      analysis,
      clarificationAnswers: [],
      stage: 'clarifying',
      updatedAt: now,
    })
    const next = resultForSession(session)
    saveSession(next.session)
    return next
  }

  if (needsConcreteWorkingDirectoryAnswer(existing, request.content)) {
    return {
      session: existing,
      messageText: '请直接输入完整 Windows 项目路径，例如：D:\\Apps\\GLBViewer。不能使用 “I will provide another full path” 作为路径。',
      readyToPlan: false,
      workingDirectory: existing.workingDirectory,
      analysis: existing.analysis ?? null,
    }
  }

  const question = nextClarification(existing)
  const answerWorkingDirectory = extractWorkingDirectoryFromText(request.content)
  const session = saveSession({
    ...existing,
    workingDirectory: answerWorkingDirectory || existing.workingDirectory,
    clarificationAnswers: question
      ? [...existing.clarificationAnswers, { question: question.question, answer: request.content }]
      : existing.clarificationAnswers,
    updatedAt: now,
  })
  const next = resultForSession(session)
  saveSession(next.session)
  return next
}
