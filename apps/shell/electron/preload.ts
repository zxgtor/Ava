import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { AvaClient } from '@ava/client-sdk'

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

interface ModelCapabilityProfile {
  model: string
  providerId: string
  vision: 'yes' | 'no' | 'unknown'
  tools: 'yes' | 'no' | 'unknown'
  thinking: 'yes' | 'no' | 'unknown'
  toolFormat: 'openai' | 'hermes' | 'json' | 'none' | 'unknown'
  source: 'probe' | 'heuristic'
  checkedAt: number
  error?: string
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
  activeTaskPlan?: unknown
  activeFolderPath?: string
  taskAllowedDirs?: string[]
  activeCommandInvocation?: ToolAuditCommandInvocation
  temperature?: number
  toolFormatMap?: Record<string, 'openai' | 'hermes' | 'none'>
  pluginStates?: Record<string, PluginState>
  activeStepRequiredTools?: string[]
  activeStepRole?: 'inspect' | 'scaffold' | 'install' | 'feature' | 'preview' | 'console' | 'screenshot' | 'repair' | 'validate' | 'final_report'
  activeStepToolLoopBudget?: number
  finalReportReadBudget?: number
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
          persistedOutput?: PersistedToolResultRef
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

interface PersistedToolResultRef {
  path: string
  preview: string
  originalBytes: number
  truncated: true
  mime: 'application/json' | 'text/plain'
  createdAt: number
}

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

type RuntimeStreamEvent =
  | { type: 'text_delta'; streamId: string; taskId?: string; text: string }
  | { type: 'reasoning_delta'; streamId: string; taskId?: string; text: string }
  | { type: 'run_status'; streamId: string; taskId?: string; phase: AssistantRunPhase; providerId?: string; providerName?: string; model?: string }
  | { type: 'tool_call_started'; streamId: string; taskId?: string; partIndex: number; part: StreamChatOk['result']['parts'][number] }
  | { type: 'tool_result'; streamId: string; taskId?: string; partIndex: number; partId?: string; patch: Record<string, unknown> }
  | { type: 'task_plan_update'; streamId: string; taskId?: string; phase: 'started' | 'advanced' | 'completed' | 'blocked'; plan: unknown; validation?: unknown; stepTitle?: string; error?: string }
  | { type: 'error'; streamId: string; taskId?: string; message: string }

interface McpToolDescriptor {
  rawName: string
  name: string
  description?: string
  inputSchema?: unknown
}

interface UnitTestLogEntry {
  id: string
  kind: 'built-in' | 'mcp' | 'skill' | 'daemon' | 'feature'
  name: string
  status: 'passed' | 'failed'
  message?: string
  durationMs?: number
  request?: string
  toolCalls?: Array<{
    name?: string
    status?: string
    error?: string
    args?: Record<string, unknown>
  }>
  stopReason?: string
  fullContent?: string
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
const localListeners = new Map<string, Set<(payload: unknown) => void>>()
const directDaemonStreams = new Map<string, AbortController>()

function emitLocal<T>(channel: string, payload: T): void {
  const listeners = localListeners.get(channel)
  if (!listeners) return
  for (const handler of [...listeners]) handler(payload)
}

function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const localHandler = handler as (payload: unknown) => void
  const listeners = localListeners.get(channel) ?? new Set<(payload: unknown) => void>()
  listeners.add(localHandler)
  localListeners.set(channel, listeners)

  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
    listeners.delete(localHandler)
    if (listeners.size === 0) localListeners.delete(channel)
  }
}

function daemonBaseUrl(): string {
  const configured = process.env.AVA_DAEMON_URL
  if (configured) return configured.replace(/\/+$/, '')
  const host = process.env.AVA_DAEMON_HOST || '127.0.0.1'
  const port = process.env.AVA_DAEMON_PORT || '17871'
  return `http://${host}:${port}`
}

function useDirectDaemonStream(): boolean {
  const value = process.env.AVA_RENDERER_DAEMON_STREAM
  if (value === undefined) return true
  const normalized = value.toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}

function selectedProvider(args: StreamChatArgs): ModelProvider {
  return args.providers.find(provider => provider.enabled) ?? args.providers[0]
}

function selectedModel(provider: ModelProvider): string {
  return provider.defaultModel || provider.models[0] || 'daemon'
}

