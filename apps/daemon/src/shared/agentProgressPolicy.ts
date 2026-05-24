export type AgentStepRole =
  | 'inspect'
  | 'scaffold'
  | 'install'
  | 'feature'
  | 'preview'
  | 'console'
  | 'screenshot'
  | 'repair'
  | 'validate'
  | 'final_report'

export interface ProgressToolPart {
  type: 'tool_call'
  name: string
  status: string
  result?: unknown
}

export interface ProgressSummary {
  edits: number
  inspections: number
  validations: number
  processes: number
  previews: number
  total: number
}

const EDIT_TOOLS = new Set(['file.write_text', 'file.patch'])
const INSPECT_TOOLS = new Set(['file.read_text', 'file.list_dir', 'file.stat', 'project.map', 'project.detect', 'search.ripgrep'])
const VALIDATION_TOOLS = new Set(['project.validate'])
const PROCESS_TOOLS = new Set(['shell.run_command', 'process.start', 'process.wait'])
const PREVIEW_TOOLS = new Set(['devserver.start', 'preview.console', 'preview.screenshot'])

export function isIgnoredToolResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as Record<string, unknown>).ignored === true)
}

export function progressSummary(parts: ProgressToolPart[]): ProgressSummary {
  const summary: ProgressSummary = {
    edits: 0,
    inspections: 0,
    validations: 0,
    processes: 0,
    previews: 0,
    total: 0,
  }

  for (const part of parts) {
    if (part.type !== 'tool_call' || part.status !== 'ok' || isIgnoredToolResult(part.result)) continue
    if (EDIT_TOOLS.has(part.name)) summary.edits += 1
    else if (INSPECT_TOOLS.has(part.name)) summary.inspections += 1
    else if (VALIDATION_TOOLS.has(part.name)) summary.validations += 1
    else if (PROCESS_TOOLS.has(part.name)) summary.processes += 1
    else if (PREVIEW_TOOLS.has(part.name)) summary.previews += 1
  }

  summary.total = summary.edits + summary.inspections + summary.validations + summary.processes + summary.previews
  return summary
}

export function successfulWriteProgress(parts: ProgressToolPart[]): number {
  return progressSummary(parts).edits
}

export function madeStepProgress(parts: ProgressToolPart[]): boolean {
  return progressSummary(parts).total > 0
}

export function shouldContinueAfterToolLimitForRole(parts: ProgressToolPart[], role?: AgentStepRole): boolean {
  const summary = progressSummary(parts)
  if (summary.total === 0) return false
  if (!role) return true

  switch (role) {
    case 'inspect':
      return summary.inspections > 0
    case 'feature':
    case 'repair':
      return summary.edits > 0 || summary.processes > 0
    case 'scaffold':
    case 'install':
      return summary.edits > 0 || summary.inspections > 0 || summary.processes > 0
    case 'validate':
      return summary.validations > 0 || summary.processes > 0
    case 'preview':
    case 'console':
    case 'screenshot':
      return summary.previews > 0 || summary.inspections > 0
    case 'final_report':
      return false
    default:
      return summary.total > 0
  }
}
