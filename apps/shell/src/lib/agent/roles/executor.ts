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

const WRITE_TOOLS = new Set(['file.write_text', 'file.patch', 'file.create_dir'])

function requiresWrite(step: ExecutorInput['step']): boolean {
  return step.requiredTools.some(name => WRITE_TOOLS.has(name))
}

export function buildExecutorSystemPrompt(input: ExecutorInput): string {
  const template = getExecutorTemplate(input.step.workflowType)
  const sections = [
    template,
    `Goal for this step: ${input.step.title}`,
    `Working Directory: ${input.plan.workingDirectory}`,
    `Memory State (Completed Tasks context):\n${input.memoryState || 'None'}`,
    `Allowed Tools: ${input.step.requiredTools.join(', ') || 'All tools allowed'}`,
  ]

  if (requiresWrite(input.step)) {
    sections.push([
      'This step expects a write/create tool call to make progress.',
      'Do not call file.read_text or file.list_dir more than once before writing.',
      'Do not output a textual plan; call the write tool now.',
    ].join('\n'))
  }

  sections.push('Self-Correction: If a tool fails, read the error message, adjust, and retry. Maximum retries: 2.')
  return sections.join('\n\n')
}