function daemonRequest(args: StreamChatArgs) {
  return {
    runId: args.streamId,
    messages: args.messages.map(message => ({
      role: message.role,
      content: message.content,
      taskId: message.taskId,
      toolCallId: message.toolCallId,
    })),
    activeStepId: args.activeStepRequiredTools?.join(',') || undefined,
    metadata: {
      streamOptions: {
        streamId: args.streamId,
        activeTaskId: args.activeTaskId,
        activeTaskPlan: args.activeTaskPlan,
        activeFolderPath: args.activeFolderPath,
        taskAllowedDirs: args.taskAllowedDirs,
        activeCommandInvocation: args.activeCommandInvocation,
        temperature: args.temperature,
        activeStepRequiredTools: args.activeStepRequiredTools,
        activeStepRole: args.activeStepRole,
        activeStepToolLoopBudget: args.activeStepToolLoopBudget,
        finalReportReadBudget: args.finalReportReadBudget,
      },
    },
  }
}

function applyToolPartUpdate(
  parts: StreamChatOk['result']['parts'],
  payload: PartUpdatePayload,
): StreamChatOk['result']['parts'] {
  return parts.map((part, index) => {
    const isTarget = payload.partId
      ? part.type === 'tool_call' && part.id === payload.partId
      : index === payload.partIndex
    return isTarget && part.type === 'tool_call'
      ? { ...part, ...payload.patch } as StreamChatOk['result']['parts'][number]
      : part
  })
}

