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

  // Extract design assets from the most recent user message:
  // - image_url parts (mockups / screenshots) for vision-capable models
  // - inline HTML reference (<!DOCTYPE / <html or <reference> blocks)
  const lastUserMessage = [...(input.messages ?? [])].reverse().find(m => m.role === 'user')
  const imageUrls: string[] = []
  let referenceHtml = ''
  if (lastUserMessage && Array.isArray(lastUserMessage.content)) {
    for (const part of lastUserMessage.content) {
      if (part.type === 'image_url' && part.image_url?.url) imageUrls.push(part.image_url.url)
      if (part.type === 'text' && typeof part.text === 'string') {
        const htmlMatch = part.text.match(/(<!DOCTYPE[\s\S]*?<\/html>|<html[\s\S]*?<\/html>|<reference[\s\S]*?<\/reference>)/i)
        if (htmlMatch) referenceHtml = htmlMatch[0].slice(0, 8000)
      }
    }
  }

  // Vision capability lookup: if any provider/model on the active set is vision-capable, allow images.
  const caps = input.settings.modelCapabilityMap || {}
  const hasVisionModel = input.providers.some(p => {
    const key = `${p.id}:${p.defaultModel}`
    return caps[key]?.vision === 'yes'
  })

  const systemSections = [
    ANALYZE_TEMPLATE,
    `Conversation History:\n${historyText}`,
    `Context Budget: ${input.contextBudget} tokens. Ask only the questions required to make a safe executable plan for this budget.`,
    `Goal: ${input.goal}`,
    `Working directory: ${input.workingDirectory || '(none)'}`,
  ]
  if (referenceHtml) {
    systemSections.push(`Reference HTML (treat as ground-truth design):\n${referenceHtml}`)
  }
  if (imageUrls.length > 0 && !hasVisionModel) {
    systemSections.push('NOTE: User attached image(s) but the current model is not vision-capable. Add a high-importance unknown asking the user to describe the design in words.')
  }
  const systemPrompt = systemSections.join('\n\n')

  // Build multimodal user content if vision-capable + images present.
  const userContent: any =
    imageUrls.length > 0 && hasVisionModel
      ? [
          { type: 'text', text: 'Please begin the project analysis. Use the attached image(s) as the visual ground truth.' },
          ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
        ]
      : 'Please begin the project analysis.'

  try {
    const reply = await window.ava.llm.stream({
      streamId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
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
      architectureConstraints: typeof analysis?.architecture === 'string' ? analysis.architecture : undefined,
      createdAt: now,
      updatedAt: now,
    }
  } catch (err) {
    console.error('Error in plan phase:', err)
    return null
  }
}
