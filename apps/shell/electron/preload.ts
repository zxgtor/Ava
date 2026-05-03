import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

/**
 * `window.ava` — renderer-facing API surface.
 *
 *   ava.paths.*        (user-data path)
 *   ava.settings.*     (P1 — load/save)
 *   ava.conversations.*(P1 — load/save)
 *   ava.llm.*          (P1 — streaming chat via main)
 *   ava.mcp.*          (P2)
 *   ava.plugins.*      (P3)
 *   ava.commands.*     (P5)
 */

// ── Type mirror (kept minimal — renderer has its own types.ts) ──────
interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  taskId?: string
  toolCallId?: string
}

interface ModelProvider {
  id: string
  name: string
  type: 'local' | 'cloud' | 'aggregator'
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: string[]
  defaultModel: string
  reasoningMode?: 'auto' | 'off' | 'on'
}

interface LlmAttempt {
  providerId: string
  providerName: string
  model: string
  ok: boolean
  status?: number
  error?: string
}

type AssistantRunPhase =
  | 'connecting'
  | 'waiting_first_token'
  | 'generating'
  | 'tool_running'
  | 'fallback'
  | 'completed'
  | 'error'
  | 'aborted'

interface StreamChatArgs {
  streamId: string
  messages: LlmMessage[]
  providers: ModelProvider[]
  activeTaskId?: string
  activeFolderPath?: string
  activeCommandInvocation?: ToolAuditCommandInvocation
  temperature?: number
  toolFormatMap?: Record<string, 'openai' | 'hermes' | 'none'>
  pluginStates?: Record<string, PluginState>
}

interface StreamChatOk {
  ok: true
  result: {
    fullContent: string
    parts: Array<
      | { type: 'text'; text: string }
      | {
          type: 'tool_call'
          taskId?: string
          id: string
          name: string
          args: Record<string, unknown>
          status: 'pending' | 'running' | 'ok' | 'error' | 'aborted'
          result?: unknown
          error?: string
          startedAt?: number
          endedAt?: number
        }
    >
    provider: ModelProvider
    model: string
    attempts: LlmAttempt[]
    fallbackUsed: boolean
    toolCallsIssued: number
    loopRounds: number
    detectedToolFormat: 'openai' | 'hermes' | 'none'
    stopReason?: 'output_limit' | 'tool_loop_limit' | 'server_disconnected' | 'raw_command_no_tool'
  }
}

interface StreamChatErr {
  ok: false
  error: string
}

type StreamChatReply = StreamChatOk | StreamChatErr

interface ChunkPayload {
  streamId: string
  text: string
}

interface AttemptPayload {
  streamId: string
  attempts: LlmAttempt[]
}

interface StatusPayload {
  streamId: string
  taskId?: string
  phase: AssistantRunPhase
  providerId?: string
  providerName?: string
  model?: string
}

interface PartPayload {
  streamId: string
  taskId?: string
  partIndex: number
  part: StreamChatOk['result']['parts'][number]
}

interface PartUpdatePayload {
  streamId: string
  taskId?: string
  partIndex: number
  partId?: string
  patch: Record<string, unknown>
}

interface McpToolDescriptor {
  rawName: string
  name: string
  description?: string
  inputSchema?: unknown
}

interface McpServerRuntime {
  id: string
  name: string
  enabled: boolean
  allowedDirs?: string[]
  builtin?: boolean
  pluginId?: string
  status: 'stopped' | 'starting' | 'running' | 'error'
  pid?: number
  tools?: McpToolDescriptor[]
  lastError?: string
  startedAt?: number
}

interface PluginState {
  enabled: boolean
}

