import { daemonBaseUrl } from './daemonChatClient'

type JsonResult<T> = { ok: true; result: T } | { ok: false; error: string }

async function daemonJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${daemonBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  const payload = await response.json().catch(() => null) as JsonResult<T> | null
  if (!response.ok || !payload?.ok) {
    const error = payload && 'error' in payload ? payload.error : `Daemon request failed: HTTP ${response.status}`
    throw new Error(error)
  }
  return payload.result
}

export const daemonRuntimeClient = {
  loadSettings: () => daemonJson<unknown>('/settings/load'),
  saveSettings: (data: unknown) => daemonJson<boolean>('/settings/save', {
    method: 'POST',
    body: JSON.stringify({ data }),
  }),
  listMcpServers: () => daemonJson<unknown[]>('/mcp/servers'),
  restartMcpServer: (serverId: string) => daemonJson<boolean>('/mcp/restart', {
    method: 'POST',
    body: JSON.stringify({ serverId }),
  }),
  unitTestContext: (states: unknown) => daemonJson<unknown>('/dev/unit-test-context', {
    method: 'POST',
    body: JSON.stringify({ states }),
  }),
  appendUnitTestResult: (entry: unknown) => daemonJson<unknown>('/dev/unit-test-results/append', {
    method: 'POST',
    body: JSON.stringify({ entry }),
  }),
  readUnitTestResults: () => daemonJson<unknown>('/dev/unit-test-results/read'),
  clearUnitTestResults: () => daemonJson<unknown>('/dev/unit-test-results/clear', { method: 'POST' }),
  listToolAudit: (limit?: number) => daemonJson<unknown[]>(`/tool-audit/list${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`),
  clearToolAudit: () => daemonJson<boolean>('/tool-audit/clear', { method: 'POST' }),
  listPlugins: (states: unknown) => daemonJson<unknown[]>('/plugins/list', {
    method: 'POST',
    body: JSON.stringify({ states }),
  }),
  listPluginCommands: (states: unknown) => daemonJson<unknown[]>('/plugins/list-commands', {
    method: 'POST',
    body: JSON.stringify({ states }),
  }),
  getMarketplaceCatalog: (states: unknown, options: unknown) => daemonJson<unknown>('/plugins/marketplace', {
    method: 'POST',
    body: JSON.stringify({ states, options }),
  }),
  installPluginFromGit: (url: string) => daemonJson<unknown>('/plugins/install-git', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }),
  installPluginFromFolder: (path: string) => daemonJson<unknown>('/plugins/install-folder', {
    method: 'POST',
    body: JSON.stringify({ path }),
  }),
  installPluginFromZip: (path: string) => daemonJson<unknown>('/plugins/install-zip', {
    method: 'POST',
    body: JSON.stringify({ path }),
  }),
  uninstallPlugin: (pluginId: string) => daemonJson<boolean>('/plugins/uninstall', {
    method: 'POST',
    body: JSON.stringify({ pluginId }),
  }),
  updatePlugin: (pluginId: string) => daemonJson<unknown>('/plugins/update', {
    method: 'POST',
    body: JSON.stringify({ pluginId }),
  }),
}
