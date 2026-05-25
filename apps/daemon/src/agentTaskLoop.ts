import {
  streamChat,
  type LlmMessage,
  type StreamChatArgs,
  type StreamChatResult,
  type TaskExecutionPlan,
  type TaskExecutionStep,
  type TaskExecutionValidation,
  type ToolCallPart,
} from './llm'

type EventTargetLike = { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }
type ContentPart = StreamChatResult['parts'][number]
type StepEvaluation = { complete: boolean; blocked?: string; needsRepair?: string }

const MAX_TASK_ENGINE_ROUNDS = 500

export async function streamTaskExecutionPlan(
  eventTarget: EventTargetLike,
  args: StreamChatArgs,
): Promise<StreamChatResult & { taskPlan: TaskExecutionPlan }> {
  let plan = args.activeTaskPlan
  if (!plan) return { ...(await streamChat(eventTarget as never, args)), taskPlan: emptyPlan(args) }

  let aggregate: StreamChatResult | null = null
  let fullContent = ''
  let allParts: ContentPart[] = []
  let round = 0
  let productiveRounds = 0
  const baseMessages = args.messages
  const historyMessages: LlmMessage[] = []

  emitTaskPlan(eventTarget, args, 'started', plan)

  while (!eventTarget.isDestroyed() && round < taskEngineRoundBudget(plan, productiveRounds)) {
    const step = nextTaskStep(plan)
    if (!step) {
      plan = completePlan(plan)
      emitTaskPlan(eventTarget, args, 'completed', plan)
      break
    }

    plan = markStepRunning(plan, step.id)
    emitTaskPlan(eventTarget, args, 'advanced', plan, step.title)

    const finalReportAllowed = stepRole(step) === 'final_report' && finalValidationGateSatisfied(plan.validation, plan)
    const stepArgs: StreamChatArgs = {
      ...args,
      activeTaskPlan: plan,
      activeStepRequiredTools: step.requiredTools,
      activeStepRole: stepRole(step),
      activeStepToolLoopBudget: toolLoopBudgetForStep(step),
      finalReportReadBudget: stepRole(step) === 'final_report' ? 3 : undefined,
      messages: [
        ...baseMessages,
        ...historyMessages,
        { role: 'system', content: buildTaskStepPrompt(plan, step, finalReportAllowed), taskId: args.activeTaskId },
      ],
    }

    const result = await streamChat(eventTarget as never, stepArgs)
    aggregate = mergeResult(aggregate, result)
    fullContent += result.fullContent
    allParts = [...allParts, ...result.parts]

    const roundParts = result.parts
    plan = recoverStepFromRound(plan, step.id, roundParts, result.fullContent)
    plan = withValidation(plan, updatePlanValidation(plan, roundParts, step))
    emitTaskPlan(eventTarget, args, 'advanced', plan, step.title)

    const evaluation = evaluateStepCompletion({
      plan,
      step,
      parts: roundParts,
      fullContent: result.fullContent,
      successfulRequiredTool: result.successfulRequiredTool,
    })

    if (roundMadeTaskProgress(step, roundParts, evaluation)) productiveRounds += 1

    if (evaluation.complete) {
      plan = markStepDone(plan, step.id)
      emitTaskPlan(eventTarget, args, stepRole(step) === 'final_report' ? 'completed' : 'advanced', plan, step.title)
      if (stepRole(step) === 'final_report') {
        plan = completePlan(plan)
        emitTaskPlan(eventTarget, args, 'completed', plan)
        break
      }
      historyMessages.push(taskRoundMessage(args.activeTaskId, step.title, roundParts, result.fullContent))
      round += 1
      continue
    }

    if (evaluation.needsRepair) {
      plan = routeToRepair(plan, step, evaluation.needsRepair)
      emitTaskPlan(eventTarget, args, 'advanced', plan, 'Repair validation or tool execution errors')
      historyMessages.push({
        role: 'system',
        taskId: args.activeTaskId,
        content: [
          'Current step needs repair. Route to repair step.',
          evaluation.needsRepair,
          'Apply the required fix, then continue the task.',
        ].join('\n\n'),
      })
      round += 1
      continue
    }

    if (result.stopReason === 'output_limit' || result.stopReason === 'server_disconnected') {
      historyMessages.push({
        role: 'system',
        taskId: args.activeTaskId,
        content: `Continue the interrupted step "${step.title}" from the last known state. Do not restart from the beginning.`,
      })
      round += 1
      continue
    }

    if (result.stopReason === 'tool_loop_limit' && roundMadeTaskProgress(step, roundParts, evaluation)) {
      historyMessages.push(taskRoundMessage(args.activeTaskId, step.title, roundParts, result.fullContent))
      round += 1
      continue
    }

    const error = evaluation.blocked ??
      (result.stopReason
        ? `Step "${step.title}" stopped with ${result.stopReason}.`
        : `Step "${step.title}" did not reach its completion signal.`)
    plan = blockPlan(plan, step.id, error)
    emitTaskPlan(eventTarget, args, 'blocked', plan, step.title, error)
    break
  }

  if (round >= taskEngineRoundBudget(plan, productiveRounds) && plan.status === 'running') {
    const step = nextTaskStep(plan)
    const error = `Task execution stopped after ${round} daemon-managed round(s). Current step did not complete: ${step?.title ?? 'unknown'}.`
    plan = blockPlan(plan, step?.id ?? plan.currentStepId ?? 'unknown', error)
    emitTaskPlan(eventTarget, args, 'blocked', plan, step?.title, error)
  }

  return {
    ...(aggregate ?? emptyResult(args)),
    fullContent,
    parts: allParts,
    taskPlan: plan,
  }
}

