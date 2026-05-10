import type { TaskExecutionStep } from '../../types'

const DEFAULT_TOOL_LOOP_BUDGET = 10
const MAX_TOOL_LOOP_BUDGET = 50
const FINAL_REPORT_READ_BUDGET = 3

const STEP_BUDGETS: Array<{ pattern: RegExp; budget: number }> = [
  { pattern: /final[_-]?report|report/i, budget: 4 },
  { pattern: /inspect|map|detect|read|scan/i, budget: 10 },
  { pattern: /scaffold|setup|write|create|core|ui|component|file/i, budget: 30 },
  { pattern: /install|depend/i, budget: 10 },
  { pattern: /preview|server|start/i, budget: 6 },
  { pattern: /console|screenshot|check/i, budget: 6 },
  { pattern: /repair|fix/i, budget: 25 },
  // Validate steps run build/typecheck, then need patch + revalidate cycles
  // for each error. With 6 type errors, that's 12+ tool calls. 10 was too
  // tight — bump to 30 to allow the full fix-revalidate loop.
  { pattern: /validate|build|test|typecheck/i, budget: 30 },
]

const ROLE_BUDGETS: Record<NonNullable<TaskExecutionStep['role']>, number> = {
  inspect: 10,
  scaffold: 30,
  install: 10,
  feature: 30,
  preview: 6,
  console: 6,
  screenshot: 6,
  repair: 25,
  validate: 30,
  final_report: 4,
}

export interface LargeTaskPlanDecision {
  block: boolean
  reason?: string
}

export function toolLoopBudgetForStep(
  step?: Pick<TaskExecutionStep, 'id' | 'title' | 'role'>,
  requestedBudget?: number,
): number {
  if (typeof requestedBudget === 'number' && Number.isFinite(requestedBudget)) {
    return clampBudget(requestedBudget)
  }
  if (!step) return DEFAULT_TOOL_LOOP_BUDGET
  if (step.role && ROLE_BUDGETS[step.role] !== undefined) return clampBudget(ROLE_BUDGETS[step.role])

  const key = `${step.id} ${step.title}`
  const matched = STEP_BUDGETS.find(item => item.pattern.test(key))
  return clampBudget(matched?.budget ?? DEFAULT_TOOL_LOOP_BUDGET)
}

export function finalReportReadBudgetForStep(
  step?: Pick<TaskExecutionStep, 'id' | 'title' | 'role'>,
): number | undefined {
  if (!step) return undefined
  if (step.role) return step.role === 'final_report' ? FINAL_REPORT_READ_BUDGET : undefined
  return /final[_-]?report|report/i.test(`${step.id} ${step.title}`) ? FINAL_REPORT_READ_BUDGET : undefined
}

export function shouldBlockLargeTaskWithoutPlan(input: {
  isLargeTask: boolean
  hasTaskPlan: boolean
  hasActiveStep: boolean
}): LargeTaskPlanDecision {
  if (!input.isLargeTask) return { block: false }
  if (input.hasTaskPlan && input.hasActiveStep) return { block: false }

  return {
    block: true,
    reason: 'Large task execution requires an active TaskExecutionPlan and current step before tools can run.',
  }
}

function clampBudget(value: number): number {
  return Math.max(1, Math.min(MAX_TOOL_LOOP_BUDGET, Math.floor(value)))
}

