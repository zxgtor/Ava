import type { ModelProvider, Settings, TaskExecutionPlan, TaskExecutionStep, ProjectAnalysis, Message } from '../../../types'
import { ANALYZE_TEMPLATE, PLANNER_TEMPLATE } from '../prompts/templates'
import { partsToText } from '../chat'
import { normalizeRequiredTools } from '../toolNames'
import { extractJsonObject } from '../jsonExtraction'

const VALID_ROLES = new Set<NonNullable<TaskExecutionStep['role']>>([
  'inspect', 'scaffold', 'install', 'feature',
  'preview', 'console', 'screenshot', 'repair',
  'validate', 'final_report',
])

function normalizeRole(value: unknown): TaskExecutionStep['role'] {
  if (typeof value !== 'string') return undefined
  return VALID_ROLES.has(value as NonNullable<TaskExecutionStep['role']>)
    ? (value as TaskExecutionStep['role'])
    : undefined
}

const VALID_WORKFLOW_TYPES = new Set<NonNullable<TaskExecutionStep['workflowType']>>([
  'scaffold', 'feature', 'debug', 'refactor', 'research',
])

function normalizeWorkflowType(value: unknown): TaskExecutionStep['workflowType'] {
  if (typeof value !== 'string') return 'feature'
  return VALID_WORKFLOW_TYPES.has(value as NonNullable<TaskExecutionStep['workflowType']>)
    ? (value as TaskExecutionStep['workflowType'])
    : 'feature'
}

export interface PlannerInput {
  taskId: string
  goal: string
  workingDirectory?: string
  providers: ModelProvider[]
  settings: Settings
  contextBudget: number
  messages?: Message[]
}

export async function runAnalyzePhase(input: PlannerInput): Promise<ProjectAnalysis | null> {
  const streamId = `analyze_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
  const historyText = input.messages
    ? input.messages.slice(-10).map(m => `${m.role.toUpperCase()}: ${partsToText(m.content)}`).join('\n\n')
    : ''

  const systemPrompt = [
    ANALYZE_TEMPLATE,
    `Conversation History:\n${historyText}`,
    `Context Budget: ${input.contextBudget} tokens. Ask only the questions required to make a safe executable plan for this budget.`,
    `Goal: ${input.goal}`,
    `Working directory: ${input.workingDirectory || '(none)'}`
  ].join('\n\n')

  try {
    const reply = await window.ava.llm.stream({
      streamId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Please begin the project analysis.' }
      ],
      providers: input.providers,
      temperature: 0.1,
      pluginStates: input.settings.pluginStates,
      toolFormatMap: input.settings.modelToolFormatMap,
    })

    if (!reply.ok) {
      console.warn('Analyze phase failed:', reply.error)
      return null
    }

    const parsed = extractJsonObject(reply.result.fullContent)
    if (!parsed) {
      console.warn('Analyze phase: could not extract JSON from output:', reply.result.fullContent.slice(0, 500))
      return null
    }
    return parsed as unknown as ProjectAnalysis
  } catch (err) {
    console.error('Error in analyze phase:', err)
    return null
  }
}

export async function runPlanPhase(input: PlannerInput, analysis: ProjectAnalysis | null): Promise<TaskExecutionPlan | null> {
  const streamId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
  const systemPrompt = [
    PLANNER_TEMPLATE,
    `Context Budget: ${input.contextBudget} tokens. (Adjust your task granularity accordingly)`,
    `Goal: ${input.goal}`,
    `Working directory: ${input.workingDirectory || '(none)'}`,
    `Analysis: ${analysis ? JSON.stringify(analysis, null, 2) : 'None provided'}`
  ].join('\n\n')

  try {
    const reply = await window.ava.llm.stream({
      streamId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Please generate the execution plan DAG.' }
      ],
      providers: input.providers,
      temperature: 0.2,
      pluginStates: input.settings.pluginStates,
      toolFormatMap: input.settings.modelToolFormatMap,
    })

    if (!reply.ok) {
      console.warn('Plan phase failed:', reply.error)
      return null
    }

    const parsed = extractJsonObject(reply.result.fullContent)
    if (!parsed) {
      console.warn('Plan phase: could not extract JSON from output:', reply.result.fullContent.slice(0, 500))
      return null
    }
    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null
    }

    const now = Date.now()
    return {
      taskId: input.taskId,
      status: 'running',
      goal: input.goal,
      workingDirectory: input.workingDirectory || '(no active folder)',
      kind: 'coding-design',
      steps: (parsed.steps as any[]).map((s: any, idx: number): TaskExecutionStep => ({
        id: s.id || `step_${idx + 1}`,
        title: s.title || `Step ${idx + 1}`,
        status: 'pending',
        requiredTools: normalizeRequiredTools(Array.isArray(s.requiredTools) ? s.requiredTools : []),
        completionSignals: s.completionSignals || ['Done'],
        attempts: 0,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        workflowType: normalizeWorkflowType(s.workflowType),
        role: normalizeRole(s.role),
      })),
      validation: { devServerChecked: false, consoleChecked: false, screenshotChecked: false, buildChecked: false },
      createdAt: now,
      updatedAt: now,
    }
  } catch (err) {
    console.error('Error in plan phase:', err)
    return null
  }
}