function emptyPlan(args: StreamChatArgs): TaskExecutionPlan {
  const now = Date.now()
  return {
    taskId: args.activeTaskId ?? args.streamId,
    status: 'completed',
    goal: '',
    workingDirectory: args.activeFolderPath ?? '',
    kind: 'coding-design',
    steps: [],
    validation: { devServerChecked: false, consoleChecked: false, screenshotChecked: false, buildChecked: false },
    createdAt: now,
    updatedAt: now,
  }
}

function emptyResult(args: StreamChatArgs): StreamChatResult {
  const provider = args.providers[0]
  if (!provider) {
    throw new Error('No provider available for daemon task loop result.')
  }
  return {
    fullContent: '',
    parts: [],
    provider,
    model: provider.defaultModel || provider.models[0] || 'unknown',
    attempts: [],
    fallbackUsed: false,
    toolCallsIssued: 0,
    loopRounds: 0,
    detectedToolFormat: 'none',
  }
}

function emitTaskPlan(
  eventTarget: EventTargetLike,
  args: StreamChatArgs,
  phase: 'started' | 'advanced' | 'completed' | 'blocked',
  plan: TaskExecutionPlan,
  stepTitle?: string,
  error?: string,
) {
  eventTarget.send('ava:llm:event', {
    type: 'task_plan_update',
    streamId: args.streamId,
    taskId: args.activeTaskId ?? plan.taskId,
    phase,
    plan,
    validation: plan.validation,
    stepTitle,
    error,
  })
}

function nextTaskStep(plan: TaskExecutionPlan): TaskExecutionStep | null {
  const current = plan.currentStepId ? plan.steps.find(step => step.id === plan.currentStepId) : undefined
  if (current && current.status !== 'done' && current.status !== 'skipped') return current
  return plan.steps.find(step => {
    if (step.status !== 'pending' && step.status !== 'running') return false
    return (step.dependsOn ?? []).every(depId => {
      const dep = plan.steps.find(candidate => candidate.id === depId)
      return !dep || dep.status === 'done' || dep.status === 'skipped'
    })
  }) ?? null
}

function buildTaskStepPrompt(plan: TaskExecutionPlan, step: TaskExecutionStep, finalReportAllowed: boolean): string {
  const role = stepRole(step)
  return [
    'Task Execution Engine is running in Ava daemon. Execute only the current step.',
    `Goal: ${plan.goal}`,
    `Working directory: ${plan.workingDirectory}`,
    `Current step: ${step.id} - ${step.title}`,
    `Allowed/expected tools: ${step.requiredTools.length ? step.requiredTools.join(', ') : '(no tool required)'}`,
    `Completion signals: ${step.completionSignals.join(', ')}`,
    roleInstruction(role),
    plan.architectureConstraints ? `Constraints from confirmed analysis:\n${plan.architectureConstraints}` : '',
    step.lastError ? `Blocking error to fix:\n${step.lastError}` : '',
    step.lastToolSummary ? `Previous attempt summary:\n${step.lastToolSummary}` : '',
    role === 'final_report' || finalReportAllowed
      ? 'FINAL REPORT STEP: write the visible final report now. Include Changed files, Validation result, Preview result, Remaining risks.'
      : 'Do not provide a final report yet. Complete only the current step with the necessary tool call.',
    'If a tool is needed, call the tool instead of describing what you will do.',
  ].filter(Boolean).join('\n')
}

