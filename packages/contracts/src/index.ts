export type AvaRunPhase = 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'aborted'

export type AvaToolCallStatus = 'pending' | 'running' | 'ok' | 'error' | 'aborted'

export type TaskExecutionStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type TaskExecutionPlanStatus = 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'aborted'
export type TaskExecutionStepRole =
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

export interface TaskExecutionEvidence {
  toolName: string
  toolCallId: string
  status: AvaToolCallStatus
  timestamp: number
  summary?: string
  processId?: string
  command?: string
  exitCode?: number | null
  persistedOutputPath?: string
}

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
  evidence?: TaskExecutionEvidence[]
  dependsOn?: string[]
  subtasks?: TaskExecutionStep[]
  workflowType?: 'scaffold' | 'feature' | 'debug' | 'refactor' | 'research'
  role?: TaskExecutionStepRole
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
  architectureConstraints?: string
  createdAt: number
  updatedAt: number
}

export interface ProjectUnknown {
  question: string
  options: string[]
  importance: 'high' | 'medium' | 'low'
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

export interface AvaTaskAnalyzeRequest {
  taskId: string
  goal: string
  workingDirectory?: string
  messages?: AvaChatMessage[]
  traits?: string[]
}

export interface AvaTaskPlanRequest {
  conversationId?: string
  taskId: string
  goal: string
  workingDirectory?: string
  analysis?: ProjectAnalysis | null
  traits?: string[]
  messages?: AvaChatMessage[]
}

export interface AvaTaskAnalyzeResult {
  analysis: ProjectAnalysis | null
}

export interface AvaTaskPlanResult {
  plan: TaskExecutionPlan
  fallbackUsed: boolean
}

export interface AvaTaskPlanGetRequest {
  conversationId: string
}

export interface AvaTaskPlanSetRequest {
  conversationId: string
  plan: TaskExecutionPlan
}

export interface AvaTaskPlanClearRequest {
  conversationId: string
}

export interface AvaTaskPlanStateResult {
  conversationId: string
  plan?: TaskExecutionPlan
}

export interface AvaWorkspaceListEntry {
  name: string
  isDirectory: boolean
  size: number
}

export interface AvaWorkspaceEnsureProjectDocsRequest {
  folderPath: string
  title: string
  trait?: string
}

export interface AvaWorkspaceEnsureProjectDocsResult {
  folderPath: string
  created: string[]
  existing: string[]
}

export type AvaTaskIntakeStage = 'clarifying' | 'awaiting_summary_confirm' | 'ready_to_plan' | 'canceled'

export interface AvaTaskIntakeAnswer {
  question: string
  answer: string
}

export interface AvaTaskIntakeSession {
  sessionId: string
  conversationId: string
  taskId: string
  content: string
  workingDirectory?: string
  analysis?: ProjectAnalysis
  clarificationAnswers: AvaTaskIntakeAnswer[]
  stage: AvaTaskIntakeStage
  createdAt: number
  updatedAt: number
}

export interface AvaTaskIntakeStartRequest {
  conversationId: string
  taskId: string
  content: string
  workingDirectory?: string
  messages?: AvaChatMessage[]
  traits?: string[]
  attachments?: AvaInputAttachment[]
  hasCommandInvocation?: boolean
}

export interface AvaTaskIntakeReplyRequest {
  sessionId: string
  conversationId: string
  content: string
  workingDirectory?: string
  messages?: AvaChatMessage[]
  traits?: string[]
}

export interface AvaTaskIntakeResult {
  session: AvaTaskIntakeSession
  messageText: string
  readyToPlan: boolean
  canceled?: boolean
  finalGoal?: string
  workingDirectory?: string
  analysis?: ProjectAnalysis | null
}

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

export interface AvaChatClientContext {
  conversation: {
    id: string
    title?: string
    traits?: string[]
    folderPath?: string
    messages: AvaChatMessage[]
  }
  projectBrief?: {
    files: string[]
    tasksDone: number
    tasksTotal: number
  }
  folderPath?: string
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

export type AvaInputRoute =
  | 'normal_chat'
  | 'meta_question'
  | 'task_intake'
  | 'continue_intake'
  | 'task_confirmation'
  | 'requirement_correction'
  | 'cancel_or_pause'
  | 'retry_or_continue'
  | 'permission_response'
  | 'small_task'
  | 'file_or_attachment_input'
  | 'url_input'
  | 'agent_delegation'
  | 'preference_or_setting'
  | 'unknown_or_ambiguous'

export type AvaInputWorkflow =
  | 'chat'
  | 'intake'
  | 'intake_reply'
  | 'intake_reanalysis'
  | 'cancel'
  | 'recovery'
  | 'permission'
  | 'direct_tool'
  | 'file_media'
  | 'browser'
  | 'delegation'
  | 'settings'
  | 'clarify'

export type AvaInputClassifySource = 'rule' | 'llm' | 'fallback'

export type AvaInputAttachment = {
  kind?: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'code' | 'url' | 'unknown'
  path?: string
  url?: string
  name?: string
  mimeType?: string
  sizeBytes?: number
}

export type AvaInputClassifyRequest = {
  content: string
  hasCommandInvocation?: boolean
  pendingIntake?: boolean
  pendingIntakeStage?: 'clarifying' | 'awaiting_summary_confirm'
  workingDirectory?: string
  traits?: string[]
  attachments?: AvaInputAttachment[]
}

export type AvaInputClassifyResult = {
  route: AvaInputRoute
  workflow: AvaInputWorkflow
  requiresTaskIntake: boolean
  needsClarification?: boolean
  source: AvaInputClassifySource
  reason: string
  confidence: number
}

export type AvaWorkflowAction =
  | 'run_chat'
  | 'start_task_intake'
  | 'continue_intake'
  | 'confirm_task'
  | 'reanalyze_intake'
  | 'cancel_intake'
  | 'recover_task'
  | 'handle_permission'
  | 'run_direct_tool'
  | 'handle_file_media'
  | 'handle_url'
  | 'delegate_to_code_agent'
  | 'update_preference'
  | 'ask_clarifying_question'

export type AvaWorkflowImplementationStatus = 'implemented' | 'planned'

export type AvaInputDispatchRequest = AvaInputClassifyRequest

export type AvaActionPreview = {
  text: string
  requiresConfirmation: boolean
}

export type AvaInputDispatchResult = {
  classification: AvaInputClassifyResult
  action: AvaWorkflowAction
  workflow: AvaInputWorkflow
  status: AvaWorkflowImplementationStatus
  fallbackAction?: AvaWorkflowAction
  actionPreview?: AvaActionPreview
  reason: string
}

export type AvaCodeAgentId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'openclaw'

export type AvaCodeAgentTaskKind = 'scaffold' | 'feature' | 'debug' | 'refactor' | 'research' | 'design' | 'unknown'

export type AvaCodeAgentSessionStatus = 'created' | 'starting' | 'running' | 'blocked' | 'completed' | 'failed' | 'stopped'

export type AvaCodeAgentProfile = {
  id: AvaCodeAgentId
  name: string
  command: string
  strengths: AvaCodeAgentTaskKind[]
  fallbackRank: number
}

export type AvaCodeAgentTaskRequest = {
  goal: string
  workingDirectory?: string
  taskKind?: AvaCodeAgentTaskKind
  preferredAgentId?: AvaCodeAgentId
  constraints?: string[]
  validationCommands?: string[]
  startImmediately?: boolean
  timeoutMs?: number
}

export type AvaCodeAgentSelection = {
  agent: AvaCodeAgentProfile
  score: number
  reasons: string[]
  probe?: {
    status: 'ready' | 'missing' | 'error'
    version?: string
    error?: string
  }
}

export type AvaCodeAgentEvent = {
  id: string
  sessionId: string
  type: 'selected' | 'task_packaged' | 'starting' | 'started' | 'stdout' | 'stderr' | 'message_sent' | 'message_queued' | 'exit' | 'completed' | 'failed' | 'blocked' | 'stopped'
  message: string
  createdAt: number
}

export type AvaCodeAgentProcessInfo = {
  pid?: number
  command: string
  args: string[]
  cwd?: string
  startedAt?: number
  exitedAt?: number
  exitCode?: number | null
  signal?: string | null
}

export type AvaCodeAgentSession = {
  sessionId: string
  status: AvaCodeAgentSessionStatus
  selected: AvaCodeAgentSelection
  task: AvaCodeAgentTaskRequest
  taskPackage: string
  process?: AvaCodeAgentProcessInfo
  events: AvaCodeAgentEvent[]
  createdAt: number
  updatedAt: number
}

export type AvaCodeAgentDispatchResult = {
  session?: AvaCodeAgentSession
  candidates: AvaCodeAgentSelection[]
  status: 'assigned' | 'blocked'
  reason: string
}

export type AvaCodeAgentSessionListResult = {
  sessions: AvaCodeAgentSession[]
}

export type AvaCodeAgentSendMessageRequest = {
  sessionId: string
  message: string
}

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
  | '/input/classify'
  | '/input/dispatch'
  | '/intake/start'
  | '/intake/reply'
  | '/tasks/analyze'
  | '/tasks/plan'
  | '/tasks/active-plan/get'
  | '/tasks/active-plan/set'
  | '/tasks/active-plan/clear'
  | '/workspace/ensure-project-docs'
  | '/workspace/read-text'
  | '/workspace/write-text'
  | '/workspace/create-dir'
  | '/workspace/list-dir'
  | '/workspace/code-agents'
  | '/workspace/code-agents/install'
  | '/code-agents/profiles'
  | '/code-agents/dispatch'
  | '/code-agents/sessions'
  | '/code-agents/sessions/start'
  | '/code-agents/sessions/send'
  | '/code-agents/sessions/stop'
  | '/environment/open-path'
  | '/environment/open-terminal'
  | '/environment/open-vscode'
  | '/mcp/servers'
  | '/mcp/restart'
  | '/chat/stream'
  | '/chat/ws'

export type AvaDaemonStreamOptions = {
  streamId: string
  conversationId?: string
  activeTaskId?: string
  activeTaskPlan?: unknown
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
    clientContext?: AvaChatClientContext
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
