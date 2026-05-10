import type { TaskExecutionPlan, TaskExecutionStep, Message, ModelProvider, Settings } from '../../../types'
import { EXECUTOR_SCAFFOLD, EXECUTOR_FEATURE, EXECUTOR_DEBUG, EXECUTOR_REFACTOR, EXECUTOR_VALIDATE } from '../prompts/templates'

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
  // Role takes precedence over workflowType. A "validate" step is functionally
  // a verify-only loop and needs a strict prompt that forbids scaffold/init
  // commands — without this, models often re-run `npm create vite` because
  // the planner labeled the step workflowType="feature" but role="validate".
  const isValidate = input.step.role === 'validate'
  const template = isValidate ? EXECUTOR_VALIDATE : getExecutorTemplate(input.step.workflowType)
  const sections = [
    template,
    `Goal for this step: ${input.step.title}`,
    `Working Directory: ${input.plan.workingDirectory}`,
    `Memory State (Completed Tasks context):\n${input.memoryState || 'None'}`,
    `Allowed Tools: ${input.step.requiredTools.join(', ') || 'All tools allowed'}`,
  ]

  // Architectural constraints captured by the analyze phase. These are the
  // user-confirmed visual style / framework / persistence decisions — feature
  // steps MUST honor them or the result drifts back into a generic template.
  if (input.plan.architectureConstraints && input.plan.architectureConstraints.trim()) {
    sections.push([
      'Constraints (from confirmed analysis — DO NOT DEVIATE):',
      input.plan.architectureConstraints.trim(),
      '',
      'When the constraints contain a `visualStyle` JSON block, use those exact hex values, typography, spacing rhythm, radius/shadow, motion intensity, and grid layout. Do not invent your own palette or font choices.',
    ].join('\n'))
  }

  if (requiresWrite(input.step)) {
    sections.push([
      'This step expects a write/create tool call to make progress.',
      'Do not call file.read_text or file.list_dir more than once before writing.',
      'Do not output a textual plan; call the write tool now.',
    ].join('\n'))
  }

  // File-write discipline — prevents the model from re-writing the same file
  // every round. file.write_text overwrites blindly and gives no signal that
  // the file already exists; file.patch is targeted and self-limiting (the
  // second patch with the same oldText fails because oldText is gone).
  sections.push([
    'File-write rules:',
    '- file.write_text: ONLY for creating a brand-new file that does not exist yet.',
    '- file.patch: REQUIRED for any modification to an already-written or pre-existing file.',
    '- Before writing again to a path you already wrote in this conversation, switch to file.patch (or stop if the previous write fully covered your intent).',
    '- Never call file.write_text twice on the same path in one step — that is a loop, not progress.',
  ].join('\n'))

  // Stop discipline — local agent models tend to keep emitting tool_calls
  // forever. Make "stop and summarize" the explicit success path so the
  // tool loop exits naturally instead of hitting the round-budget limit.
  sections.push([
    'Stop conditions — you MUST stop calling tools and return a final assistant message (no tool_call) when ANY of these are true:',
    '- All required tools for this step have produced a successful result.',
    '- The intended files have been created/modified successfully and verified by their tool results.',
    '- You catch yourself about to repeat a tool call you already made successfully — stop instead.',
    '',
    'When stopping, reply with one short sentence summarizing what you did. Do not output more code in the chat — the files are already on disk.',
  ].join('\n'))

  sections.push('Self-Correction: If a tool fails, read the error message, adjust, and retry. Maximum retries: 2.')
  return sections.join('\n\n')
}