function roleInstruction(role: TaskExecutionStep['role']): string {
  switch (role) {
    case 'inspect': return 'INSPECT STEP: gather minimal project facts. Do not edit files.'
    case 'scaffold': return 'SCAFFOLD STEP: create or verify project structure; package.json or scaffold artifact must exist.'
    case 'install': return 'INSTALL STEP: install or verify dependencies with package evidence.'
    case 'feature': return 'FEATURE STEP: implement by editing files with file.write_text or file.patch, then verify changed files.'
    case 'validate': return 'VALIDATE STEP: run project.validate or a real build command. Do not scaffold or rewrite files.'
    case 'repair': return 'REPAIR STEP: fix the specific error with file.patch/file.write_text or a repair command.'
    case 'preview': return 'PREVIEW STEP: start or verify the development server and use the returned URL.'
    case 'console': return 'CONSOLE STEP: call preview.console on the actual local URL.'
    case 'screenshot': return 'SCREENSHOT STEP: call preview.screenshot on the actual local URL.'
    case 'final_report': return 'FINAL REPORT STEP: summarize only after validation gates pass.'
    default: return ''
  }
}

function evaluateStepCompletion(input: {
  plan: TaskExecutionPlan
  step: TaskExecutionStep
  parts: ContentPart[]
  fullContent: string
  successfulRequiredTool?: string
}): StepEvaluation {
  const role = stepRole(input.step)
  const okTools = okToolParts(input.parts)
  if (input.successfulRequiredTool) return { complete: true }

  if (role === 'final_report') {
    if (!finalValidationGateSatisfied(input.plan.validation, input.plan)) return { complete: false, blocked: finalReportBlockedReason(input.plan) }
    return { complete: visibleText(input.fullContent).length > 0 }
  }

  if (role === 'validate') {
    if (okTools.some(part => validationToolSucceeded(part, input.plan))) return { complete: true }
    const failed = input.parts.filter((part): part is ToolCallPart => part.type === 'tool_call' && validationToolFailed(part, input.plan))
    if (failed.length) return { complete: false, needsRepair: validationFailureSummary(failed) }
    return noProgress(input.step, input.parts, input.fullContent, 'validation evidence')
  }

  if (role === 'feature') {
    if (okTools.some(part => part.name === 'file.write_text' || part.name === 'file.patch')) return { complete: true }
    return noProgress(input.step, input.parts, input.fullContent, 'file edit evidence')
  }

  if (role === 'repair') {
    if (okTools.some(part => part.name === 'file.write_text' || part.name === 'file.patch' || part.name === 'shell.run_command')) return { complete: true }
    return noProgress(input.step, input.parts, input.fullContent, 'repair evidence')
  }

  if (role === 'console') {
    const tool = lastToolPart(input.parts, 'preview.console')
    if (tool?.status === 'ok' && previewErrorCount(tool.result) === 0) return { complete: true }
    if (tool) return { complete: false, needsRepair: `Preview console check failed or found errors: ${tool.error ?? JSON.stringify(tool.result).slice(0, 600)}` }
    return noProgress(input.step, input.parts, input.fullContent, 'preview.console evidence')
  }

  if (role === 'screenshot') {
    const tool = lastToolPart(input.parts, 'preview.screenshot')
    if (tool?.status === 'ok' && typeof objectValue(tool.result, 'screenshotPath') === 'string' && previewErrorCount(tool.result) === 0) return { complete: true }
    if (tool) return { complete: false, needsRepair: `Preview screenshot did not prove a usable render: ${tool.error ?? JSON.stringify(tool.result).slice(0, 600)}` }
    return noProgress(input.step, input.parts, input.fullContent, 'preview.screenshot evidence')
  }

  const inspectEquivalents = new Set(['file.read_text', 'file.list_dir', 'file.stat', 'project.map', 'project.detect', 'search.ripgrep'])
  const required = new Set(input.step.requiredTools)
  const complete = input.step.requiredTools.length === 0
    ? visibleText(input.fullContent).length > 0
    : okTools.some(part => required.has(part.name) || (role === 'inspect' && inspectEquivalents.has(part.name)))
  if (complete) return { complete: true }
  return noProgress(input.step, input.parts, input.fullContent, 'completion evidence')
}

