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
  const match = content.match(/[A-Za-z]:[\\/][^\r\n"'`<>|]+/)
  return match?.[0]?.trim().replace(/[.,;:，。；：]+$/, '')
}

export function createCodingDesignTaskPlan(input: {
  taskId: string
  goal: string
  workingDirectory?: string
}): TaskExecutionPlan {
  const now = Date.now()
  return {
    taskId: input.taskId,
    status: 'running',
    goal: input.goal,
    workingDirectory: input.workingDirectory || '(no active folder)',
    kind: 'coding-design',
    currentStepId: 'inspect_project',
    validation: {
      devServerChecked: false,
      consoleChecked: false,
      screenshotChecked: false,
      buildChecked: false,
    },
    steps: [
      step('inspect_project', 'Inspect project state',
        ['project.map', 'project.detect', 'file.list_dir', 'file.read_text', 'shell.run_command'],
        ['project mapped'], 'inspect', 'research'),
      step('setup_project', 'Initialize or complete project structure',
        ['shell.run_command', 'file.create_dir', 'file.write_text', 'file.read_text'],
        ['project structure ready'], 'scaffold', 'scaffold'),
      step('install_dependencies', 'Install or confirm required dependencies',
        ['shell.run_command', 'project.detect'],
        ['dependencies ready'], 'install', 'scaffold'),
      step('write_core_files', 'Write core app, 3D scene, loader, controls, and styles',
        ['file.write_text', 'file.patch', 'file.read_text'],
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
        ['project.validate', 'shell.run_command'],
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
  const fallbackPlan = createCodingDesignTaskPlan(input)
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
    finalReportAllowed
      ? 'Final report is allowed now. Include changed files, validation result, and remaining risks.'
      : 'Do not provide a final report yet. Complete only the current step, preferably with one necessary tool call.',
    'If a tool is needed, call the tool instead of describing what you will do.',
  ].join('\n')
}

export function updatePlanValidation(plan: TaskExecutionPlan, parts: ContentPart[]): TaskExecutionValidation {
  const validation = { ...plan.validation }
  for (const part of okToolParts(parts)) {
    if (part.name === 'devserver.start') validation.devServerChecked = true
    if (part.name === 'preview.console') validation.consoleChecked = true
    if (part.name === 'preview.screenshot') validation.screenshotChecked = true
    if (part.name === 'project.validate') validation.buildChecked = true
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
  const role = stepRole(step)

  if (role === 'repair') return { complete: true }

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
      p.name === 'project.validate' || (p.name === 'shell.run_command' && looksLikeValidationCommand(p.args))
    )

    if (okTools.some(p => p.name === 'project.validate' || (p.name === 'shell.run_command' && looksLikeValidationCommand(p.args)))) {
      return { complete: true }
    }

    if (failedValidate.length > 0) {
      const errSummary = failedValidate
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
      return { complete: false, blocked: `Step "${step.title}" did not call project.validate after ${MAX_STEP_ATTEMPTS} attempt(s).` }
    }
    return { complete: false }
  }

  const okTools = okToolParts(parts)
  const complete = step.requiredTools.length === 0
    ? fullContent.trim().length > 0
    : okTools.some(part => step.requiredTools.includes(part.name))
  if (complete) return { complete: true }
  if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
    return { complete: false, blocked: `Step "${step.title}" did not complete after ${MAX_STEP_ATTEMPTS} attempt(s). Missing tool: ${step.requiredTools.join(' or ')}.` }
  }
  return { complete: false }
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
    part.type === 'tool_call' && part.status === 'ok',
  )
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

