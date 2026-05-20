// ── Message content parts ───────────────────────────────────────────

export interface TextPart {
  type: 'text'
  text: string
}

export type ToolCallStatus = 'pending' | 'running' | 'ok' | 'error' | 'aborted'

export interface ToolCallPart {
  type: 'tool_call'
  /** Current user-task id; prevents stale tool events from attaching to a newer response. */
  taskId?: string
  /** Stable tool-call id (matches the OpenAI `tool_call_id` / Hermes id) */
  id: string
  /** Namespaced tool name, e.g. `filesystem.read_text_file` */
  name: string
  args: Record<string, unknown>
  status: ToolCallStatus
  /** Result payload (arbitrary JSON) once the tool call completes. */
  result?: unknown
  /** Full result location when large tool output was compacted for context safety. */
  persistedOutput?: PersistedToolResultRef
  /** Error message when status = 'error'. */
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface PersistedToolResultRef {
  path: string
  preview: string
  originalBytes: number
  truncated: true
  mime: 'application/json' | 'text/plain'
  createdAt: number
}

export interface ImagePart {
  type: 'image_url'
  image_url: {
    url: string
  }
}

export interface ProjectAnalysisPart {
  type: 'project_analysis'
  analysis: ProjectAnalysis
}

export type ContentPart = TextPart | ToolCallPart | ImagePart | ProjectAnalysisPart

export type TaskExecutionStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type TaskExecutionPlanStatus = 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'aborted'

export interface TaskExecutionStep {
  id: string
  title: string
  status: TaskExecutionStepStatus
  requiredTools: string[]
  completionSignals: string[]
  attempts: number
  lastError?: string
  lastToolSummary?: string
  lastProcessId?: string
  lastCommand?: string
  lastExitCode?: number | null
  lastRecoveredAt?: number
  /** Runtime proof collected from tool calls; used to prevent steps advancing on text-only promises. */
  evidence?: TaskExecutionEvidence[]
  /** DAG dependency graph: list of step IDs that must be 'done' before this step can start. */
  dependsOn?: string[]
  /** Dynamic decomposition: if a task is too large, it can be broken down into subtasks. */
  subtasks?: TaskExecutionStep[]
  /** Specific template workflow type for this step (e.g. 'scaffold', 'debug'). Defaults to 'feature' if omitted. */
  workflowType?: 'scaffold' | 'feature' | 'debug' | 'refactor' | 'research'
  /**
   * Engine behavior tag. Drives completion gates, repair routing, and final-report gating.
   * Independent of `workflowType` (which only selects an executor prompt template).
   * Steps with no `role` use the generic completion gate (any required tool succeeds).
   */
  role?:
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
}

export interface TaskExecutionEvidence {
  toolName: string
  toolCallId: string
  status: ToolCallStatus
  timestamp: number
  summary?: string
  processId?: string
  command?: string
  exitCode?: number | null
  persistedOutputPath?: string
}

export type AgentRole = 'planner' | 'executor' | 'critic' | 'orchestrator'

export interface ProjectUnknown {
  question: string
  options: string[]
  importance: 'high' | 'low'
}

export interface ProjectRisk {
  risk: string
  mitigation: string
  impact: 'high' | 'medium' | 'low'
}

export interface ProjectAnalysis {
  projectSummary: string
  architecture: string
  unknowns: ProjectUnknown[]
  risks: ProjectRisk[]
}

export interface TaskExecutionValidation {
  devServerChecked: boolean
  consoleChecked: boolean
  screenshotChecked: boolean
  buildChecked: boolean
}

export interface TaskExecutionPlan {
  taskId: string
  status: TaskExecutionPlanStatus
  goal: string
  workingDirectory: string
  kind: 'coding-design'
  currentStepId?: string
  steps: TaskExecutionStep[]
  validation: TaskExecutionValidation
  /** Architectural constraints captured by the analyze phase (framework,
   *  visualStyle JSON, layout, persistence, etc). Injected into the executor
   *  system prompt as Constraints so feature steps don't drift from the
   *  user's confirmed design. */
  architectureConstraints?: string
  createdAt: number
  updatedAt: number
}

export type AssistantRunPhase =
  | 'connecting'
  | 'waiting_first_token'
  | 'generating'
  | 'tool_running'
  | 'fallback'
  | 'completed'
  | 'error'
  | 'aborted'

// ── Message / Conversation ──────────────────────────────────────────

export interface Message {
  id: string
  /** Groups a user message, its assistant response, and tool calls into one task. */
  taskId?: string
  /** 'tool' role carries a tool execution result that is fed back to the LLM. */
  role: 'user' | 'assistant' | 'system' | 'tool'
  /**
   * Breaking change in schema v2: was `string`, now an array of parts.
   * `role: 'tool'` messages carry exactly one text part (the stringified result).
  */
  content: ContentPart[]
  /** Only set when role === 'tool'; ties the result back to the matching tool_call part. */
  toolCallId?: string
  createdAt: number
  streaming?: boolean
  runPhase?: AssistantRunPhase
  taskStepTitle?: string
  error?: string
  aborted?: boolean
  /** Accumulated reasoning/thinking content from the model (hidden by default, shown in collapsible block). */
  reasoningContent?: string
  commandInvocation?: CommandInvocation
}

export interface CommandInvocation {
  pluginId: string
  pluginName: string
  commandName: string
  sourcePath: string
  arguments: Record<string, string>
}

export type InitiativeTrait = 
  | 'chat' 
  | 'video' 
  | 'code' 
  | 'business' 
  | 'mastery' 
  | 'intelligence' 
  | 'profile' 
  | 'laboratory' 
  | 'forge' 
  | 'idea'
  | (string & {}) // 允许任意字符串扩展，同时保持 IDE 的补全提示

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  traits?: InitiativeTrait[]
  pinned?: boolean
  archived?: boolean
  folderPath?: string
  activeTaskPlan?: TaskExecutionPlan
  createdAt: number
  updatedAt: number
}

