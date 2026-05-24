export type EnvironmentDriverName = 'windows'

export interface EnvironmentObservation {
  driver: EnvironmentDriverName
  summary: string
  capabilities: string[]
  raw?: unknown
}

export interface EnvironmentStateQuery {
  scope?: string
  target?: string
}

export interface EnvironmentState {
  driver: EnvironmentDriverName
  scope?: string
  target?: string
  status: 'available' | 'unavailable' | 'partial'
  raw?: unknown
}

export interface EnvironmentAction {
  type: 'mcp_tool' | 'semantic'
  name: string
  args?: Record<string, unknown>
}

export interface EnvironmentActionResult {
  ok: boolean
  content?: unknown
  error?: string
  isError?: boolean
  aborted?: boolean
}

export interface EnvironmentEvent {
  driver: EnvironmentDriverName
  type: string
  payload?: unknown
  createdAt: number
}

export interface EnvironmentVerification {
  ok: boolean
  summary: string
  evidence?: unknown
}

export interface EnvironmentDriver {
  readonly name: EnvironmentDriverName

  observe(): Promise<EnvironmentObservation>
  queryState(query?: EnvironmentStateQuery): Promise<EnvironmentState>
  act(action: EnvironmentAction): Promise<EnvironmentActionResult>
  subscribeEvents(handler: (event: EnvironmentEvent) => void): () => void
  verifyResult(action: EnvironmentAction, result: EnvironmentActionResult): Promise<EnvironmentVerification>
}