interface DiscoveredPlugin {
  id: string
  rootPath: string
  manifest?: {
    name: string
    version: string
    description?: string
  }
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

interface PluginSourceInfo {
  kind: 'bundled' | 'local' | 'git' | 'zip' | 'unknown'
  uri?: string
  installedAt?: number
  updateable: boolean
}

interface PluginMcpServerView {
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

interface PluginCapabilityView {
  name: string
  sourcePath: string
  status: 'loaded' | 'missing' | 'invalid'
  error?: string
}

interface PluginCommand {
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

interface PluginCommandArgument {
  name: string
  description?: string
  required: boolean
  defaultValue?: string
}

interface ToolAuditCommandInvocation {
  pluginId: string
  pluginName: string
  commandName: string
  sourcePath: string
  arguments: Record<string, string>
}

interface ToolAuditEntry {
  id: string
  createdAt: number
  streamId: string
  taskId?: string
  providerId: string
  providerName: string
  model: string
  toolCallId: string
  toolName: string
  serverId?: string
  rawToolName?: string
  pluginId?: string
  commandInvocation?: ToolAuditCommandInvocation
  args: Record<string, unknown>
  status: 'ok' | 'error' | 'aborted'
  durationMs: number
  isToolError?: boolean
  error?: string
  resultPreview?: string
}

// ── Event subscriptions (cleanup-aware) ─────────────────────────────
function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const ava = {
  ping: (): Promise<string> => ipcRenderer.invoke('ava:ping'),

  app: {
    version: (): Promise<string> => ipcRenderer.invoke('ava:app:version'),
    checkUpdates: (): Promise<{ ok: true; result: any } | { ok: false; error: string }> =>
      ipcRenderer.invoke('ava:app:checkUpdates'),
    installUpdate: (): Promise<void> => ipcRenderer.invoke('ava:app:installUpdate'),
    onUpdateAvailable: (handler: (info: any) => void) => on('ava:app:updateAvailable', handler),
    onUpdateNotAvailable: (handler: (info: any) => void) => on('ava:app:updateNotAvailable', handler),
    onUpdateProgress: (handler: (progress: any) => void) => on('ava:app:updateProgress', handler),
    onUpdateDownloaded: (handler: (info: any) => void) => on('ava:app:updateDownloaded', handler),
    onUpdateError: (handler: (err: string) => void) => on('ava:app:updateError', handler),
  },

  paths: {
    userData: (): Promise<string> => ipcRenderer.invoke('ava:paths:userData'),
  },

  settings: {
    load: (): Promise<unknown> => ipcRenderer.invoke('ava:settings:load'),
    save: (data: unknown): Promise<boolean> => ipcRenderer.invoke('ava:settings:save', data),
  },

  conversations: {
    load: (): Promise<unknown> => ipcRenderer.invoke('ava:conversations:load'),
    save: (data: unknown): Promise<boolean> => ipcRenderer.invoke('ava:conversations:save', data),
  },

  llm: {
    stream: (args: StreamChatArgs): Promise<StreamChatReply> =>
      ipcRenderer.invoke('ava:llm:stream', args),
    abort: (streamId: string): Promise<boolean> =>
      ipcRenderer.invoke('ava:llm:abort', streamId),
    probe: (args: { baseUrl: string; apiKey: string; providerId?: string }): Promise<
      { ok: true; models: string[] } | { ok: false; error: string }
    > => ipcRenderer.invoke('ava:llm:probe', args),
    onChunk: (handler: (payload: ChunkPayload) => void) => on<ChunkPayload>('ava:llm:chunk', handler),
    onReasoningChunk: (handler: (payload: ChunkPayload) => void) => on<ChunkPayload>('ava:llm:reasoning-chunk', handler),
    onAttempt: (handler: (payload: AttemptPayload) => void) => on<AttemptPayload>('ava:llm:attempt', handler),
    onStatus: (handler: (payload: StatusPayload) => void) => on<StatusPayload>('ava:llm:status', handler),
    onPart: (handler: (payload: PartPayload) => void) => on<PartPayload>('ava:llm:part', handler),
    onPartUpdate: (handler: (payload: PartUpdatePayload) => void) => on<PartUpdatePayload>('ava:llm:partUpdate', handler),
  },

  mcp: {
    listServers: (): Promise<McpServerRuntime[]> => ipcRenderer.invoke('ava:mcp:listServers'),
    restart: (serverId: string): Promise<boolean> => ipcRenderer.invoke('ava:mcp:restart', serverId),
    onStatus: (handler: (payload: McpServerRuntime) => void) => on<McpServerRuntime>('ava:mcp:status', handler),
  },

  toolAudit: {
    list: (limit?: number): Promise<ToolAuditEntry[]> =>
      ipcRenderer.invoke('ava:toolAudit:list', limit),
    clear: (): Promise<boolean> =>
      ipcRenderer.invoke('ava:toolAudit:clear'),
  },

  plugins: {
    list: (states: Record<string, PluginState>): Promise<DiscoveredPlugin[]> =>
      ipcRenderer.invoke('ava:plugins:list', states),
    listCommands: (states: Record<string, PluginState>): Promise<PluginCommand[]> =>
      ipcRenderer.invoke('ava:plugins:listCommands', states),
    installFolder: (): Promise<DiscoveredPlugin | null> =>
      ipcRenderer.invoke('ava:plugins:installFolder'),
    installZip: (): Promise<DiscoveredPlugin | null> =>
      ipcRenderer.invoke('ava:plugins:installZip'),
    installGit: (url: string): Promise<DiscoveredPlugin> =>
      ipcRenderer.invoke('ava:plugins:installGit', url),
    uninstall: (pluginId: string): Promise<boolean> =>
      ipcRenderer.invoke('ava:plugins:uninstall', pluginId),
    update: (pluginId: string): Promise<DiscoveredPlugin> =>
      ipcRenderer.invoke('ava:plugins:update', pluginId),
    getMarketplaceCatalog: (): Promise<any[]> =>
      ipcRenderer.invoke('ava:plugins:getMarketplaceCatalog'),
  },

  dialog: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('ava:dialog:pickDirectory'),
  },
  shell: {
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('ava:shell:openPath', path),
    openInTerminal: (path: string): Promise<void> => ipcRenderer.invoke('ava:shell:openInTerminal', path),
    openInVSCode: (path: string): Promise<void> => ipcRenderer.invoke('ava:shell:openInVSCode', path),
  },
  fs: {
    writeFile: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('ava:fs:writeFile', path, content),
    readFile: (path: string): Promise<string> => ipcRenderer.invoke('ava:fs:readFile', path),
    listDir: (path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>> => 
      ipcRenderer.invoke('ava:fs:listDir', path),
  },
  window: {
    openPreview: (theme?: string): Promise<void> => ipcRenderer.invoke('ava:window:openPreview', theme),
    updatePreview: (content: string): Promise<void> => ipcRenderer.invoke('ava:window:updatePreview', content),
    updateTheme: (theme: string): Promise<void> => ipcRenderer.invoke('ava:window:updateTheme', theme),
    onUpdate: (callback: (content: string) => void) => {
      const listener = (_e: any, content: string) => callback(content)
      ipcRenderer.on('ava:preview:update', listener)
      return () => ipcRenderer.removeListener('ava:preview:update', listener)
    },
    onThemeUpdate: (callback: (theme: string) => void) => {
      const listener = (_e: any, theme: string) => callback(theme)
      ipcRenderer.on('ava:theme:update', listener)
      return () => ipcRenderer.removeListener('ava:theme:update', listener)
    },
  },
}

contextBridge.exposeInMainWorld('ava', ava)

export type AvaApi = typeof ava
