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
  /** Namespaced tool name, e.g. `filesystem.read_file` */
  name: string
  args: Record<string, unknown>
  status: ToolCallStatus
  /** Result payload (arbitrary JSON) once the tool call completes. */
  result?: unknown
  /** Error message when status = 'error'. */
  error?: string
  startedAt?: number
  endedAt?: number
}

export type ContentPart = TextPart | ToolCallPart

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
  error?: string
  aborted?: boolean
  commandInvocation?: CommandInvocation
}

export interface CommandInvocation {
  pluginId: string
  pluginName: string
  commandName: string
  sourcePath: string
  arguments: Record<string, string>
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
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
}

/** Per-model detected tool-call format, cached so we do not re-probe every request. */
export type ToolCallFormat = 'openai' | 'hermes' | 'none'

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

export interface PluginCommand {
  pluginId: string
  pluginName: string
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
  voice: VoiceConfig
}

// ── View mode ───────────────────────────────────────────────────────

export type ViewMode = 'chat' | 'settings'
