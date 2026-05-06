import type { ModelProvider, Settings, TaskExecutionStep } from '../../../types'
import { CRITIC_REVIEW } from '../prompts/templates'

export interface CriticInput {
  step: TaskExecutionStep
  diffOrOutput: string
  architectureConstraints: string
  providers: ModelProvider[]
  settings: Settings
}

export interface CriticReviewResult {
  status: 'approved' | 'rejected'
  comment: string
}

export async function runCriticPhase(input: CriticInput): Promise<CriticReviewResult> {
  const streamId = `critic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
  const systemPrompt = [
    CRITIC_REVIEW,
    `Task Goal: ${input.step.title}`,
    `Architecture Rules: \n${input.architectureConstraints}`,
    `Executor Output / Diff:\n${input.diffOrOutput}`
  ].join('\n\n')

  try {
    const reply = await window.ava.llm.stream({
      streamId,
      messages: [{ role: 'system', content: systemPrompt }],
      providers: input.providers,
      temperature: 0.1,
      pluginStates: input.settings.pluginStates,
      toolFormatMap: input.settings.modelToolFormatMap,
    })

    if (!reply.ok) {
      console.warn('Critic phase failed to reach LLM:', reply.error)
      return { status: 'rejected', comment: 'Network or API error preventing review.' }
    }

    const jsonMatch = reply.result.fullContent.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                      reply.result.fullContent.match(/(\{[\s\S]*\})/)
    
    if (!jsonMatch) {
      return { status: 'approved', comment: 'No structured critique found, assuming ok.' }
    }

    const parsed = JSON.parse(jsonMatch[1]) as CriticReviewResult
    return {
      status: parsed.status === 'rejected' ? 'rejected' : 'approved',
      comment: parsed.comment || ''
    }
  } catch (err) {
    console.error('Error in critic phase:', err)
    return { status: 'rejected', comment: 'Failed to parse critic response.' }
  }
}
