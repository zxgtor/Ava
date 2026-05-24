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
} from './llm'

export {
  mcpSupervisor,
  type CallToolError,
  type CallToolResult,
  type McpServerConfig,
  type McpServerRuntime,
  type McpServerStatus,
  type McpToolDescriptor,
} from './services/mcpSupervisor'

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
} from './services/pluginManager'

export { builtInTools } from './services/builtInTools'
export { loadConversations, loadSettings, saveConversations, saveSettings } from './storage'
export { toolAuditLog } from './services/toolAuditLog'
export { processRegistry } from './services/processRegistry'
export { toolRuntime } from './services/toolRuntime'
export { runtimeEnvironmentInfo, runtimeEnvironmentPrompt } from './services/runtimeEnvironment'
export { windowsEnvironmentDriver } from './services/windowsEnvironmentDriver'
export type {
  EnvironmentAction,
  EnvironmentActionResult,
  EnvironmentDriver,
  EnvironmentEvent,
  EnvironmentObservation,
  EnvironmentState,
  EnvironmentStateQuery,
  EnvironmentVerification,
} from './services/environmentDriver'
