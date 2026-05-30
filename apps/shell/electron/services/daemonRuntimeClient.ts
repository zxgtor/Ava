import { AvaClient } from '@ava/client-sdk'
import { daemonBaseUrl } from './daemonChatClient'

function client(): AvaClient {
  return new AvaClient({ baseUrl: daemonBaseUrl() })
}

export const daemonRuntimeClient = {
  loadSettings: () => client().loadSettings(),
  saveSettings: (data: unknown) => client().saveSettings(data),
  classifyInput: (request: any) => client().classifyInput(request),
  dispatchInput: (request: any) => client().dispatchInput(request),
  analyzeTask: (request: any) => client().analyzeTask(request),
  planTask: (request: any) => client().planTask(request),
  listMcpServers: () => client().listMcpServers<unknown[]>(),
  restartMcpServer: (serverId: string) => client().restartMcpServer(serverId),
  appendUnitTestResult: (entry: unknown) => client().appendUnitTestResult(entry),
  listToolAudit: (limit?: number) => client().listToolAudit<unknown[]>(limit),
  clearToolAudit: () => client().clearToolAudit(),
  listPlugins: (states: unknown) => client().listPlugins<unknown[]>(states),
  listPluginCommands: (states: unknown) => client().listPluginCommands<unknown[]>(states),
  getMarketplaceCatalog: (states: unknown, options: unknown) => client().getMarketplaceCatalog(states, options),
  installPluginFromGit: (url: string) => client().installPluginFromGit(url),
  installPluginFromFolder: (path: string) => client().installPluginFromFolder(path),
  installPluginFromZip: (path: string) => client().installPluginFromZip(path),
  uninstallPlugin: (pluginId: string) => client().uninstallPlugin(pluginId),
  updatePlugin: (pluginId: string) => client().updatePlugin(pluginId),
}
