import type { ContentPart, Message, ModelProvider, ProjectAnalysis, Settings, TaskExecutionPlan, TaskExecutionStep, TaskExecutionValidation } from '../../types'
import { planningContextBudgetForProviders } from './chat'
import { normalizeRequiredTools } from './toolNames'

const CODING_DESIGN_TASK_RE =
  /\b(3d|three\.?js|animation|animated|site|website|landing page|app|full app|project|professional|production ready|complete|responsive|dashboard|frontend|ui|ux|migrate|refactor|implement feature|create|build|generate)\b|三维|动画|网站|站点|落地页|应用|完整|专业|响应式|前端|界面|迁移|重构|项目/i

const MAX_STEP_ATTEMPTS = 3
const MAX_VALIDATE_REPAIR_CYCLES = 2

export function normalizeTaskExecutionPlan(plan: TaskExecutionPlan): TaskExecutionPlan {
  const normalizedSteps = ensureFrontendValidationSteps(plan.steps.map(step => ({
    ...step,
    requiredTools: normalizeRequiredTools(step.requiredTools),
  })))
  return {
    ...plan,
    steps: normalizedSteps,
  }
}

function ensureFrontendValidationSteps(steps: TaskExecutionStep[]): TaskExecutionStep[] {
  const hasPreview = steps.some(step => stepRole(step) === 'preview')
  if (!hasPreview) return steps

  const hasConsole = steps.some(step => stepRole(step) === 'console')
  const hasScreenshot = steps.some(step => stepRole(step) === 'screenshot')
  if (hasConsole && hasScreenshot) return steps

  const previewIndex = steps.findIndex(step => stepRole(step) === 'preview')
  const insertAt = previewIndex >= 0 ? previewIndex + 1 : steps.length
  const injected: TaskExecutionStep[] = []
  if (!hasConsole) {
    injected.push(step('check_console', 'Check browser console', ['preview.console', 'devserver.status', 'devserver.start'], ['console checked'], 'console', 'debug'))
  }
  if (!hasScreenshot) {
    injected.push(step('check_screenshot', 'Capture preview screenshot', ['preview.screenshot', 'devserver.status', 'devserver.start'], ['screenshot checked'], 'screenshot', 'research'))
  }
  return [...steps.slice(0, insertAt), ...injected, ...steps.slice(insertAt)]
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
        ['preview.console', 'devserver.status', 'devserver.start'],
        ['console checked'], 'console', 'debug'),
      step('check_screenshot', 'Capture preview screenshot',
        ['preview.screenshot', 'devserver.status', 'devserver.start'],
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
  const role = stepRole(step)
  return [
    'Task Execution Engine:',
    `Goal: ${plan.goal}`,
    `Working directory: ${plan.workingDirectory}`,
    `Current step: ${step.id} - ${step.title}`,
    `Allowed/expected tools for this step: ${allowed}`,
    `Completion signals: ${step.completionSignals.join(', ')}`,
    stepRoleInstruction(role),
    step.lastError ? `Blocking error to fix:\n${step.lastError}` : '',
    step.lastToolSummary ? `Previous attempt summary: ${step.lastToolSummary}` : '',
    step.lastProcessId ? `Previous background process id: ${step.lastProcessId}. Check it with process.status/process.logs/process.wait before repeating work.` : '',
    role === 'final_report'
      ? 'FINAL REPORT STEP: write the visible final report now. Do not say what you will do. Do not call tools unless a required fact is missing. Include these sections: Changed files, Validation result, Preview result, Remaining risks.'
      : finalReportAllowed
        ? 'Final report is allowed now. Include changed files, validation result, and remaining risks.'
        : 'Do not provide a final report yet. Complete only the current step, preferably with one necessary tool call.',
    'If a tool is needed, call the tool instead of describing what you will do.',
  ].filter(Boolean).join('\n')
}

function stepRoleInstruction(role: ReturnType<typeof stepRole>): string {
  switch (role) {
    case 'inspect':
      return 'INSPECT STEP: gather only the minimal project facts needed for the next step. Do not edit files in this step.'
    case 'scaffold':
      return 'SCAFFOLD STEP: create or verify the project structure. The step is not complete until package.json or the requested scaffold artifact exists.'
    case 'install':
      return 'INSTALL STEP: install or verify dependencies. The step is not complete until package/dependency evidence exists.'
    case 'feature':
      return 'FEATURE STEP: implement the current feature by editing files with file.write_text or file.patch. Read-only inspection does not complete this step. After editing, verify the changed files with file.read_text, file.stat, file.list_dir, project.detect, or project.map.'
    case 'validate':
      return 'VALIDATE STEP: run project.validate first. For frontend/preview tasks, npm run build (or equivalent build script) must pass; typecheck/lint alone is not enough. A command only passes if the actual exit code is 0.'
    case 'repair':
      return 'REPAIR STEP: fix the specific error with file.patch/file.write_text or a repair command. Read-only inspection alone does not complete this step.'
    case 'preview':
      return 'PREVIEW STEP: start or verify the development server and use the actual returned local URL; do not assume a default port.'
    case 'console':
      return 'CONSOLE STEP: inspect the running preview with preview.console. devserver.status/start alone does not complete this step.'
    case 'screenshot':
      return 'SCREENSHOT STEP: capture the running preview with preview.screenshot. devserver.status/start alone does not complete this step.'
    case 'final_report':
      return 'FINAL REPORT STEP: summarize only after all validation gates pass.'
    default:
      return ''
  }
}

