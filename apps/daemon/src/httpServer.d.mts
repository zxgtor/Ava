import type { AvaChatStreamEvent, AvaChatStreamRequest } from '@ava/contracts'

export interface AvaDaemonRuntime {
  streamChat?: (
    request: AvaChatStreamRequest,
    emit: (event: AvaChatStreamEvent) => void,
  ) => Promise<void>
  [methodName: string]: unknown
}

export interface AvaDaemonServerOptions {
  host?: string
  port?: number | string
  runtime?: AvaDaemonRuntime | null
}

export interface AvaDaemonServerHandle {
  host: string
  port: number
  url: string
  server: unknown
  close: () => Promise<void>
}

export function startDaemonServer(options?: AvaDaemonServerOptions): Promise<AvaDaemonServerHandle>