async function streamViaDaemonDirect(args: StreamChatArgs): Promise<StreamChatReply> {
  const provider = selectedProvider(args)
  const model = selectedModel(provider)
  const controller = new AbortController()
  let fullContent = ''
  let parts: StreamChatOk['result']['parts'] = []
  let completed = false
  let failedError: string | null = null
  let sawSseEvent = false
  let runtimeProvider = provider
  let runtimeModel = model

  directDaemonStreams.set(args.streamId, controller)

  try {
    const client = new AvaClient({ baseUrl: daemonBaseUrl() })

    const handleEvent = (event: { type?: string; [key: string]: unknown }) => {
      sawSseEvent = true
      if (event.type === 'chat.ipc.event') {
        const channel = typeof event.channel === 'string' ? event.channel : ''
        const payload = event.payload
        if (channel) emitLocal(channel, payload)

        if (channel === 'ava:llm:chunk') {
          const chunk = payload as ChunkPayload
          if (chunk.streamId === args.streamId && typeof chunk.text === 'string') fullContent += chunk.text
        } else if (channel === 'ava:llm:status') {
          const status = payload as StatusPayload
          if (status.streamId === args.streamId) {
            if (typeof status.providerId === 'string' || typeof status.providerName === 'string') {
              runtimeProvider = {
                ...runtimeProvider,
                id: status.providerId ?? runtimeProvider.id,
                name: status.providerName ?? runtimeProvider.name,
              }
            }
            if (typeof status.model === 'string') runtimeModel = status.model
          }
        } else if (channel === 'ava:llm:part') {
          const partPayload = payload as PartPayload
          if (partPayload.streamId === args.streamId) parts = [...parts, partPayload.part]
        } else if (channel === 'ava:llm:partUpdate') {
          const updatePayload = payload as PartUpdatePayload
          if (updatePayload.streamId === args.streamId) parts = applyToolPartUpdate(parts, updatePayload)
        }
        return
      }

      if (event.type === 'chat.message.delta' && typeof event.delta === 'string') {
        fullContent += event.delta
        emitLocal('ava:llm:chunk', { streamId: args.streamId, text: event.delta })
        return
      }

      if (event.type === 'chat.run.completed') {
        completed = true
        return
      }

      if (event.type === 'chat.run.failed') {
        failedError = typeof event.error === 'string' ? event.error : 'Daemon chat stream failed.'
      }
    }

    await client.streamChatEvents({
      request: daemonRequest(args),
      signal: controller.signal,
      onEvent: handleEvent,
    })

    if (failedError) return { ok: false, error: failedError }
    if (!completed) return { ok: false, error: 'Daemon chat stream ended before chat.run.completed' }

    return {
      ok: true,
      result: {
        fullContent,
        parts: parts.length > 0 ? parts : (fullContent ? [{ type: 'text', text: fullContent }] : []),
        provider: runtimeProvider,
        model: runtimeModel,
        attempts: [{ providerId: runtimeProvider.id, providerName: runtimeProvider.name, model: runtimeModel, ok: true }],
        fallbackUsed: false,
        toolCallsIssued: parts.filter(part => part.type === 'tool_call').length,
        loopRounds: 0,
        detectedToolFormat: 'none',
      },
    }
  } catch (error) {
    if (!sawSseEvent) throw error
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    directDaemonStreams.delete(args.streamId)
  }
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

  agent: {
    analyzeTask: (request: unknown): Promise<unknown> => ipcRenderer.invoke('ava:agent:analyzeTask', request),
    planTask: (request: unknown): Promise<unknown> => ipcRenderer.invoke('ava:agent:planTask', request),
  },

  conversations: {
    load: (): Promise<unknown> => ipcRenderer.invoke('ava:conversations:load'),
    save: (data: unknown): Promise<boolean> => ipcRenderer.invoke('ava:conversations:save', data),
  },

  llm: {
    stream: async (args: StreamChatArgs): Promise<StreamChatReply> => {
      if (!useDirectDaemonStream()) return ipcRenderer.invoke('ava:llm:stream', args)
      try {
        return await streamViaDaemonDirect(args)
      } catch {
        return ipcRenderer.invoke('ava:llm:stream', args)
      }
    },
    abort: async (streamId: string): Promise<boolean> => {
      const controller = directDaemonStreams.get(streamId)
      if (controller) {
        controller.abort()
        directDaemonStreams.delete(streamId)
        return true
      }
      return ipcRenderer.invoke('ava:llm:abort', streamId)
    },
    probe: (args: { baseUrl: string; apiKey: string; providerId?: string }): Promise<
      { ok: true; models: string[] } | { ok: false; error: string }
    > => ipcRenderer.invoke('ava:llm:probe', args),
    probeModelCapabilities: (args: { provider: ModelProvider; model: string }): Promise<
      { ok: true; profile: ModelCapabilityProfile } | { ok: false; profile: ModelCapabilityProfile; error: string }
    > => ipcRenderer.invoke('ava:llm:probeModelCapabilities', args),
    onChunk: (handler: (payload: ChunkPayload) => void) => on<ChunkPayload>('ava:llm:chunk', handler),
    onReasoningChunk: (handler: (payload: ChunkPayload) => void) => on<ChunkPayload>('ava:llm:reasoning-chunk', handler),
    onAttempt: (handler: (payload: AttemptPayload) => void) => on<AttemptPayload>('ava:llm:attempt', handler),
    onStatus: (handler: (payload: StatusPayload) => void) => on<StatusPayload>('ava:llm:status', handler),
    onPart: (handler: (payload: PartPayload) => void) => on<PartPayload>('ava:llm:part', handler),
    onPartUpdate: (handler: (payload: PartUpdatePayload) => void) => on<PartUpdatePayload>('ava:llm:partUpdate', handler),
    onEvent: (handler: (payload: RuntimeStreamEvent) => void) => on<RuntimeStreamEvent>('ava:llm:event', handler),
  },

  mcp: {
    listServers: (): Promise<McpServerRuntime[]> => ipcRenderer.invoke('ava:mcp:listServers'),
    restart: (serverId: string): Promise<boolean> => ipcRenderer.invoke('ava:mcp:restart', serverId),
    onStatus: (handler: (payload: McpServerRuntime) => void) => on<McpServerRuntime>('ava:mcp:status', handler),
  },

  dev: {
    isEnabled: (): boolean => process.env.NODE_ENV === 'development' || process.env.AVA_E2E === '1',
    openControlPanel: (): Promise<string> => ipcRenderer.invoke('ava:dev:openControlPanel'),
    appendUnitTestResult: (entry: UnitTestLogEntry): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('ava:dev:appendUnitTestResult', entry),
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
    getMarketplaceCatalog: (states?: Record<string, PluginState>, options?: any): Promise<any> =>
      ipcRenderer.invoke('ava:plugins:getMarketplaceCatalog', states ?? {}, options ?? {}),
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
    createDir: (path: string): Promise<boolean> => ipcRenderer.invoke('ava:fs:createDir', path),
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
