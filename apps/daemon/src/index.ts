// Ava Core Runtime facade.
//
// Phase 1 keeps the implementation in the existing Electron main-process
// files and exposes the runtime through this daemon boundary. Later phases can
// move these modules here without changing shell imports again.

export {
  abortStream,
  streamChat,
  type AssistantRunPhase,
  type LlmAttempt,
  type LlmMessage,
  type LlmMessagePart,
  type ModelProvider,
  type RuntimeStreamEvent,
  type StreamChatArgs,
  type StreamChatResult,
  type StreamStepArgs,
  type StreamStepResult,
  type ToolCallCandidate,
  type ToolCallFormat,
  type ToolCallPart,
  type ToolCallStatus,
} from '../../shell/electron/llm'

export {
  mcpSupervisor,
  type CallToolError,
  type CallToolResult,
  type McpServerConfig,
  type McpServerRuntime,
  type McpServerStatus,
  type McpToolDescriptor,
} from '../../shell/electron/services/mcpSupervisor'

export {
  pluginManager,
  type DiscoveredPlugin,
  type MarketplaceCatalog,
  type MarketplaceCatalogOptions,
  type MarketplaceItem,
  type MarketplaceItemSource,
  type MarketplaceItemType,
  type PluginCommand,
  type PluginCommandArgument,
  type PluginManifestView,
  type PluginMcpServerView,
  type PluginSkill,
  type PluginSkillCandidate,
  type PluginSourceInfo,
  type PluginSourceKind,
  type PluginState,
} from '../../shell/electron/services/pluginManager'

export { builtInTools } from '../../shell/electron/services/builtInTools'
export { toolAuditLog } from '../../shell/electron/services/toolAuditLog'
export { processRegistry } from '../../shell/electron/services/processRegistry'
export { toolRuntime } from '../../shell/electron/services/toolRuntime'
export { runtimeEnvironmentInfo, runtimeEnvironmentPrompt } from '../../shell/electron/services/runtimeEnvironment'
export { windowsEnvironmentDriver } from '../../shell/electron/services/windowsEnvironmentDriver'
export type {
  EnvironmentAction,
  EnvironmentActionResult,
  EnvironmentDriver,
  EnvironmentEvent,
  EnvironmentObservation,
  EnvironmentState,
  EnvironmentStateQuery,
  EnvironmentVerification,
} from '../../shell/electron/services/environmentDriver'
