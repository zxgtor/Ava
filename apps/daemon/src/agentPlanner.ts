import type {
  AvaChatMessage,
  AvaTaskAnalyzeRequest,
  AvaTaskAnalyzeResult,
  AvaTaskPlanRequest,
  AvaTaskPlanResult,
  ProjectAnalysis,
  TaskExecutionPlan,
  TaskExecutionStep,
} from '@ava/contracts'
import { streamChat, type LlmMessage, type ModelProvider } from './llm'
import { loadSettings } from './storage'
import { resolveStreamChatArgsFromDaemonConfig } from './services/modelRouter'

const ANALYZE_TEMPLATE = `You are a Principal Engineer and Product Designer doing requirements discovery BEFORE any code or plan is written.

Output ONLY JSON with this shape:
{
  "projectSummary": "Brief summary of what the user wants",
  "architecture": "Key architectural constraints if explicitly stated, else 'TBD pending answers'",
  "unknowns": [
    { "question": "One specific decision", "options": ["A", "B", "C"], "importance": "high" | "medium" | "low" }
  ],
  "risks": [
    { "risk": "Description", "mitigation": "How to handle", "impact": "high" | "medium" | "low" }
  ]
}

Rules:
1. For create/build/design app/site/dashboard/3D tasks, ask at least 5 high-importance questions unless the user already answered them.
2. Cover framework/build tool, styling/theme, visual direction, layout/UX, domain-specific features, state/persistence, performance target, accessibility/i18n, deployment/deliverables when applicable.
3. Every question must include 2-4 concrete option strings.
4. Never ask a question already answered by the prompt.
5. Output JSON only.`

const PLANNER_TEMPLATE = `You are an Orchestrator and Planner Agent. Break the confirmed goal into a Directed Acyclic Graph of small executable steps.

Rules:
1. Do not write implementation code.
2. Define dependencies using dependsOn.
3. Assign workflowType: scaffold, feature, debug, refactor, or research.
4. Assign role: inspect, scaffold, install, feature, preview, console, screenshot, repair, validate, final_report.
5. Include preview/console/screenshot only for runnable frontends.
6. Include exactly one validate step before final_report when code is written.
7. User clarification is complete. Do not ask more questions.
8. Use only these tools: shell.run_command, file.read_text, file.write_text, file.list_dir, file.create_dir, file.stat, file.patch, project.detect, project.map, project.validate, search.ripgrep, devserver.start, devserver.stop, devserver.status, process.start, process.status, process.logs, process.wait, process.kill, preview.open, preview.console, preview.screenshot.
9. Never use aliases like fs.mkdir, shell.exec, bash, terminal, npm.

Output ONLY:
{ "steps": [ { "id": "...", "title": "...", "role": "...", "workflowType": "...", "dependsOn": [], "requiredTools": [] } ] }`

const KNOWN_TASK_TOOLS = new Set([
  'shell.run_command',
  'file.read_text',
  'file.write_text',
  'file.list_dir',
  'file.create_dir',
  'file.stat',
  'file.patch',
  'project.detect',
  'project.map',
  'project.validate',
  'search.ripgrep',
  'devserver.start',
  'devserver.stop',
  'devserver.status',
  'process.start',
  'process.status',
  'process.logs',
  'process.wait',
  'process.kill',
  'preview.open',
  'preview.console',
  'preview.screenshot',
])

const TOOL_ALIASES: Record<string, string> = {
  'fs.mkdir': 'file.create_dir',
  'filesystem.mkdir': 'file.create_dir',
  'filesystem.read_file': 'file.read_text',
  'filesystem.read_text_file': 'file.read_text',
  'filesystem.write_file': 'file.write_text',
  'filesystem.write_text_file': 'file.write_text',
  'shell.exec': 'shell.run_command',
  bash: 'shell.run_command',
  terminal: 'shell.run_command',
  npm: 'shell.run_command',
  npx: 'shell.run_command',
}

const VALID_ROLES = new Set<NonNullable<TaskExecutionStep['role']>>([
  'inspect', 'scaffold', 'install', 'feature', 'preview', 'console', 'screenshot', 'repair', 'validate', 'final_report',
])
const VALID_WORKFLOW_TYPES = new Set<NonNullable<TaskExecutionStep['workflowType']>>([
  'scaffold', 'feature', 'debug', 'refactor', 'research',
])

