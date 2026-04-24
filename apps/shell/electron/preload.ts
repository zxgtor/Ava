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
  role: 'system' | 'user' | 'assistant'
  content: string
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
}

interface StreamChatOk {
  ok: true
  result: {
    fullContent: string
    provider: ModelProvider
    model: string
    attempts: LlmAttempt[]
    fallbackUsed: boolean
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
  },
}

contextBridge.exposeInMainWorld('ava', ava)

export type AvaApi = typeof ava