export function updatePlanValidation(
  plan: TaskExecutionPlan,
  parts: ContentPart[],
  step?: TaskExecutionStep | null,
): TaskExecutionValidation {
  const validation = { ...plan.validation }
  const role = step ? stepRole(step) : undefined
  for (const part of okToolParts(parts)) {
    if (role === 'preview' && part.name === 'devserver.start') validation.devServerChecked = true
    if (role === 'console' && part.name === 'preview.console') validation.consoleChecked = true
    if (role === 'screenshot' && part.name === 'preview.screenshot') validation.screenshotChecked = true
    if (role === 'validate' && validationToolSucceeded(part, plan)) validation.buildChecked = true
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
    if (finalReportHasRequiredContent(fullContent)) return { complete: true }
    if (effectiveStep.attempts >= MAX_STEP_ATTEMPTS) {
      return {
        complete: false,
        blocked: `Step "${step.title}" did not produce a final report after ${MAX_STEP_ATTEMPTS} attempt(s). It must include changed files, validation result, preview result, and remaining risks.`,
      }
    }
    return { complete: false }
  }

  // ── Special handling for validate ──
  // A failed project.validate is NOT a blocker — it means we have build errors
  // and should route back to repair with the error details.
  if (role === 'validate') {
    const okTools = okToolParts(parts)
    const allFailedValidate = parts
      .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
      .filter(part => validationToolFailed(part, plan))

    if (okTools.some(part => validationToolSucceeded(part, plan))) {
      return { complete: true }
    }

    const weakValidationTools = okTools.filter(part => validationToolIsTooWeakForPlan(part, plan))
    if (weakValidationTools.length > 0) {
      if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
        const summary = summarizeRoundForBlock(parts, fullContent)
        return {
          complete: false,
          blocked: `Step "${step.title}" only ran weak validation after ${MAX_STEP_ATTEMPTS} attempt(s). Frontend/preview tasks must pass project.validate or an explicit build command such as npm run build before moving on.${summary ? `\n\n${summary}` : ''}`,
        }
      }
      return { complete: false }
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
    : role === 'console'
      ? okTools.some(part => part.name === 'preview.console')
    : role === 'screenshot'
      ? okTools.some(part => part.name === 'preview.screenshot')
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

function finalReportHasRequiredContent(fullContent: string): boolean {
  const visible = fullContent
    .replace(/<(?:think|thinking|antThinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking|antThinking)>/gi, '')
    .replace(/<(?:think|thinking|antThinking)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/(?:think|thinking|antThinking)>/gi, '')
    .trim()
  if (!visible) return false
  const hasFiles = /(changed files?|files changed|modified files?|已修改|修改文件|变更文件)/i.test(visible)
  const hasValidation = /(validation|validated|build|typecheck|preview|console|screenshot|验证|校验|构建|预览|控制台|截图)/i.test(visible)
  const hasRisks = /(remaining risks?|risks?|风险|剩余风险)/i.test(visible)
  return hasFiles && hasValidation && hasRisks
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

function looksLikeBuildCommand(args: Record<string, unknown>): boolean {
  const command = typeof args.command === 'string' ? args.command : ''
  const rawArgs = Array.isArray(args.args) ? args.args.map(String).join(' ') : ''
  const joined = `${command} ${rawArgs}`
  return /\b(build|next\s+build|vite\s+build|astro\s+build|tsc\s+-b\s+&&\s+vite\s+build)\b/i.test(joined)
}

function commandSucceeded(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  return record.exitCode === 0 || record.code === 0
}

function projectValidateSucceeded(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true
  const record = result as Record<string, unknown>
  if (record.ok === false || record.success === false || record.valid === false) return false
  if ('exitCode' in record || 'code' in record) return commandSucceeded(record)
  return true
}

function validationRequiresBuild(plan?: TaskExecutionPlan): boolean {
  if (!plan) return false
  return plan.kind === 'coding-design' && (
    planHasRole(plan, 'preview') ||
    planHasRole(plan, 'console') ||
    planHasRole(plan, 'screenshot')
  )
}

function validationToolIsTooWeakForPlan(
  part: Extract<ContentPart, { type: 'tool_call' }>,
  plan?: TaskExecutionPlan,
): boolean {
  return part.status === 'ok' &&
    !toolResultWasIgnored(part.result) &&
    validationRequiresBuild(plan) &&
    part.name === 'shell.run_command' &&
    looksLikeValidationCommand(part.args) &&
    !looksLikeBuildCommand(part.args) &&
    commandSucceeded(part.result)
}

function validationToolSucceeded(
  part: Extract<ContentPart, { type: 'tool_call' }>,
  plan?: TaskExecutionPlan,
): boolean {
  if (part.status !== 'ok' || toolResultWasIgnored(part.result)) return false
  if (part.name === 'project.validate') return projectValidateSucceeded(part.result)
  if (part.name === 'process.wait') return processWaitSucceeded(part.result)
  if (part.name === 'shell.run_command' && looksLikeValidationCommand(part.args)) {
    if (validationRequiresBuild(plan) && !looksLikeBuildCommand(part.args)) return false
    return commandSucceeded(part.result)
  }
  return false
}

function validationToolFailed(
  part: Extract<ContentPart, { type: 'tool_call' }>,
  plan?: TaskExecutionPlan,
): boolean {
  if (toolResultWasIgnored(part.result)) return false
  const isValidationTool = part.name === 'project.validate' ||
    part.name === 'process.wait' ||
    (part.name === 'shell.run_command' && looksLikeValidationCommand(part.args))
  if (!isValidationTool) return false
  if (validationToolIsTooWeakForPlan(part, plan)) return false
  if (part.status === 'error' || part.status === 'aborted') return true
  if (part.status !== 'ok') return false
  return !validationToolSucceeded(part, plan)
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
