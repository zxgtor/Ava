import { loadSettings } from '../storage'
import type { ModelProvider, StreamChatArgs, ToolCallFormat } from '../llm'
import type { PluginState } from './pluginManager'

interface RuntimeSettings {
  version?: unknown
  modelProviders?: unknown
  primaryModelChain?: unknown
  modelToolFormatMap?: unknown
  modelCapabilityMap?: unknown
  pluginStates?: unknown
}

export interface DaemonStreamOptions {
  streamId: string
  activeTaskId?: string
  activeFolderPath?: string
  taskAllowedDirs?: string[]
  activeCommandInvocation?: StreamChatArgs['activeCommandInvocation']
  temperature?: number
  activeStepRequiredTools?: string[]
  activeStepRole?: StreamChatArgs['activeStepRole']
  activeStepToolLoopBudget?: number
  finalReportReadBudget?: number
}

function isProvider(raw: unknown): raw is ModelProvider {
  if (!raw || typeof raw !== 'object') return false
  const item = raw as Partial<ModelProvider>
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.baseUrl === 'string' &&
    typeof item.defaultModel === 'string' &&
    Array.isArray(item.models)
  )
}

function providersFromSettings(settings: RuntimeSettings): ModelProvider[] {
  return Array.isArray(settings.modelProviders)
    ? settings.modelProviders.filter(isProvider)
    : []
}

function providerChainFromSettings(settings: RuntimeSettings, providers: ModelProvider[]): string[] {
  const ids = new Set(providers.map(provider => provider.id))
  const rawChain = Array.isArray(settings.primaryModelChain) ? settings.primaryModelChain : []
  const chain = rawChain
    .filter((id): id is string => typeof id === 'string' && ids.has(id))
    .filter((id, index, arr) => arr.indexOf(id) === index)
  return chain.length > 0 ? chain : providers.map(provider => provider.id)
}

function toolFormatMapFromSettings(settings: RuntimeSettings, providers: ModelProvider[]): Record<string, ToolCallFormat> {
  const result: Record<string, ToolCallFormat> = {}
  if (settings.modelToolFormatMap && typeof settings.modelToolFormatMap === 'object') {
    for (const [key, value] of Object.entries(settings.modelToolFormatMap)) {
      if (value === 'openai' || value === 'hermes' || value === 'none') result[key] = value
    }
  }
  if (settings.modelCapabilityMap && typeof settings.modelCapabilityMap === 'object') {
    for (const [key, value] of Object.entries(settings.modelCapabilityMap)) {
      if (!value || typeof value !== 'object') continue
      const capability = value as { tools?: unknown; toolFormat?: unknown }
      const separatorIndex = key.indexOf(':')
      const providerId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key
      const provider = providers.find(item => item.id === providerId)
      if (capability.toolFormat === 'openai' || capability.toolFormat === 'hermes') {
        result[key] = capability.toolFormat
        continue
      }
      // A local OpenAI-compatible server can expose no native function-calling
      // support while still following Ava's XML/Hermes tool-call prompt.
      if (provider?.type === 'local' && (capability.tools === 'no' || capability.toolFormat === 'none')) {
        result[key] = 'hermes'
      }
    }
  }
  return result
}

function pluginStatesFromSettings(settings: RuntimeSettings): Record<string, PluginState> {
  if (!settings.pluginStates || typeof settings.pluginStates !== 'object') return {}
  const result: Record<string, PluginState> = {}
  for (const [id, value] of Object.entries(settings.pluginStates)) {
    if (value && typeof value === 'object') {
      result[id] = { enabled: Boolean((value as { enabled?: unknown }).enabled) }
    }
  }
  return result
}

export async function resolveStreamChatArgsFromDaemonConfig(
  requestMessages: StreamChatArgs['messages'],
  options: DaemonStreamOptions,
): Promise<StreamChatArgs> {
  const settings = (await loadSettings() ?? {}) as RuntimeSettings
  const providers = providersFromSettings(settings)
  const chain = providerChainFromSettings(settings, providers)
  const enabledProviders = chain
    .map(id => providers.find(provider => provider.id === id))
    .filter((provider): provider is ModelProvider => Boolean(provider?.enabled && provider.baseUrl && provider.defaultModel))

  if (enabledProviders.length === 0) {
    throw new Error('No enabled LLM provider in daemon settings. Open Settings to configure one.')
  }

  return {
    streamId: options.streamId,
    messages: requestMessages,
    providers: enabledProviders,
    activeTaskId: options.activeTaskId,
    activeFolderPath: options.activeFolderPath,
    taskAllowedDirs: options.taskAllowedDirs,
    activeCommandInvocation: options.activeCommandInvocation,
    temperature: options.temperature,
    toolFormatMap: toolFormatMapFromSettings(settings, providers),
    pluginStates: pluginStatesFromSettings(settings),
    activeStepRequiredTools: options.activeStepRequiredTools,
    activeStepRole: options.activeStepRole,
    activeStepToolLoopBudget: options.activeStepToolLoopBudget,
    finalReportReadBudget: options.finalReportReadBudget,
  }
}
