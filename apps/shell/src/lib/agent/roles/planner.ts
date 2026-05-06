import type { ModelProvider, Settings, TaskExecutionPlan, ProjectAnalysis } from '../../../types'
import { ANALYZE_TEMPLATE, PLANNER_TEMPLATE } from '../prompts/templates'

export interface PlannerInput {
  taskId: string
  goal: string
  workingDirectory?: string
  providers: ModelProvider[]
  settings: Settings
  contextBudget: number
}

export async function runAnalyzePhase(input: PlannerInput): Promise<ProjectAnalysis | null> {
  const streamId = `analyze_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
  const systemPrompt = [
    ANALYZE_TEMPLATE,
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

    const jsonMatch = reply.result.fullContent.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                      reply.result.fullContent.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) return null

    return JSON.parse(jsonMatch[1]) as ProjectAnalysis
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

    const jsonMatch = reply.result.fullContent.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                      reply.result.fullContent.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[1])
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
      steps: parsed.steps.map((s: any, idx: number) => ({
        id: s.id || `step_${idx + 1}`,
        title: s.title || `Step ${idx + 1}`,
        status: 'pending',
        requiredTools: Array.isArray(s.requiredTools) ? s.requiredTools : [],
        completionSignals: s.completionSignals || ['Done'],
        attempts: 0,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        workflowType: s.workflowType || 'feature'
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
