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
  content: string
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
}

interface LlmAttempt {
  providerId: string
  providerName: string
  model: string
  ok: boolean
  status?: number
  error?: string
}

interface StreamChatArgs {
  streamId: string
  messages: LlmMessage[]
  providers: ModelProvider[]
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

interface PartPayload {
  streamId: string
  partIndex: number
  part: StreamChatOk['result']['parts'][number]
}

interface PartUpdatePayload {
  streamId: string
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
  mcpServerCount: number
  skillCount: number
  commandCount: number
  errors: string[]
}

// ── Event subscriptions (cleanup-aware) ─────────────────────────────
function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const ava = {
  ping: (): Promise<string> => ipcRenderer.invoke('ava:ping'),

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
    onAttempt: (handler: (payload: AttemptPayload) => void) => on<AttemptPayload>('ava:llm:attempt', handler),
    onPart: (handler: (payload: PartPayload) => void) => on<PartPayload>('ava:llm:part', handler),
    onPartUpdate: (handler: (payload: PartUpdatePayload) => void) => on<PartUpdatePayload>('ava:llm:partUpdate', handler),
  },

  mcp: {
    listServers: (): Promise<McpServerRuntime[]> => ipcRenderer.invoke('ava:mcp:listServers'),
    restart: (serverId: string): Promise<boolean> => ipcRenderer.invoke('ava:mcp:restart', serverId),
    onStatus: (handler: (payload: McpServerRuntime) => void) => on<McpServerRuntime>('ava:mcp:status', handler),
  },

  plugins: {
    list: (states: Record<string, PluginState>): Promise<DiscoveredPlugin[]> =>
      ipcRenderer.invoke('ava:plugins:list', states),
  },

  dialog: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('ava:dialog:pickDirectory'),
  },
}

contextBridge.exposeInMainWorld('ava', ava)

export type AvaApi = typeof ava