// ── LLM providers ───────────────────────────────────────────────────

export type ProviderKind = 'local' | 'cloud' | 'aggregator'

export interface ModelProvider {
  id: string
  name: string
  type: ProviderKind
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: string[]
  defaultModel: string
  reasoningMode?: 'auto' | 'off' | 'on'
}

// ── MCP servers ─────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Stable id. `filesystem` is the only built-in in P2. */
  id: string
  name: string
  command: string
  /** Base args; the supervisor may append extra args (e.g. allowedDirs) at spawn time. */
  args: string[]
  env?: Record<string, string>
  cwd?: string
  enabled: boolean
  /** Filesystem-only: directories the server is allowed to read/write. Appended to args on spawn. */
  allowedDirs?: string[]
  /** Built-in servers cannot be removed from the list, only toggled/configured. */
  builtin?: boolean
  pluginId?: string
  transport?: 'stdio' | 'sse'
  url?: string
}

/** Per-model detected tool-call format, cached so we do not re-probe every request. */
export type ToolCallFormat = 'openai' | 'hermes' | 'none'

export interface ModelCapabilityProfile {
  model: string
  providerId: string
  vision: 'yes' | 'no' | 'unknown'
  tools: 'yes' | 'no' | 'unknown'
  thinking: 'yes' | 'no' | 'unknown'
  toolFormat: ToolCallFormat | 'json' | 'unknown'
  source: 'probe' | 'heuristic'
  checkedAt: number
  error?: string
}

export interface PluginState {
  enabled: boolean
}

export interface PluginManifestView {
  name: string
  version: string
  description?: string
}

export interface DiscoveredPlugin {
  id: string
  rootPath: string
  manifest?: PluginManifestView
  enabled: boolean
  valid: boolean
  bundled: boolean
  source: PluginSourceInfo
  mcpServerCount: number
  skillCount: number
  commandCount: number
  mcpServers: PluginMcpServerView[]
  skills: PluginCapabilityView[]
  commands: PluginCapabilityView[]
  permissions: string[]
  errors: string[]
  warnings: string[]
}

export interface PluginSourceInfo {
  kind: 'bundled' | 'local' | 'git' | 'zip' | 'unknown'
  uri?: string
  installedAt?: number
  updateable: boolean
}

export interface PluginMcpServerView {
  id?: string
  name: string
  type: 'stdio' | 'http' | 'sse' | 'unknown'
  status: 'loaded' | 'unsupported' | 'invalid'
  command?: string
  args?: string[]
  envKeys?: string[]
  cwd?: string
  cwdInsidePlugin?: boolean
  error?: string
}

export interface PluginCapabilityView {
  name: string
  sourcePath: string
  status: 'loaded' | 'missing' | 'invalid'
  error?: string
}

export type MarketplaceItemType = 'plugin' | 'skill'
export type MarketplaceItemSource = 'claude' | 'codex' | 'ava'

export interface MarketplaceItem {
  id: string
  type: MarketplaceItemType
  name: string
  description: string
  author: string
  category: string
  source: MarketplaceItemSource
  sourceLabel: string
  sourceUrl?: string
  repoUrl?: string
  installUrl?: string
  installKind: 'git' | 'parent-plugin' | 'unavailable'
  installNote?: string
  parentPluginName?: string
  thumbnailUrl?: string
  installedPluginId?: string
  sourceBadges: string[]
}

export interface MarketplaceCatalog {
  updatedAt: number
  items: MarketplaceItem[]
  warnings: string[]
}

export interface MarketplaceCatalogOptions {
  sources?: MarketplaceItemSource[]
}

export interface PluginCommand {
  pluginId: string
  pluginName: string
  bundled: boolean
  sourceKind: PluginSourceInfo['kind']
  name: string
  description?: string
  arguments: PluginCommandArgument[]
  sourcePath: string
  content: string
  truncated: boolean
}

export interface PluginCommandArgument {
  name: string
  description?: string
  required: boolean
  defaultValue?: string
}

export interface VoiceConfig {
  enabled: boolean
  sttServerUrl: string
  ttsServerUrl: string
  voiceId: string
  autoRead: boolean
}

export interface ProjectBrief {
  tasksDone: number
  tasksTotal: number
  files: string[]
}

// ── Settings ────────────────────────────────────────────────────────

/**
 * Schema v2 — breaking change from v1:
 *   - Message.content: string → ContentPart[]
 *   - Settings.mcpServers / modelToolFormatMap added
 * Loader resets settings + conversations when version !== 2.
 */
export interface Settings {
  version: 2
  modelProviders: ModelProvider[]
  primaryModelChain: string[]
  persona: {
    userName: string
    assistantName: string
  }
  mcpServers: McpServerConfig[]
  pluginStates: Record<string, PluginState>
  /** Key = `${providerId}:${modelId}` → detected format. */
  modelToolFormatMap: Record<string, ToolCallFormat>
  /** Key = `${providerId}:${modelId}` → detected or inferred model capabilities. */
  modelCapabilityMap: Record<string, ModelCapabilityProfile>
  voice: VoiceConfig
  theme: 'aura-glass' | 'cyber-zen' | 'nebula-clear'
  language: 'auto' | 'en-US' | 'zh-CN'
}

// ── View mode ───────────────────────────────────────────────────────

export type ViewMode = 'chat' | 'settings' | 'unit-test'
export type UnitTestSection = 'built-in' | 'mcp' | 'skill'
