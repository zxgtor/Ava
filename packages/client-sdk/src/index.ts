import type {
  AvaApiResponse,
  AvaChatStreamEvent,
  AvaDaemonChatRequest,
  AvaDaemonStatus,
} from '@ava/contracts'

export interface AvaClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
}

export interface StreamChatEventsOptions {
  request: AvaDaemonChatRequest
  signal?: AbortSignal
  onEvent?: (event: AvaChatStreamEvent) => void
}

export class AvaClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl?: typeof WebSocket

  constructor(options: AvaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:17871').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.WebSocketImpl = options.WebSocketImpl ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket)
  }

  async status(): Promise<AvaDaemonStatus> {
    return this.getJson<AvaDaemonStatus>('/runtime/status')
  }

  async health(): Promise<AvaDaemonStatus> {
    return this.getJson<AvaDaemonStatus>('/health')
  }

  async loadSettings<T = unknown>(): Promise<T> {
    return this.getResult<T>('/settings/load')
  }

  async saveSettings(data: unknown): Promise<boolean> {
    return this.postResult<boolean>('/settings/save', { data })
  }

  async listMcpServers<T = unknown>(): Promise<T> {
    return this.getResult<T>('/mcp/servers')
  }

  async restartMcpServer(serverId: string): Promise<boolean> {
    return this.postResult<boolean>('/mcp/restart', { serverId })
  }

  async unitTestContext<T = unknown>(states: unknown): Promise<T> {
    return this.postResult<T>('/dev/unit-test-context', { states })
  }

  async appendUnitTestResult<T = unknown>(entry: unknown): Promise<T> {
    return this.postResult<T>('/dev/unit-test-results/append', { entry })
  }

  async readUnitTestResults<T = unknown>(): Promise<T> {
    return this.getResult<T>('/dev/unit-test-results/read')
  }

  async clearUnitTestResults<T = unknown>(): Promise<T> {
    return this.postResult<T>('/dev/unit-test-results/clear', {})
  }

  async listToolAudit<T = unknown>(limit?: number): Promise<T> {
    const path = limit ? `/tool-audit/list?limit=${encodeURIComponent(String(limit))}` : '/tool-audit/list'
    return this.getResult<T>(path)
  }

  async clearToolAudit(): Promise<boolean> {
    return this.postResult<boolean>('/tool-audit/clear', {})
  }

  async listPlugins<T = unknown>(states: unknown): Promise<T> {
    return this.postResult<T>('/plugins/list', { states })
  }

  async listPluginCommands<T = unknown>(states: unknown): Promise<T> {
    return this.postResult<T>('/plugins/list-commands', { states })
  }

  async getMarketplaceCatalog<T = unknown>(states: unknown, options: unknown): Promise<T> {
    return this.postResult<T>('/plugins/marketplace', { states, options })
  }

  async installPluginFromGit<T = unknown>(url: string): Promise<T> {
    return this.postResult<T>('/plugins/install-git', { url })
  }

  async installPluginFromFolder<T = unknown>(path: string): Promise<T> {
    return this.postResult<T>('/plugins/install-folder', { path })
  }

  async installPluginFromZip<T = unknown>(path: string): Promise<T> {
    return this.postResult<T>('/plugins/install-zip', { path })
  }

  async uninstallPlugin(pluginId: string): Promise<boolean> {
    return this.postResult<boolean>('/plugins/uninstall', { pluginId })
  }

  async updatePlugin<T = unknown>(pluginId: string): Promise<T> {
    return this.postResult<T>('/plugins/update', { pluginId })
  }

  async streamChatEvents(options: StreamChatEventsOptions): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/stream`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.request),
      signal: options.signal,
    })

    if (!response.ok) {
      throw new Error(`Daemon chat stream failed: HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error('Daemon chat stream failed: empty response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseEvents(buffer)
      buffer = parsed.rest
      parsed.events.forEach(event => options.onEvent?.(event))
    }

    buffer += decoder.decode()
    parseSseEvents(buffer).events.forEach(event => options.onEvent?.(event))
  }

  streamChatWebSocketEvents(options: StreamChatEventsOptions): Promise<void> {
    if (!this.WebSocketImpl) {
      return Promise.reject(new Error('WebSocket is not available in this runtime.'))
    }

    const wsUrl = this.baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/chat/ws'
    const WebSocketCtor = this.WebSocketImpl

    return new Promise((resolve, reject) => {
      const ws = new WebSocketCtor(wsUrl)
      let settled = false

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }

      const abort = () => {
        ws.close()
        finish(new Error('Daemon WebSocket stream aborted.'))
      }

      options.signal?.addEventListener('abort', abort, { once: true })

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(options.request))
      })
      ws.addEventListener('message', (message) => {
        try {
          const event = JSON.parse(String(message.data)) as AvaChatStreamEvent
          options.onEvent?.(event)
          if (event.type === 'chat.run.completed') finish()
          if (event.type === 'chat.run.failed') finish(new Error(event.error))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      ws.addEventListener('error', () => {
        finish(new Error('Daemon WebSocket stream failed.'))
      })
      ws.addEventListener('close', () => {
        options.signal?.removeEventListener('abort', abort)
        finish()
      })
    })
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Daemon request failed: HTTP ${response.status}`)
    return response.json() as Promise<T>
  }

  private async getResult<T>(path: string): Promise<T> {
    return unwrapResult<T>(await this.getJson<AvaApiResponse<T>>(path))
  }

  private async postResult<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as AvaApiResponse<T> | null
    if (!response.ok || !payload) {
      throw new Error(`Daemon request failed: HTTP ${response.status}`)
    }
    return unwrapResult(payload)
  }
}

export function parseSseEvents(buffer: string): { events: AvaChatStreamEvent[]; rest: string } {
  const events: AvaChatStreamEvent[] = []
  let rest = buffer
  let boundary = rest.indexOf('\n\n')

  while (boundary >= 0) {
    const rawEvent = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    boundary = rest.indexOf('\n\n')

    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())

    if (dataLines.length === 0) continue
    try {
      events.push(JSON.parse(dataLines.join('\n')) as AvaChatStreamEvent)
    } catch {
      // Ignore malformed SSE frames. Callers fail separately if completion is missing.
    }
  }

  return { events, rest }
}

function unwrapResult<T>(payload: AvaApiResponse<T>): T {
  if (payload.ok) return payload.result
  throw new Error(payload.error)
}
