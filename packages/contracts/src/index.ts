export type AvaRunPhase = 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'aborted'

export type AvaChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type AvaChatTextPart = {
  type: 'text'
  text: string
}

export type AvaChatImageUrlPart = {
  type: 'image_url'
  image_url: {
    url: string
  }
}

export type AvaChatToolCallPart = {
  type: 'tool_call'
  id: string
  name: string
  arguments: unknown
}

export type AvaChatToolResultPart = {
  type: 'tool_result'
  toolCallId: string
  name: string
  ok: boolean
  result?: unknown
  error?: string
}

export type AvaChatContentPart =
  | AvaChatTextPart
  | AvaChatImageUrlPart
  | AvaChatToolCallPart
  | AvaChatToolResultPart

export type AvaChatMessage = {
  id?: string
  role: AvaChatRole
  content: string | AvaChatContentPart[]
  taskId?: string
  toolCallId?: string
  createdAt?: string
}

export type AvaChatStreamRequest = {
  conversationId?: string
  runId?: string
  providerId?: string
  model?: string
  messages: AvaChatMessage[]
  activeTaskPlanId?: string
  activeStepId?: string
  metadata?: Record<string, unknown>
}

export type AvaApiOk<T> = {
  ok: true
  result: T
}

export type AvaApiErr = {
  ok: false
  error: string
  runtimeAttached?: boolean
}

export type AvaApiResponse<T> = AvaApiOk<T> | AvaApiErr

export type AvaDaemonStatus = {
  ok: true
  service: 'ava-daemon'
  version: string
  pid: number
  uptimeMs: number
  cwd: string
  platform: string
  arch: string
  node: string
  runtimeAttached: boolean
}

export type AvaDaemonApiPath =
  | '/health'
  | '/runtime/status'
  | '/settings/load'
  | '/settings/save'
  | '/mcp/servers'
  | '/mcp/restart'
  | '/chat/stream'
  | '/chat/ws'

export type AvaDaemonStreamOptions = {
  streamId: string
  activeTaskId?: string
  activeFolderPath?: string
  taskAllowedDirs?: string[]
  activeCommandInvocation?: unknown
  temperature?: number
  activeStepRequiredTools?: string[]
  activeStepRole?: 'inspect' | 'scaffold' | 'install' | 'feature' | 'preview' | 'console' | 'screenshot' | 'repair' | 'validate' | 'final_report'
  activeStepToolLoopBudget?: number
  finalReportReadBudget?: number
}

export type AvaDaemonChatRequest = Omit<AvaChatStreamRequest, 'metadata'> & {
  metadata?: {
    streamOptions?: AvaDaemonStreamOptions
    /** Compatibility only. New clients should let daemon load config/model routing. */
    streamChatArgs?: unknown
    [key: string]: unknown
  }
}

export type AvaMcpServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export type AvaMcpToolDescriptor = {
  rawName: string
  name: string
  description?: string
  inputSchema?: unknown
}

export type AvaMcpServerRuntime = {
  id: string
  name: string
  enabled: boolean
  allowedDirs?: string[]
  builtin?: boolean
  pluginId?: string
  status: AvaMcpServerStatus
  pid?: number
  tools?: AvaMcpToolDescriptor[]
  lastError?: string
  startedAt?: number
}

export type AvaChatRunStartedEvent = {
  type: 'chat.run.started'
  runId: string
  phase: AvaRunPhase
  timestamp: string
  runtimeAttached: boolean
}

export type AvaChatMessageDeltaEvent = {
  type: 'chat.message.delta'
  runId: string
  delta: string
}

export type AvaChatMessageCompletedEvent = {
  type: 'chat.message.completed'
  runId: string
  message: AvaChatMessage
}

export type AvaChatRunCompletedEvent = {
  type: 'chat.run.completed'
  runId: string
  phase: 'completed'
  timestamp: string
}

export type AvaChatRunFailedEvent = {
  type: 'chat.run.failed'
  runId: string
  phase: 'failed'
  timestamp: string
  error: string
}

export type AvaChatIpcEvent = {
  type: 'chat.ipc.event'
  runId: string
  channel: string
  payload: unknown
}

export type AvaChatStreamEvent =
  | AvaChatRunStartedEvent
  | AvaChatMessageDeltaEvent
  | AvaChatMessageCompletedEvent
  | AvaChatRunCompletedEvent
  | AvaChatRunFailedEvent
  | AvaChatIpcEvent