function noProgress(step: TaskExecutionStep, parts: ContentPart[], fullContent: string, missing: string): StepEvaluation {
  if (okToolParts(parts).length > 0 || visibleText(fullContent)) return { complete: false }
  if (step.attempts + 1 < 2) return { complete: false }
  return {
    complete: false,
    blocked: `Step "${step.title}" produced no usable ${missing}.`,
  }
}

function updatePlanValidation(plan: TaskExecutionPlan, parts: ContentPart[], step: TaskExecutionStep): TaskExecutionValidation {
  const validation = { ...plan.validation }
  const role = stepRole(step)
  for (const part of okToolParts(parts)) {
    if (role === 'preview' && part.name === 'devserver.start') validation.devServerChecked = true
    if (role === 'console' && part.name === 'preview.console' && previewErrorCount(part.result) === 0) validation.consoleChecked = true
    if (role === 'screenshot' && part.name === 'preview.screenshot' && typeof objectValue(part.result, 'screenshotPath') === 'string') validation.screenshotChecked = true
    if (role === 'validate' && validationToolSucceeded(part, plan)) validation.buildChecked = true
  }
  return validation
}

function recoverStepFromRound(plan: TaskExecutionPlan, stepId: string, parts: ContentPart[], fullContent: string): TaskExecutionPlan {
  const summary = taskRoundSummary(stepId, parts, fullContent).slice(0, 1200)
  const evidence = parts
    .filter((part): part is ToolCallPart => part.type === 'tool_call')
    .map(part => ({
      toolName: part.name,
      toolCallId: part.id,
      status: part.status,
      timestamp: part.endedAt ?? part.startedAt ?? Date.now(),
      summary: part.error ?? JSON.stringify(part.result ?? {}).slice(0, 300),
    }))
  if (!summary && evidence.length === 0) return plan
  return updateStep(plan, stepId, step => ({
    ...step,
    lastToolSummary: summary || step.lastToolSummary,
    lastRecoveredAt: Date.now(),
    evidence: [...(step.evidence ?? []), ...evidence].slice(-20),
  }))
}

function routeToRepair(plan: TaskExecutionPlan, step: TaskExecutionStep, error: string): TaskExecutionPlan {
  const repairStep: TaskExecutionStep = {
    id: 'repair',
    title: 'Repair validation or tool execution errors',
    status: 'pending',
    requiredTools: ['file.patch', 'file.write_text', 'shell.run_command', 'project.map', 'file.read_text', 'file.list_dir', 'file.stat'],
    completionSignals: ['errors repaired'],
    attempts: 0,
    role: 'repair',
    workflowType: 'debug',
    lastError: error,
    lastToolSummary: error,
  }
  const steps = plan.steps.some(item => item.id === 'repair')
    ? plan.steps.map(item => item.id === 'repair' ? { ...item, ...repairStep } : item)
    : [
        ...plan.steps.slice(0, Math.max(0, plan.steps.findIndex(item => item.id === step.id))),
        repairStep,
        ...plan.steps.slice(Math.max(0, plan.steps.findIndex(item => item.id === step.id))),
      ]
  return { ...plan, steps, status: 'running', currentStepId: 'repair', updatedAt: Date.now() }
}

function taskRoundMessage(taskId: string | undefined, stepTitle: string, parts: ContentPart[], fullContent: string): LlmMessage {
  return {
    role: 'system',
    taskId,
    content: taskRoundSummary(stepTitle, parts, fullContent),
  }
}

function taskRoundSummary(stepTitle: string, parts: ContentPart[], fullContent: string): string {
  const tools = parts
    .filter((part): part is ToolCallPart => part.type === 'tool_call')
    .map(part => `- ${part.name}: ${part.status}${part.error ? ` ${part.error}` : ''}`)
  return [
    `Completed daemon execution round for step: ${stepTitle}`,
    visibleText(fullContent) ? `Visible assistant text:\n${visibleText(fullContent).slice(0, 1200)}` : '',
    tools.length ? `Tool activity:\n${tools.join('\n')}` : 'No tool activity recorded.',
  ].filter(Boolean).join('\n\n')
}

