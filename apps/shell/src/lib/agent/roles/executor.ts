import type { TaskExecutionPlan, TaskExecutionStep, Message, ModelProvider, Settings } from '../../../types'
import { EXECUTOR_SCAFFOLD, EXECUTOR_FEATURE, EXECUTOR_DEBUG, EXECUTOR_REFACTOR } from '../prompts/templates'

export interface ExecutorInput {
  plan: TaskExecutionPlan
  step: TaskExecutionStep
  memoryState: string
  providers: ModelProvider[]
  settings: Settings
}

export function getExecutorTemplate(workflowType?: string): string {
  switch (workflowType) {
    case 'scaffold': return EXECUTOR_SCAFFOLD
    case 'debug': return EXECUTOR_DEBUG
    case 'refactor': return EXECUTOR_REFACTOR
    case 'feature':
    default:
      return EXECUTOR_FEATURE
  }
}

export function buildExecutorSystemPrompt(input: ExecutorInput): string {
  const template = getExecutorTemplate(input.step.workflowType)
  
  return [
    template,
    `Goal for this step: ${input.step.title}`,
    `Working Directory: ${input.plan.workingDirectory}`,
    `Memory State (Completed Tasks context):\n${input.memoryState || 'None'}`,
    `Allowed Tools: ${input.step.requiredTools.join(', ') || 'All tools allowed'}`,
    `Self-Correction: If a tool fails, analyze the error and retry locally before giving up. Maximum retries: 2.`
  ].join('\n\n')
}
