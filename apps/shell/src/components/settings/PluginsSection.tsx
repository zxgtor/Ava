import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import type { DiscoveredPlugin, Settings } from '../../types'
import { Toggle } from './shared'

export function PluginsSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const [plugins, setPlugins] = useState<DiscoveredPlugin[]>([])
  const [runtime, setRuntime] = useState<Record<string, Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]>>({})
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [gitUrl, setGitUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.ava.plugins.list(settings.pluginStates)
      setPlugins(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [settings.pluginStates])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    window.ava.mcp.listServers()
      .then(list => setRuntime(Object.fromEntries(list.map(item => [item.id, item]))))
      .catch(() => { /* noop */ })
    const off = window.ava.mcp.onStatus(server => {
      setRuntime(prev => ({ ...prev, [server.id]: server }))
    })
    return off
  }, [])

  const setPluginEnabled = (pluginId: string, enabled: boolean) => {
    const plugin = plugins.find(item => item.id === pluginId)
    if (enabled && plugin?.permissions.length) {
      const ok = window.confirm([
        `启用插件 "${plugin.manifest?.name ?? plugin.id}"？`,
        '',
        '它会获得这些能力：',
        ...plugin.permissions.map(item => `- ${item}`),
      ].join('\n'))
      if (!ok) return
    }
    update(s => ({
      ...s,
      pluginStates: {
        ...s.pluginStates,
        [pluginId]: { enabled },
      },
    }))
  }

  const install = async (kind: 'folder' | 'zip' | 'git') => {
    setInstalling(true)
    setError(null)
    try {
      if (kind === 'folder') await window.ava.plugins.installFolder()
      else if (kind === 'zip') await window.ava.plugins.installZip()
      else {
        if (!gitUrl.trim()) return
        await window.ava.plugins.installGit(gitUrl.trim())
        setGitUrl('')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const uninstall = async (plugin: DiscoveredPlugin) => {
    const ok = window.confirm(`卸载插件 "${plugin.manifest?.name ?? plugin.id}"？\n\n这会删除插件目录：\n${plugin.rootPath}`)
    if (!ok) return
    setInstalling(true)
    setError(null)
    try {
      await window.ava.plugins.uninstall(plugin.id)
      update(s => {
        const nextStates = { ...s.pluginStates }
        delete nextStates[plugin.id]
        return { ...s, pluginStates: nextStates }
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const updatePlugin = async (plugin: DiscoveredPlugin) => {
    setInstalling(true)
    setError(null)
    try {
      await window.ava.plugins.update(plugin.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">Plugins</h2>
          <p className="text-xs text-text-3 mt-1">扫描 plugins / user-plugins；启用后插件内的 stdio MCP server 会接入工具系统。</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-text bg-surface border border-border-subtle rounded-full cursor-pointer hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="mb-3 p-3 bg-surface border border-border-subtle rounded-lg space-y-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => install('folder')}
            disabled={installing}
            className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Install folder
          </button>
          <button
            type="button"
            onClick={() => install('zip')}
            disabled={installing}
            className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Install zip
          </button>
        </div>
        <div className="flex gap-2">
          <input
            value={gitUrl}
            onChange={e => setGitUrl(e.target.value)}
            placeholder="Git plugin URL..."
            className="flex-1 px-3 py-1.5 text-sm text-text bg-bg border border-border-subtle rounded-md outline-none focus:border-accent/60"
          />
          <button
            type="button"
            onClick={() => install('git')}
            disabled={installing || !gitUrl.trim()}
            className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Install git
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-error mb-2">{error}</div>}
      {plugins.length === 0 ? (
        <div className="px-3 py-3 text-xs text-text-3 bg-surface border border-border-subtle rounded-lg">
          未发现插件。把插件放到 user-plugins/&lt;plugin&gt;，并包含 .claude-plugin/plugin.json。
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map(plugin => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              runtimeServers={Object.values(runtime).filter(server => server.pluginId === plugin.id)}
              onToggle={enabled => setPluginEnabled(plugin.id, enabled)}
              onUninstall={() => uninstall(plugin)}
              onUpdate={() => updatePlugin(plugin)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function PluginRow({
  plugin,
  runtimeServers,
  onToggle,
  onUninstall,
  onUpdate,
}: {
  plugin: DiscoveredPlugin
  runtimeServers: Awaited<ReturnType<typeof window.ava.mcp.listServers>>
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  onUpdate: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const title = plugin.manifest?.name ?? plugin.id

  return (
    <div className="bg-surface border border-border-subtle rounded-lg">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-text-3 cursor-pointer hover:text-text-2"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text">{title}</span>
            {plugin.manifest?.version && (
              <span className="px-1.5 py-0.5 text-[10px] text-text-3 bg-surface-2 rounded">v{plugin.manifest.version}</span>
            )}
            <span className={`px-1.5 py-0.5 text-[10px] rounded ${plugin.valid ? 'text-success bg-success/10' : 'text-error bg-error/10'}`}>
              {plugin.valid ? 'valid' : 'invalid'}
            </span>
            {plugin.warnings.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] text-warning bg-warning/10 rounded">
                {plugin.warnings.length} warning
              </span>
            )}
            <span className="px-1.5 py-0.5 text-[10px] text-text-3 bg-surface-2 rounded">
              {plugin.source.kind}
            </span>
          </div>
          <div className="text-xs text-text-3 truncate">
            {plugin.manifest?.description || plugin.rootPath}
          </div>
        </div>
        <Toggle
          value={plugin.enabled}
          disabled={!plugin.valid}
          onChange={v => onToggle(v)}
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border-subtle">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="px-2 py-1.5 bg-surface-2 rounded text-text-2">MCP: {plugin.mcpServerCount}</div>
            <div className="px-2 py-1.5 bg-surface-2 rounded text-text-2">Skills: {plugin.skillCount}</div>
            <div className="px-2 py-1.5 bg-surface-2 rounded text-text-2">Commands: {plugin.commandCount}</div>
          </div>
          <div className="text-xs text-text-3 break-all">{plugin.rootPath}</div>
          <div className="flex flex-wrap gap-2">
            {plugin.source.uri && (
              <span className="px-2 py-1 text-xs text-text-3 bg-surface-2 rounded-full break-all">
                Source: {plugin.source.uri}
              </span>
            )}
            <button
              type="button"
              onClick={onUpdate}
              disabled={!plugin.source.updateable}
              className="px-2.5 py-1 text-xs text-text bg-surface-2 rounded-full cursor-pointer hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Update
            </button>
            <button
              type="button"
              onClick={onUninstall}
              disabled={plugin.bundled}
              className="px-2.5 py-1 text-xs text-error bg-error/10 rounded-full cursor-pointer hover:bg-error/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Uninstall
            </button>
          </div>
          <PluginDetailList
            title="Permissions"
            empty="没有声明额外权限"
            items={plugin.permissions.map(item => ({ key: item, label: item, tone: 'normal' as const }))}
          />
          <PluginDetailList
            title="MCP Servers"
            empty="没有 MCP server"
            items={plugin.mcpServers.map(server => {
              const runtime = server.id ? runtimeServers.find(item => item.id === server.id) : undefined
              const details = [
                server.command ? `command: ${server.command}` : null,
                server.args?.length ? `args: ${server.args.join(' ')}` : null,
                server.cwd ? `cwd: ${server.cwd}` : null,
                server.cwdInsidePlugin === false ? 'cwd blocked: outside plugin root' : null,
                server.envKeys?.length ? `env keys: ${server.envKeys.join(', ')}` : null,
                runtime?.tools?.length ? `runtime tools: ${runtime.tools.map(tool => tool.name).join(', ')}` : null,
                runtime?.lastError ? `runtime error: ${runtime.lastError}` : null,
                server.error ? `error: ${server.error}` : null,
              ].filter((item): item is string => Boolean(item))
              return {
                key: server.name,
                label: `${server.name} · ${server.type} · ${server.status}${runtime?.status ? ` · runtime ${runtime.status}` : ''}`,
                detail: details.join('\n'),
                tone: (server.status === 'loaded' && runtime?.status !== 'error' && server.cwdInsidePlugin !== false) ? 'normal' as const : 'warning' as const,
              }
            })}
          />
          <PluginDetailList
            title="Skills"
            empty="没有 skills"
            items={plugin.skills.map(skill => ({
              key: skill.sourcePath,
              label: `${skill.name} · ${skill.status}`,
              detail: skill.sourcePath,
              tone: skill.status === 'loaded' ? 'normal' as const : 'warning' as const,
            }))}
          />
          <PluginDetailList
            title="Commands"
            empty="没有 commands"
            items={plugin.commands.map(command => ({
              key: command.sourcePath,
              label: `${command.name} · ${command.status}`,
              detail: command.sourcePath,
              tone: command.status === 'loaded' ? 'normal' as const : 'warning' as const,
            }))}
          />
          {plugin.errors.length > 0 && (
            <div className="space-y-1">
              {plugin.errors.map(err => (
                <div key={err} className="text-xs text-error">{err}</div>
              ))}
            </div>
          )}
          {plugin.warnings.length > 0 && (
            <div className="space-y-1">
              {plugin.warnings.map(warning => (
                <div key={warning} className="text-xs text-warning">{warning}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PluginDetailList({
  title,
  empty,
  items,
}: {
  title: string
  empty: string
  items: Array<{ key: string; label: string; detail?: string; tone: 'normal' | 'warning' }>
}) {
  return (
    <div>
      <div className="text-xs text-text-3 mb-1">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-text-3">{empty}</div>
      ) : (
        <div className="space-y-1">
          {items.map(item => (
            <div key={item.key} className="px-2 py-1.5 text-xs bg-surface-2 rounded">
              <div className={item.tone === 'warning' ? 'text-warning' : 'text-text-2'}>{item.label}</div>
              {item.detail && <div className="text-text-3 break-all whitespace-pre-wrap">{item.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