function mergeResult(current: StreamChatResult | null, next: StreamChatResult): StreamChatResult {
  if (!current) return next
  return {
    ...next,
    fullContent: `${current.fullContent}${next.fullContent}`,
    parts: [...current.parts, ...next.parts],
    attempts: [...current.attempts, ...next.attempts],
    fallbackUsed: current.fallbackUsed || next.fallbackUsed,
    toolCallsIssued: current.toolCallsIssued + next.toolCallsIssued,
    loopRounds: current.loopRounds + next.loopRounds,
    stopReason: next.stopReason,
    successfulRequiredTool: next.successfulRequiredTool ?? current.successfulRequiredTool,
  }
}

function roundMadeTaskProgress(step: TaskExecutionStep, parts: ContentPart[], evaluation?: StepEvaluation): boolean {
  if (evaluation?.complete || evaluation?.needsRepair) return true
  if (stepRole(step) === 'feature' || stepRole(step) === 'repair') return okToolParts(parts).some(part => part.name === 'file.write_text' || part.name === 'file.patch' || part.name === 'shell.run_command')
  if (stepRole(step) === 'validate') return parts.some(part => part.type === 'tool_call' && validationToolName(part.name, part.args))
  return okToolParts(parts).length > 0
}

function taskEngineRoundBudget(plan: TaskExecutionPlan, productiveRounds = 0): number {
  return Math.min(MAX_TASK_ENGINE_ROUNDS, Math.max(24, Math.max(1, plan.steps.length) * 6) + productiveRounds * 4)
}

function toolLoopBudgetForStep(step: TaskExecutionStep): number {
  switch (stepRole(step)) {
    case 'final_report': return 4
    case 'inspect': return 20
    case 'scaffold': return 50
    case 'install': return 30
    case 'feature': return 50
    case 'preview': return 20
    case 'console': return 20
    case 'screenshot': return 20
    case 'repair': return 40
    case 'validate': return 30
    default: return 10
  }
}

function stepRole(step: TaskExecutionStep): TaskExecutionStep['role'] {
  if (step.role) return step.role
  if (step.id === 'repair') return 'repair'
  if (step.id === 'validate') return 'validate'
  if (step.id === 'final_report') return 'final_report'
  if (step.id === 'check_console') return 'console'
  if (step.id === 'check_screenshot') return 'screenshot'
  if (step.id === 'start_preview') return 'preview'
  return undefined
}

function updateStep(plan: TaskExecutionPlan, stepId: string, updater: (step: TaskExecutionStep) => TaskExecutionStep): TaskExecutionPlan {
  const steps = plan.steps.map(step => step.id === stepId ? updater(step) : step)
  const next = steps.find(step => step.status === 'pending' || step.status === 'running' || step.status === 'failed')
  return { ...plan, steps, status: 'running', currentStepId: next?.id, updatedAt: Date.now() }
}

function markStepRunning(plan: TaskExecutionPlan, stepId: string): TaskExecutionPlan {
  return updateStep(plan, stepId, step => ({ ...step, status: 'running', attempts: step.attempts + 1, lastError: undefined }))
}

function markStepDone(plan: TaskExecutionPlan, stepId: string): TaskExecutionPlan {
  return updateStep(plan, stepId, step => ({ ...step, status: 'done', lastError: undefined }))
}

function blockPlan(plan: TaskExecutionPlan, stepId: string, error: string): TaskExecutionPlan {
  return { ...updateStep(plan, stepId, step => ({ ...step, status: 'failed', lastError: error })), status: 'blocked', updatedAt: Date.now() }
}

function completePlan(plan: TaskExecutionPlan): TaskExecutionPlan {
  return { ...plan, status: 'completed', currentStepId: undefined, updatedAt: Date.now() }
}

function withValidation(plan: TaskExecutionPlan, validation: TaskExecutionValidation): TaskExecutionPlan {
  return { ...plan, validation, updatedAt: Date.now() }
}

function finalValidationGateSatisfied(validation: TaskExecutionValidation, plan: TaskExecutionPlan): boolean {
  return (!planHasRole(plan, 'console') || validation.consoleChecked) &&
    (!planHasRole(plan, 'screenshot') || validation.screenshotChecked) &&
    (!planHasRole(plan, 'validate') || validation.buildChecked)
}

