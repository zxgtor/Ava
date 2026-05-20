import type { ContentPart, TaskExecutionStep } from '../../../types'

export function successfulWriteProgress(parts: ContentPart[]): number {
  return parts.filter(part =>
    part.type === 'tool_call' &&
    part.status === 'ok' &&
    (part.name === 'file.write_text' || part.name === 'file.patch'),
  ).length
}

export function shouldContinueAfterToolLimit(parts: ContentPart[], activeStep?: TaskExecutionStep): boolean {
  if (successfulWriteProgress(parts) === 0) return false
  if (!activeStep) return true
  const role = activeStep.role
  return role === 'feature' || role === 'scaffold' || role === 'repair' || role === 'install'
}

export function toolProgressContinuationText(stepTitle: string, parts: ContentPart[]): string {
  return [
    `Tool loop budget was reached during step "${stepTitle}", but the last round made file-edit progress.`,
    `Successful file edits this round: ${successfulWriteProgress(parts)}.`,
    'Continue from the current filesystem state. Do not rewrite files that already exist unless repair is needed.',
    'First inspect/map the project if unsure what remains, then finish only the smallest remaining action for this step.',
  ].join('\n')
}
