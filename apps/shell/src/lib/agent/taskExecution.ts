import type { ContentPart, Message, ModelProvider, ProjectAnalysis, Settings, TaskExecutionPlan, TaskExecutionStep, TaskExecutionValidation } from '../../types'
import { planningContextBudgetForProviders } from './chat'
import { normalizeRequiredTools } from './toolNames'

const CODING_DESIGN_TASK_RE =
  /\b(3d|three\.?js|animation|animated|site|website|landing page|app|full app|project|professional|production ready|complete|responsive|dashboard|frontend|ui|ux|migrate|refactor|implement feature|create|build|generate)\b|三维|动画|网站|站点|落地页|应用|完整|专业|响应式|前端|界面|迁移|重构|项目/i

const MAX_STEP_ATTEMPTS = 3
const MAX_VALIDATE_REPAIR_CYCLES = 2

export function normalizeTaskExecutionPlan(plan: TaskExecutionPlan): TaskExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map(step => ({
      ...step,
      requiredTools: normalizeRequiredTools(step.requiredTools),
    })),
  }
}

export function isCodingDesignBigTask(content: string): boolean {
  return CODING_DESIGN_TASK_RE.test(content) || content.length > 300
}

export function extractWorkingDirectoryFromText(content: string): string | undefined {
  // 1. Quoted/backticked path wins (lets user encode spaces, e.g. "C:\Program Files\X").
  const quoted = content.match(/["'`]([A-Za-z]:[\\/][^"'`\r\n]+)["'`]/)
  if (quoted?.[1]) return sanitizeWorkingDirectoryPath(quoted[1])

  // 2. Bare path: stop at whitespace or any punctuation that doesn't belong in a path.
  // Allowed: letters, digits, _, -, ., space-not-included, slashes, backslashes, parens.
  const bare = content.match(/[A-Za-z]:[\\/][\w./\\()-]+/)
  return bare ? sanitizeWorkingDirectoryPath(bare[0]) : undefined
}

export function sanitizeWorkingDirectoryPath(path: string): string | undefined {
  const cleaned = path
    .trim()
    .replace(/[.,;:!?，。；：！？\])}]+$/g, '')
    .trim()
  if (!/^[A-Za-z]:[\\/]/.test(cleaned)) return undefined
  if (/[<>|?*"]/.test(cleaned)) return undefined
  return cleaned
}

export function createCodingDesignTaskPlan(input: {
  taskId: string
  goal: string
  workingDirectory?: string
  architectureConstraints?: string
}): TaskExecutionPlan {
  const now = Date.now()
  return {
    taskId: input.taskId,
    status: 'running',
    goal: input.goal,
    workingDirectory: input.workingDirectory || '(no active folder)',
    kind: 'coding-design',
    currentStepId: 'inspect_project',
    architectureConstraints: input.architectureConstraints,
    validation: {
      devServerChecked: false,
      consoleChecked: false,
      screenshotChecked: false,
      buildChecked: false,
    },
    steps: [
      step('inspect_project', 'Ensure target directory exists and inspect project state',
        ['file.create_dir', 'project.map', 'project.detect', 'file.list_dir', 'file.read_text', 'shell.run_command'],
        ['target directory exists', 'project mapped'], 'inspect', 'research'),
      step('setup_project', 'Initialize or complete project structure',
        ['shell.run_command', 'process.start', 'process.wait', 'file.create_dir', 'file.write_text'],
        ['project structure ready'], 'scaffold', 'scaffold'),
      step('install_dependencies', 'Install or confirm required dependencies',
        ['shell.run_command', 'process.start', 'process.wait', 'project.detect'],
        ['dependencies ready'], 'install', 'scaffold'),
      step('write_core_files', 'Write core app, 3D scene, loader, controls, and styles',
        ['file.write_text', 'file.patch', 'project.map', 'file.stat', 'file.read_text'],
        ['core files written'], 'feature', 'feature'),
      step('start_preview', 'Start development server',
        ['devserver.start'],
        ['dev server started'], 'preview', 'research'),
      step('check_console', 'Check browser console',
        ['preview.console'],
        ['console checked'], 'console', 'debug'),
      step('check_screenshot', 'Capture preview screenshot',
        ['preview.screenshot'],
        ['screenshot checked'], 'screenshot', 'research'),
      step('repair', 'Repair detected console, build, or visual issues',
        ['file.patch', 'file.write_text', 'shell.run_command'],
        ['issues repaired'], 'repair', 'debug'),
      step('validate', 'Validate build or typecheck',
        ['project.validate', 'shell.run_command', 'process.start', 'process.wait'],
        ['project validated'], 'validate', 'debug'),
      step('final_report', 'Report changed files, validation result, and remaining risks',
        [],
        ['final report written'], 'final_report', 'feature'),
    ],
    createdAt: now,
    updatedAt: now,
  }
}

import { runAnalyzePhase, runPlanPhase } from './roles/planner'

export async function generateDynamicTaskPlan(input: {
  taskId: string
  goal: string
  workingDirectory?: string
  projectBrief?: any
  providers: ModelProvider[]
  settings: Settings
  analysis?: ProjectAnalysis | null
  skipAnalysis?: boolean
  traits?: string[]
  messages?: Message[]
}): Promise<TaskExecutionPlan> {
  const contextBudget = planningContextBudgetForProviders(input.providers, input.traits)

  // Phase 1: Analyze only before user confirmation. After the user confirms
  // the summary, reuse that confirmed analysis so planning cannot restart
  // clarification questions.
  const analysis = input.skipAnalysis
    ? input.analysis ?? null
    : await runAnalyzePhase({
        taskId: input.taskId,
        goal: input.goal,
        workingDirectory: input.workingDirectory,
        providers: input.providers,
        settings: input.settings,
        contextBudget,
        messages: input.messages,
      })
  
  // Phase 2: Plan (DAG generation)
  const plan = await runPlanPhase({
    taskId: input.taskId,
    goal: input.goal,
    workingDirectory: input.workingDirectory,
    providers: input.providers,
    settings: input.settings,
    contextBudget
  }, analysis)

  if (plan) {
    // Merge in validation tracking which is required by the current engine
    plan.validation = {
      devServerChecked: false,
      consoleChecked: false,
      screenshotChecked: false,
      buildChecked: false,
    }
    return normalizeTaskExecutionPlan(plan)
  }

  console.warn('Dynamic planning failed, using fallback plan')
  const fallbackPlan = createCodingDesignTaskPlan({
    taskId: input.taskId,
    goal: input.goal,
    workingDirectory: input.workingDirectory,
    architectureConstraints: typeof analysis?.architecture === 'string' ? analysis.architecture : undefined,
  })
  return normalizeTaskExecutionPlan(fallbackPlan)
}

import { TaskGraph } from './runtime/taskGraph'

export function nextTaskStep(plan: TaskExecutionPlan): TaskExecutionStep | null {
  const graph = new TaskGraph(plan)
  const step = graph.getNextStep()
  return step ? { ...step, requiredTools: normalizeRequiredTools(step.requiredTools) } : null
}

export function getNodesByLayer(plan: TaskExecutionPlan): TaskExecutionStep[][] {
  const allSteps = plan.steps
  const layers: TaskExecutionStep[][] = []
  
  // Track assigned layers for each step id
  const stepLayerMap = new Map<string, number>()
  
  let unassigned = [...allSteps]
  
  // Max safe iterations to prevent infinite loops on circular dependencies (which shouldn't happen)
  let sanityCheck = 0
  while (unassigned.length > 0 && sanityCheck < 1000) {
    sanityCheck++
    
    // Find nodes whose dependencies are all already assigned to a layer
    const assignable = unassigned.filter(step => {
      if (!step.dependsOn || step.dependsOn.length === 0) return true
      return step.dependsOn.every(depId => stepLayerMap.has(depId))
    })
    
    // Assign these to the max layer of their dependencies + 1
    assignable.forEach(step => {
      let maxDepLayer = -1
      if (step.dependsOn) {
        step.dependsOn.forEach(depId => {
          const depLayer = stepLayerMap.get(depId)
          if (depLayer !== undefined && depLayer > maxDepLayer) {
            maxDepLayer = depLayer
          }
        })
      }
      const myLayer = maxDepLayer + 1
      stepLayerMap.set(step.id, myLayer)
      
      if (!layers[myLayer]) {
        layers[myLayer] = []
      }
      layers[myLayer].push(step)
    })
    
    // Remove assigned from unassigned
    unassigned = unassigned.filter(step => !stepLayerMap.has(step.id))
  }
  
  return layers
}

export function buildTaskStepPrompt(plan: TaskExecutionPlan, step: TaskExecutionStep, finalReportAllowed: boolean): string {
  const allowed = step.requiredTools.length > 0 ? step.requiredTools.join(', ') : '(no tool required)'
  return [
    'Task Execution Engine:',
    `Goal: ${plan.goal}`,
    `Working directory: ${plan.workingDirectory}`,
    `Current step: ${step.id} - ${step.title}`,
    `Allowed/expected tools for this step: ${allowed}`,
    `Completion signals: ${step.completionSignals.join(', ')}`,
    step.lastToolSummary ? `Previous attempt summary: ${step.lastToolSummary}` : '',
    step.lastProcessId ? `Previous background process id: ${step.lastProcessId}. Check it with process.status/process.logs/process.wait before repeating work.` : '',
    finalReportAllowed
      ? 'Final report is allowed now. Include changed files, validation result, and remaining risks.'
      : 'Do not provide a final report yet. Complete only the current step, preferably with one necessary tool call.',
    'If a tool is needed, call the tool instead of describing what you will do.',
  ].filter(Boolean).join('\n')
}

export function updatePlanValidation(plan: TaskExecutionPlan, parts: ContentPart[]): TaskExecutionValidation {
  const validation = { ...plan.validation }
  for (const part of okToolParts(parts)) {
    if (part.name === 'devserver.start') validation.devServerChecked = true
    if (part.name === 'preview.console') validation.consoleChecked = true
    if (part.name === 'preview.screenshot') validation.screenshotChecked = true
    if (part.name === 'project.validate') validation.buildChecked = true
    if (part.name === 'process.wait' && processWaitSucceeded(part.result)) validation.buildChecked = true
    if (part.name === 'shell.run_command' && looksLikeValidationCommand(part.args)) validation.buildChecked = true
  }
  return validation
}

export function evaluateStepCompletion(input: {
  plan: TaskExecutionPlan
  step: TaskExecutionStep
  parts: ContentPart[]
  fullContent: string
}): { complete: boolean; blocked?: string; needsRepair?: string } {
  const { plan, step, parts, fullContent } = input
  const effectiveStep = plan.steps.find(candidate => candidate.id === step.id) ?? step
  const role = stepRole(step)

  if ((role === 'scaffold' || role === 'install') && requiresPackageJsonEvidence(step)) {
    const okTools = okToolParts(parts)
    if (hasPackageJsonEvidence(okTools)) return { complete: true }
    if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
      const summary = summarizeRoundForBlock(parts, fullContent)
      return {
        complete: false,
        blocked: `Step "${step.title}" did not prove package.json exists after ${MAX_STEP_ATTEMPTS} attempt(s). It must create/read/detect package.json before moving on.${summary ? `\n\n${summary}` : ''}`,
      }
    }
    return { complete: false }
  }

  if (role === 'final_report') {
    if (!finalValidationGateSatisfied(plan.validation, plan)) {
      return { complete: false, blocked: finalReportBlockedReason(plan) }
    }
    return { complete: fullContent.trim().length > 0 }
  }

  // ── Special handling for validate ──
  // A failed project.validate is NOT a blocker — it means we have build errors
  // and should route back to repair with the error details.
  if (role === 'validate') {
    const okTools = okToolParts(parts)
    const failedValidate = failedToolParts(parts).filter(p =>
      p.name === 'project.validate' ||
      (p.name === 'shell.run_command' && looksLikeValidationCommand(p.args))
    )
    const failedProcessWait = okTools.filter(p => p.name === 'process.wait' && !processWaitSucceeded(p.result))
    const allFailedValidate = [...failedValidate, ...failedProcessWait]

    if (okTools.some(p =>
      p.name === 'project.validate' ||
      (p.name === 'process.wait' && processWaitSucceeded(p.result)) ||
      (p.name === 'shell.run_command' && looksLikeValidationCommand(p.args))
    )) {
      return { complete: true }
    }

    if (allFailedValidate.length > 0) {
      const errSummary = allFailedValidate
        .map(p => p.error ?? JSON.stringify(p.result).slice(0, 600))
        .join('\n---\n')
      if (step.attempts >= MAX_VALIDATE_REPAIR_CYCLES) {
        return {
          complete: false,
          blocked: `Validation failed after ${MAX_VALIDATE_REPAIR_CYCLES} repair cycle(s). Build errors:\n${errSummary}`,
        }
      }
      return {
        complete: false,
        needsRepair: `project.validate failed with the following errors — fix them before retrying:\n${errSummary}`,
      }
    }

    if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
      const summary = summarizeRoundForBlock(parts, fullContent)
      return {
        complete: false,
        blocked: `Step "${step.title}" did not call project.validate after ${MAX_STEP_ATTEMPTS} attempt(s).${summary ? `\n\n${summary}` : ''}`,
      }
    }
    return { complete: false }
  }

  if (role === 'feature') {
    const okTools = okToolParts(parts)
    if (featureStepHasCompletionEvidence(effectiveStep, okTools)) return { complete: true }
    if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
      const summary = summarizeRoundForBlock(parts, fullContent)
      return {
        complete: false,
        blocked: `Step "${step.title}" did not verify completed file changes after ${MAX_STEP_ATTEMPTS} attempt(s). It must edit files and then verify the project state with project.map, file.stat, or file.read_text before moving on.${summary ? `\n\n${summary}` : ''}`,
      }
    }
    return { complete: false }
  }

  if (role === 'repair') {
    const okTools = okToolParts(parts)
    if (okTools.some(part => part.name === 'file.write_text' || part.name === 'file.patch' || (part.name === 'shell.run_command' && looksLikeValidationCommand(part.args)))) {
      return { complete: true }
    }
    if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
      const summary = summarizeRoundForBlock(parts, fullContent)
      return {
        complete: false,
        blocked: `Step "${step.title}" did not perform a repair action after ${MAX_STEP_ATTEMPTS} attempt(s). It must write, patch, or run a repair/validation command before moving on.${summary ? `\n\n${summary}` : ''}`,
      }
    }
    return { complete: false }
  }

  const okTools = okToolParts(parts)
  // Inspect-role steps are satisfied by ANY successful read-only inspection
  // tool, not just the planner's preferred one. The planner's `requiredTools`
  // is a hint; the model often picks an equivalent sibling (e.g. project.map
  // instead of file.list_dir). Forcing the exact match wastes loop budget on
  // semantically-complete work.
  const inspectionEquivalents = new Set([
    'file.read_text',
    'file.list_dir',
    'file.stat',
    'project.map',
    'project.detect',
    'search.ripgrep',
  ])
  const isInspectRole = role === 'inspect'

  const matchesRequired = (name: string) =>
    step.requiredTools.includes(name) || (isInspectRole && inspectionEquivalents.has(name))
  const complete = step.requiredTools.length === 0
    ? fullContent.trim().length > 0
    : step.requiredTools.includes('process.wait')
      ? okTools.some(part => part.name === 'process.wait' && processWaitSucceeded(part.result))
      : okTools.some(part => matchesRequired(part.name))
  if (complete) return { complete: true }
  if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
    const summary = summarizeRoundForBlock(parts, fullContent)
    return {
      complete: false,
      blocked: `Step "${step.title}" did not complete after ${MAX_STEP_ATTEMPTS} attempt(s). Required tool: ${step.requiredTools.join(' or ')}.${summary ? `\n\n${summary}` : ''}`,
    }
  }
  return { complete: false }
}

export function recoverStepFromRound(plan: TaskExecutionPlan, stepId: string, parts: ContentPart[], fullContent: string): TaskExecutionPlan {
  const recovery = taskStepRecovery(parts, fullContent)
  const evidence = taskStepEvidence(parts)
  if (!recovery && evidence.length === 0) return plan
  return updateStep(plan, stepId, step => ({
    ...step,
    lastToolSummary: recovery?.summary ?? step.lastToolSummary,
    lastProcessId: recovery?.processId ?? step.lastProcessId,
    lastCommand: recovery?.command ?? step.lastCommand,
    lastExitCode: recovery?.exitCode ?? step.lastExitCode,
    lastRecoveredAt: Date.now(),
    evidence: [...(step.evidence ?? []), ...evidence].slice(-20),
  }))
}

function taskStepEvidence(parts: ContentPart[]): NonNullable<TaskExecutionStep['evidence']> {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
    .map(part => ({
      toolName: part.name,
      toolCallId: part.id,
      status: part.status,
      timestamp: part.endedAt ?? part.startedAt ?? Date.now(),
      summary: toolEvidenceSummary(part),
      processId: extractProcessId(part.result),
      command: commandSummary(part),
      exitCode: extractExitCode(part.result),
      persistedOutputPath: extractPersistedOutputPath(part),
    }))
}

export function taskStepRecovery(parts: ContentPart[], fullContent: string): {
  summary: string
  processId?: string
  command?: string
  exitCode?: number | null
} | null {
  const tools = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
  if (tools.length === 0 && !fullContent.trim()) return null
  const latestProcess = [...tools].reverse().find(p => p.name.startsWith('process.') || p.name === 'devserver.start')
  const latestCommand = [...tools].reverse().find(p => p.name === 'shell.run_command' || p.name === 'process.start')
  const view = latestProcess?.result ?? latestCommand?.result
  return {
    summary: summarizeRoundForBlock(parts, fullContent).slice(0, 1200),
    processId: extractProcessId(view),
    command: commandSummary(latestCommand),
    exitCode: extractExitCode(view),
  }
}

function summarizeRoundForBlock(parts: ContentPart[], fullContent: string): string {
  const lines: string[] = []
  const tools = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
  if (tools.length > 0) {
    lines.push('Last attempt tool activity:')
    for (const t of tools.slice(-5)) {
      const args = JSON.stringify(t.args).slice(0, 120)
      const status = t.status === 'ok'
        ? 'ok'
        : t.error
          ? `error: ${t.error.slice(0, 200)}`
          : t.status
      lines.push(`  - ${t.name}(${args}) → ${status}`)
    }
  } else {
    lines.push('Last attempt produced no tool calls.')
  }
  const text = fullContent.trim()
  if (text) {
    lines.push(`Last visible text: ${text.slice(0, 240)}${text.length > 240 ? '…' : ''}`)
  }
  return lines.join('\n')
}

/**
 * Bridges legacy static-plan steps (which keyed off step.id) to the new role
 * taxonomy. Prefers `step.role`; falls back to id-name matching for plans
 * created before this change reached production.
 */
function stepRole(step: TaskExecutionStep): TaskExecutionStep['role'] | undefined {
  if (step.role) return step.role
  switch (step.id) {
    case 'repair': return 'repair'
    case 'validate': return 'validate'
    case 'final_report': return 'final_report'
    case 'check_console': return 'console'
    case 'check_screenshot': return 'screenshot'
    case 'start_preview': return 'preview'
    default: return undefined
  }
}

function finalReportBlockedReason(plan: TaskExecutionPlan): string {
  const missing: string[] = []
  if (planHasRole(plan, 'console') && !plan.validation.consoleChecked) missing.push('console check')
  if (planHasRole(plan, 'screenshot') && !plan.validation.screenshotChecked) missing.push('screenshot check')
  if (planHasRole(plan, 'validate') && !plan.validation.buildChecked) missing.push('validation/build')
  if (missing.length === 0) return 'Final report is blocked.'
  return `Final report is blocked until these checks run: ${missing.join(', ')}.`
}

function planHasRole(plan: TaskExecutionPlan, role: NonNullable<TaskExecutionStep['role']>): boolean {
  return plan.steps.some(s => stepRole(s) === role)
}

export function markStepRunning(plan: TaskExecutionPlan, stepId: string): TaskExecutionPlan {
  return updateStep(plan, stepId, step => ({
    ...step,
    status: 'running',
    attempts: step.attempts + 1,
    lastError: undefined,
  }))
}

export function markStepDone(plan: TaskExecutionPlan, stepId: string): TaskExecutionPlan {
  return updateStep(plan, stepId, step => ({ ...step, status: 'done', lastError: undefined }))
}

export function markStepSkipped(plan: TaskExecutionPlan, stepId: string): TaskExecutionPlan {
  return updateStep(plan, stepId, step => ({ ...step, status: 'skipped', lastError: undefined }))
}

export function blockPlan(plan: TaskExecutionPlan, stepId: string, error: string): TaskExecutionPlan {
  return {
    ...updateStep(plan, stepId, step => ({ ...step, status: 'failed', lastError: error })),
    status: 'blocked',
    updatedAt: Date.now(),
  }
}

export function completePlan(plan: TaskExecutionPlan): TaskExecutionPlan {
  return { ...plan, status: 'completed', currentStepId: undefined, updatedAt: Date.now() }
}

export function withValidation(plan: TaskExecutionPlan, validation: TaskExecutionValidation): TaskExecutionPlan {
  return { ...plan, validation, updatedAt: Date.now() }
}

export function finalValidationGateSatisfied(
  validation: TaskExecutionValidation,
  plan: TaskExecutionPlan,
): boolean {
  const consoleOk = !planHasRole(plan, 'console') || validation.consoleChecked
  const screenshotOk = !planHasRole(plan, 'screenshot') || validation.screenshotChecked
  const buildOk = !planHasRole(plan, 'validate') || validation.buildChecked
  return consoleOk && screenshotOk && buildOk
}

function step(
  id: string,
  title: string,
  requiredTools: string[],
  completionSignals: string[],
  role?: TaskExecutionStep['role'],
  workflowType?: TaskExecutionStep['workflowType'],
): TaskExecutionStep {
  return { id, title, status: 'pending', requiredTools, completionSignals, attempts: 0, role, workflowType }
}

function updateStep(
  plan: TaskExecutionPlan,
  stepId: string,
  updater: (step: TaskExecutionStep) => TaskExecutionStep,
): TaskExecutionPlan {
  const steps = plan.steps.map(step => step.id === stepId ? updater(step) : step)
  const next = steps.find(step => step.status === 'pending' || step.status === 'running' || step.status === 'failed')
  return { ...plan, steps, status: 'running', currentStepId: next?.id, updatedAt: Date.now() }
}

function okToolParts(parts: ContentPart[]): Array<Extract<ContentPart, { type: 'tool_call' }>> {
  return parts.filter((part): part is Extract<ContentPart, { type: 'tool_call' }> =>
    part.type === 'tool_call' && part.status === 'ok' && !toolResultWasIgnored(part.result),
  )
}

function toolResultWasIgnored(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as Record<string, unknown>).ignored === true)
}

function failedToolParts(parts: ContentPart[]): Array<Extract<ContentPart, { type: 'tool_call' }>> {
  return parts.filter((part): part is Extract<ContentPart, { type: 'tool_call' }> =>
    part.type === 'tool_call' && (part.status === 'error' || part.status === 'aborted'),
  )
}

function looksLikeValidationCommand(args: Record<string, unknown>): boolean {
  const rawArgs = Array.isArray(args.args) ? args.args.map(String).join(' ') : ''
  return /\b(build|typecheck|test|lint|tsc)\b/i.test(rawArgs)
}

function processWaitSucceeded(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  return record.status === 'exited' && record.exitCode === 0
}

function requiresPackageJsonEvidence(step: TaskExecutionStep): boolean {
  const text = `${step.id} ${step.title}`.toLowerCase()
  if (/\b(init|initialize|setup|install|deps|dependencies|package|vite|npm)\b/.test(text)) return true
  return step.requiredTools.some(tool => tool === 'project.detect' || tool === 'project.map')
}

function hasPackageJsonEvidence(parts: Array<Extract<ContentPart, { type: 'tool_call' }>>): boolean {
  return parts.some(part => {
    if ((part.name === 'file.read_text' || part.name === 'file.write_text' || part.name === 'file.stat') && pathArgEndsWithPackageJson(part.args)) {
      return true
    }
    if (part.name === 'project.detect' || part.name === 'project.map') {
      return projectResultIncludesPackageJson(part.result)
    }
    return false
  })
}

function featureStepHasCompletionEvidence(
  step: TaskExecutionStep,
  currentOkTools: Array<Extract<ContentPart, { type: 'tool_call' }>>,
): boolean {
  const cumulative = [
    ...(step.evidence ?? []).filter(evidence => evidence.status === 'ok'),
    ...currentOkTools.map(part => ({ toolName: part.name })),
  ]
  const hasEdit = cumulative.some(evidence =>
    evidence.toolName === 'file.write_text' || evidence.toolName === 'file.patch',
  )
  const hasVerification = cumulative.some(evidence =>
    evidence.toolName === 'project.map' ||
    evidence.toolName === 'project.detect' ||
    evidence.toolName === 'file.stat' ||
    evidence.toolName === 'file.read_text' ||
    evidence.toolName === 'file.list_dir',
  )
  return hasEdit && hasVerification
}

function pathArgEndsWithPackageJson(args: Record<string, unknown>): boolean {
  const path = typeof args.path === 'string' ? args.path.replace(/\\/g, '/').toLowerCase() : ''
  return path.endsWith('/package.json')
}

function projectResultIncludesPackageJson(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  let files: unknown[] = []
  if (Array.isArray(record.files)) {
    files = record.files
  } else if (record.detected && typeof record.detected === 'object') {
    const detected = record.detected as Record<string, unknown>
    if (Array.isArray(detected.files)) files = detected.files
  }
  return files.some((file: unknown) => typeof file === 'string' && file.replace(/\\/g, '/').toLowerCase().endsWith('package.json'))
}

function extractProcessId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  const id = record.processId ?? record.id
  return typeof id === 'string' ? id : undefined
}

function extractExitCode(result: unknown): number | null | undefined {
  if (!result || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  return typeof record.exitCode === 'number' || record.exitCode === null ? record.exitCode : undefined
}

function extractPersistedOutputPath(part: Extract<ContentPart, { type: 'tool_call' }>): string | undefined {
  if (part.persistedOutput?.path) return part.persistedOutput.path
  if (!part.result || typeof part.result !== 'object') return undefined
  const persisted = (part.result as Record<string, unknown>).persistedOutput
  if (!persisted || typeof persisted !== 'object') return undefined
  const path = (persisted as Record<string, unknown>).path
  return typeof path === 'string' ? path : undefined
}

function toolEvidenceSummary(part: Extract<ContentPart, { type: 'tool_call' }>): string {
  const bits = [`${part.name}: ${part.status}`]
  const command = commandSummary(part)
  if (command && command !== part.name) bits.push(command)
  const exitCode = extractExitCode(part.result)
  if (exitCode !== undefined) bits.push(`exitCode=${exitCode}`)
  const processId = extractProcessId(part.result)
  if (processId) bits.push(`processId=${processId}`)
  const persistedOutputPath = extractPersistedOutputPath(part)
  if (persistedOutputPath) bits.push(`persisted=${persistedOutputPath}`)
  return bits.join(' | ').slice(0, 500)
}

function commandSummary(part?: Extract<ContentPart, { type: 'tool_call' }>): string | undefined {
  if (!part) return undefined
  const command = typeof part.args.command === 'string' ? part.args.command : undefined
  const args = Array.isArray(part.args.args) ? part.args.args.map(String) : []
  return command ? [command, ...args].join(' ') : part.name
}