function finalReportBlockedReason(plan: TaskExecutionPlan): string {
  const missing: string[] = []
  if (planHasRole(plan, 'console') && !plan.validation.consoleChecked) missing.push('console check')
  if (planHasRole(plan, 'screenshot') && !plan.validation.screenshotChecked) missing.push('screenshot check')
  if (planHasRole(plan, 'validate') && !plan.validation.buildChecked) missing.push('validation/build')
  return missing.length ? `Final report is blocked until these checks run: ${missing.join(', ')}.` : 'Final report is blocked.'
}

function planHasRole(plan: TaskExecutionPlan, role: NonNullable<TaskExecutionStep['role']>): boolean {
  return plan.steps.some(step => stepRole(step) === role)
}

function okToolParts(parts: ContentPart[]): ToolCallPart[] {
  return parts.filter((part): part is ToolCallPart =>
    part.type === 'tool_call' &&
    part.status === 'ok' &&
    !(part.result && typeof part.result === 'object' && (part.result as Record<string, unknown>).ignored === true),
  )
}

function lastToolPart(parts: ContentPart[], name: string): ToolCallPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type === 'tool_call' && part.name === name) return part
  }
  return undefined
}

function visibleText(text: string): string {
  return text
    .replace(/<antThinking>[\s\S]*?(?:<\/antThinking>|$)/gi, '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .trim()
}

function validationToolSucceeded(part: ToolCallPart, plan: TaskExecutionPlan): boolean {
  if (part.status !== 'ok') return false
  if (part.name === 'project.validate') return projectValidateSucceeded(part.result)
  if (part.name === 'process.wait') return processWaitSucceeded(part.result)
  if (part.name === 'shell.run_command' && validationToolName(part.name, part.args)) {
    if (validationRequiresBuild(plan) && !looksLikeBuildCommand(part.args)) return false
    return commandSucceeded(part.result)
  }
  return false
}

function validationToolFailed(part: ToolCallPart, plan: TaskExecutionPlan): boolean {
  if (!validationToolName(part.name, part.args)) return false
  if (part.status === 'error' || part.status === 'aborted') return true
  return part.status === 'ok' && !validationToolSucceeded(part, plan)
}

function validationToolName(name: string, args: Record<string, unknown>): boolean {
  return name === 'project.validate' || name === 'process.wait' ||
    (name === 'shell.run_command' && /\b(build|typecheck|test|lint|tsc)\b/i.test(`${args.command ?? ''} ${JSON.stringify(args.args ?? [])}`))
}

function validationFailureSummary(parts: ToolCallPart[]): string {
  return `Validation failed. Repair must fix the current errors before validation retries:\n${parts.map(part => part.error ?? JSON.stringify(part.result).slice(0, 800)).join('\n---\n')}`
}

function validationRequiresBuild(plan: TaskExecutionPlan): boolean {
  return plan.kind === 'coding-design' && (planHasRole(plan, 'preview') || planHasRole(plan, 'console') || planHasRole(plan, 'screenshot'))
}

function looksLikeBuildCommand(args: Record<string, unknown>): boolean {
  return /\b(build|next\s+build|vite\s+build|astro\s+build|tsc\s+-b\s+&&\s+vite\s+build)\b/i.test(`${args.command ?? ''} ${JSON.stringify(args.args ?? [])}`)
}

function commandSucceeded(result: unknown): boolean {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  return record.exitCode === 0 || record.code === 0
}

function projectValidateSucceeded(result: unknown): boolean {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  if (record.ok === false || record.success === false || record.valid === false) return false
  return 'exitCode' in record || 'code' in record ? commandSucceeded(record) : true
}

function processWaitSucceeded(result: unknown): boolean {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  return record.status === 'exited' && record.exitCode === 0
}

function previewErrorCount(result: unknown): number {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  if (typeof record.errorCount === 'number') return record.errorCount
  const messages = Array.isArray(record.messages) ? record.messages : []
  return messages.filter(message => {
    const item = message && typeof message === 'object' ? message as Record<string, unknown> : {}
    const level = String(item.level ?? '').toLowerCase()
    return level === 'error' || level === 'pageerror'
  }).length
}

function objectValue(result: unknown, key: string): unknown {
  return result && typeof result === 'object' ? (result as Record<string, unknown>)[key] : undefined
}
