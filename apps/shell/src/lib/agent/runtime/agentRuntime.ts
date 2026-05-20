import type { ContentPart, TaskExecutionStep } from '../../../types'
import {
  successfulWriteProgress as sharedSuccessfulWriteProgress,
  shouldContinueAfterToolLimitForRole,
} from '../../../../shared/agentProgressPolicy'

export function successfulWriteProgress(parts: ContentPart[]): number {
  return sharedSuccessfulWriteProgress(parts.filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call'))
}

export function shouldContinueAfterToolLimit(parts: ContentPart[], activeStep?: TaskExecutionStep): boolean {
  return shouldContinueAfterToolLimitForRole(
    parts.filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call'),
    activeStep?.role,
  )
}

export function toolProgressContinuationText(stepTitle: string, parts: ContentPart[]): string {
  return [
    `Tool loop budget was reached during step "${stepTitle}", but the last round made file-edit progress.`,
    `Successful file edits this round: ${successfulWriteProgress(parts)}.`,
    'Continue from the current filesystem state. Do not rewrite files that already exist unless repair is needed.',
    'First inspect/map the project if unsure what remains, then finish only the smallest remaining action for this step.',
  ].join('\n')
}