export async function analyzeTask(request: AvaTaskAnalyzeRequest): Promise<AvaTaskAnalyzeResult> {
  const contextBudget = await planningContextBudget(request.traits)
  const historyText = (request.messages ?? []).slice(-10).map(message => `${message.role.toUpperCase()}: ${messageToText(message)}`).join('\n\n')
  const systemPrompt = [
    ANALYZE_TEMPLATE,
    `Conversation History:\n${historyText}`,
    `Context Budget: ${contextBudget} tokens. Ask only questions required to make a safe executable plan for this budget.`,
    `Goal: ${request.goal}`,
    `Working directory: ${request.workingDirectory || '(none)'}`,
  ].join('\n\n')

  const result = await runPlannerLlm({
    streamId: `analyze_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: request.taskId,
    workingDirectory: request.workingDirectory,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Please begin the project analysis.' },
    ],
  })
  const parsed = extractJsonObject(result.fullContent)
  return { analysis: parsed ? normalizeProjectAnalysis(parsed) : null }
}

export async function planTask(request: AvaTaskPlanRequest): Promise<AvaTaskPlanResult> {
  const contextBudget = await planningContextBudget(request.traits)
  const systemPrompt = [
    PLANNER_TEMPLATE,
    `Context Budget: ${contextBudget} tokens. Adjust task granularity accordingly.`,
    `Goal: ${request.goal}`,
    `Working directory: ${request.workingDirectory || '(none)'}`,
    `Analysis: ${request.analysis ? JSON.stringify(request.analysis, null, 2) : 'None provided'}`,
  ].join('\n\n')

  const result = await runPlannerLlm({
    streamId: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: request.taskId,
    workingDirectory: request.workingDirectory,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Please generate the execution plan DAG.' },
    ],
  })

  const parsed = extractJsonObject(result.fullContent)
  const plan = parsed ? planFromParsed(request, parsed) : null
  if (plan) return { plan: normalizeTaskExecutionPlan(plan), fallbackUsed: false }
  return {
    plan: normalizeTaskExecutionPlan(createFallbackPlan({
      taskId: request.taskId,
      goal: request.goal,
      workingDirectory: request.workingDirectory,
      architectureConstraints: request.analysis?.architecture,
    })),
    fallbackUsed: true,
  }
}

async function runPlannerLlm(input: {
  streamId: string
  taskId: string
  workingDirectory?: string
  temperature: number
  messages: LlmMessage[]
}) {
  const args = await resolveStreamChatArgsFromDaemonConfig(input.messages, {
    streamId: input.streamId,
    activeTaskId: input.taskId,
    activeFolderPath: input.workingDirectory,
    temperature: input.temperature,
  })
  return streamChat({
    isDestroyed: () => false,
    send: () => undefined,
  } as never, {
    ...args,
    activeStepRole: 'final_report',
    activeStepRequiredTools: [],
    activeStepToolLoopBudget: 1,
  })
}

async function planningContextBudget(traits?: string[]): Promise<number> {
  const settings = (await loadSettings() ?? {}) as { modelProviders?: unknown }
  const providers = Array.isArray(settings.modelProviders)
    ? settings.modelProviders.filter(isProvider)
    : []
  const provider = providers.find(item => item.enabled) ?? providers[0]
  return Math.max(contextBudgetForTraits(traits), contextBudgetForModel(provider))
}

function isProvider(raw: unknown): raw is ModelProvider {
  return Boolean(raw && typeof raw === 'object' && typeof (raw as ModelProvider).defaultModel === 'string')
}

function contextBudgetForTraits(traits?: string[]): number {
  if (traits?.includes('research') || traits?.includes('code')) return 24000
  if (traits?.includes('writing')) return 16000
  return 8000
}

function contextBudgetForModel(provider?: Pick<ModelProvider, 'defaultModel' | 'models'>): number {
  const text = `${provider?.defaultModel ?? ''} ${(provider?.models ?? []).join(' ')}`.toLowerCase()
  if (/\b(1m|1000k|512k|256k|200k|128k)\b|claude|gemini|gpt-5|gpt-4\.1/.test(text)) return 32000
  if (/\b(64k|32k)\b|gpt-4o|o3|o4|deepseek|qwen3|qwen2\.5|kimi/.test(text)) return 24000
  if (/\b(16k|14b|32b|70b)\b|llama|mistral|mixtral|phi/.test(text)) return 16000
  return 8000
}

function planFromParsed(request: AvaTaskPlanRequest, parsed: Record<string, unknown>): TaskExecutionPlan | null {
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : []
  if (rawSteps.length === 0) return null
  const now = Date.now()
  return {
    taskId: request.taskId,
    status: 'running',
    goal: request.goal,
    workingDirectory: request.workingDirectory || '(no active folder)',
    kind: 'coding-design',
    currentStepId: String((rawSteps[0] as Record<string, unknown>)?.id ?? 'step_1'),
    steps: rawSteps.map((raw, index) => normalizeStep(raw, index)),
    validation: { devServerChecked: false, consoleChecked: false, screenshotChecked: false, buildChecked: false },
    architectureConstraints: request.analysis?.architecture,
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeStep(raw: unknown, index: number): TaskExecutionStep {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    id: typeof src.id === 'string' && src.id.trim() ? src.id.trim() : `step_${index + 1}`,
    title: typeof src.title === 'string' && src.title.trim() ? src.title.trim() : `Step ${index + 1}`,
    status: 'pending',
    requiredTools: normalizeRequiredTools(Array.isArray(src.requiredTools) ? src.requiredTools.map(String) : []),
    completionSignals: Array.isArray(src.completionSignals) ? src.completionSignals.map(String) : ['Done'],
    attempts: 0,
    dependsOn: Array.isArray(src.dependsOn) ? src.dependsOn.map(String) : [],
    workflowType: normalizeWorkflowType(src.workflowType),
    role: normalizeRole(src.role),
  }
}

function createFallbackPlan(input: {
  taskId: string
  goal: string
  workingDirectory?: string
  architectureConstraints?: string
}): TaskExecutionPlan {
  const now = Date.now()
  return {
    taskId: input.taskId,
    status: 'running',
    goal: input.goal,
    workingDirectory: input.workingDirectory || '(no active folder)',
    kind: 'coding-design',
    currentStepId: 'inspect_project',
    architectureConstraints: input.architectureConstraints,
    validation: { devServerChecked: false, consoleChecked: false, screenshotChecked: false, buildChecked: false },
    steps: [
      step('inspect_project', 'Ensure target directory exists and inspect project state', ['file.create_dir', 'project.map', 'project.detect', 'file.list_dir', 'file.read_text'], ['target directory exists', 'project mapped'], 'inspect', 'research'),
      step('setup_project', 'Initialize or complete project structure', ['shell.run_command', 'process.start', 'process.wait', 'file.create_dir', 'file.write_text'], ['project structure ready'], 'scaffold', 'scaffold'),
      step('install_dependencies', 'Install or confirm required dependencies', ['shell.run_command', 'process.start', 'process.wait', 'project.detect'], ['dependencies ready'], 'install', 'scaffold'),
      step('write_core_files', 'Write core app files', ['file.write_text', 'file.patch', 'project.map', 'file.stat', 'file.read_text'], ['core files written'], 'feature', 'feature'),
      step('start_preview', 'Start development server', ['devserver.start'], ['dev server started'], 'preview', 'research'),
      step('check_console', 'Check browser console', ['preview.console', 'devserver.status', 'devserver.start'], ['console checked'], 'console', 'debug'),
      step('check_screenshot', 'Capture preview screenshot', ['preview.screenshot', 'devserver.status', 'devserver.start'], ['screenshot checked'], 'screenshot', 'research'),
      step('repair', 'Repair detected console, build, or visual issues', ['file.patch', 'file.write_text', 'shell.run_command'], ['issues repaired'], 'repair', 'debug'),
      step('validate', 'Validate build or typecheck', ['project.validate', 'shell.run_command', 'process.start', 'process.wait'], ['project validated'], 'validate', 'debug'),
      step('final_report', 'Report changed files, validation result, and remaining risks', [], ['final report written'], 'final_report', 'feature'),
    ],
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeTaskExecutionPlan(plan: TaskExecutionPlan): TaskExecutionPlan {
  const normalizedSteps = ensureFrontendValidationSteps(plan.steps.map(item => ({
    ...item,
    requiredTools: normalizeRequiredTools(item.requiredTools),
  })))
  return {
    ...plan,
    currentStepId: normalizedSteps.find(item => item.status === 'pending')?.id ?? plan.currentStepId,
    steps: normalizedSteps,
  }
}

function ensureFrontendValidationSteps(steps: TaskExecutionStep[]): TaskExecutionStep[] {
  const hasPreview = steps.some(item => item.role === 'preview')
  if (!hasPreview) return steps
  const injected: TaskExecutionStep[] = []
  if (!steps.some(item => item.role === 'console')) {
    injected.push(step('check_console', 'Check browser console', ['preview.console', 'devserver.status', 'devserver.start'], ['console checked'], 'console', 'debug'))
  }
  if (!steps.some(item => item.role === 'screenshot')) {
    injected.push(step('check_screenshot', 'Capture preview screenshot', ['preview.screenshot', 'devserver.status', 'devserver.start'], ['screenshot checked'], 'screenshot', 'research'))
  }
  if (injected.length === 0) return steps
  const previewIndex = steps.findIndex(item => item.role === 'preview')
  const insertAt = previewIndex >= 0 ? previewIndex + 1 : steps.length
  return [...steps.slice(0, insertAt), ...injected, ...steps.slice(insertAt)]
}

function step(
  id: string,
  title: string,
  requiredTools: string[],
  completionSignals: string[],
  role?: TaskExecutionStep['role'],
  workflowType?: TaskExecutionStep['workflowType'],
): TaskExecutionStep {
  return { id, title, status: 'pending', requiredTools, completionSignals, attempts: 0, role, workflowType }
}

function normalizeRequiredTools(requiredTools: string[]): string[] {
  const normalized = requiredTools
    .map(tool => normalizeTaskToolName(tool))
    .filter((tool): tool is string => Boolean(tool))
  return Array.from(new Set(normalized))
}

function normalizeTaskToolName(name: string): string | null {
  const raw = name.trim()
  const lower = raw.toLowerCase().replace(/_\d+$/g, '')
  const mapped = TOOL_ALIASES[lower] ?? lower
  if (KNOWN_TASK_TOOLS.has(mapped)) return mapped
  if (KNOWN_TASK_TOOLS.has(raw)) return raw
  if (/\b(shell|bash|powershell|cmd|terminal|npm|npx|node|git)\b/.test(lower)) return 'shell.run_command'
  return null
}

function normalizeRole(value: unknown): TaskExecutionStep['role'] {
  return typeof value === 'string' && VALID_ROLES.has(value as NonNullable<TaskExecutionStep['role']>)
    ? value as TaskExecutionStep['role']
    : undefined
}

function normalizeWorkflowType(value: unknown): TaskExecutionStep['workflowType'] {
  return typeof value === 'string' && VALID_WORKFLOW_TYPES.has(value as NonNullable<TaskExecutionStep['workflowType']>)
    ? value as TaskExecutionStep['workflowType']
    : 'feature'
}

function normalizeProjectAnalysis(raw: Record<string, unknown>): ProjectAnalysis {
  return {
    projectSummary: typeof raw.projectSummary === 'string' ? raw.projectSummary : '',
    architecture: typeof raw.architecture === 'string' ? raw.architecture : 'TBD pending answers',
    unknowns: Array.isArray(raw.unknowns) ? raw.unknowns.map(normalizeUnknown).filter(Boolean) as ProjectAnalysis['unknowns'] : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map(normalizeRisk).filter(Boolean) as ProjectAnalysis['risks'] : [],
  }
}

function normalizeUnknown(raw: unknown): ProjectAnalysis['unknowns'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  if (typeof src.question !== 'string') return null
  const importance = src.importance === 'medium' || src.importance === 'low' ? src.importance : 'high'
  return {
    question: src.question,
    options: Array.isArray(src.options) ? src.options.map(String).filter(Boolean).slice(0, 4) : [],
    importance,
  }
}

function normalizeRisk(raw: unknown): ProjectAnalysis['risks'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  if (typeof src.risk !== 'string') return null
  const impact = src.impact === 'high' || src.impact === 'low' ? src.impact : 'medium'
  return {
    risk: src.risk,
    mitigation: typeof src.mitigation === 'string' ? src.mitigation : '',
    impact,
  }
}

function messageToText(message: AvaChatMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim()
  if (fenced) {
    const parsed = tryParse(fenced)
    if (parsed) return parsed
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start)
    if (end === -1) return null
    const parsed = tryParse(text.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (escape) { escape = false; continue }
    if (char === '\\' && inString) { escape = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}
