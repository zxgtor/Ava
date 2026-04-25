import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, ArrowUp, ArrowDown, X, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import {
  mergeMcpServers,
  mergeModelProviders,
  normalizeProviderChain,
} from '../lib/llm/providers'
import type { DiscoveredPlugin, McpServerConfig, ModelProvider, Settings } from '../types'

export function SettingsView() {
  const { state, dispatch } = useStore()

  const update = useCallback(
    (producer: (draft: Settings) => Settings) => {
      const next = producer(structuredClone(state.settings))
      // Re-sanitize providers + chain
      next.modelProviders = mergeModelProviders(next.modelProviders)
      next.primaryModelChain = normalizeProviderChain(next.primaryModelChain, next.modelProviders)
      next.mcpServers = mergeMcpServers(next.mcpServers)
      next.pluginStates = next.pluginStates ?? {}
      dispatch({ type: 'UPDATE_SETTINGS', settings: next })
    },
    [dispatch, state.settings],
  )

  const close = useCallback(() => {
    dispatch({ type: 'SET_VIEW', view: 'chat' })
  }, [dispatch])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center h-11 px-4 border-b border-border-subtle bg-bg/60 backdrop-blur">
        <button
          type="button"
          onClick={close}
          className="flex items-center gap-1.5 text-sm text-text-2 cursor-pointer hover:text-text transition-colors"
        >
          <ArrowLeft size={16} />
          返回
        </button>
        <div className="flex-1 text-center text-sm text-text">设置</div>
        <div className="w-16" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 space-y-8">
        <PersonaSection settings={state.settings} update={update} />
        <ChainSection settings={state.settings} update={update} />
        <ProvidersSection settings={state.settings} update={update} />
        <McpSection settings={state.settings} update={update} />
        <PluginsSection settings={state.settings} update={update} />
      </div>
    </div>
  )
}

// ── Persona ─────────────────────────────────────────────────────────

function PersonaSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">用户 / 助手</h2>
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label="你的名字"
          value={settings.persona.userName}
          onChange={v => update(s => ({ ...s, persona: { ...s.persona, userName: v } }))}
        />
        <LabeledInput
          label="助手名字"
          value={settings.persona.assistantName}
          onChange={v => update(s => ({ ...s, persona: { ...s.persona, assistantName: v } }))}
        />
      </div>
    </section>
  )
}

// ── Chain ───────────────────────────────────────────────────────────

function ChainSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const chainWithInfo = useMemo(
    () => settings.primaryModelChain.map(id => ({
      id,
      provider: settings.modelProviders.find(p => p.id === id),
    })),
    [settings.modelProviders, settings.primaryModelChain],
  )

  const enabledButUnranked = useMemo(
    () => settings.modelProviders.filter(
      p => p.enabled && !settings.primaryModelChain.includes(p.id),
    ),
    [settings.modelProviders, settings.primaryModelChain],
  )

  const move = (idx: number, dir: -1 | 1) =>
    update(s => {
      const next = [...s.primaryModelChain]
      const target = idx + dir
      if (target < 0 || target >= next.length) return s
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return { ...s, primaryModelChain: next }
    })

  const remove = (id: string) =>
    update(s => ({ ...s, primaryModelChain: s.primaryModelChain.filter(p => p !== id) }))

  const add = (id: string) =>
    update(s => ({ ...s, primaryModelChain: [...s.primaryModelChain, id] }))

  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">主回退链</h2>
      <p className="text-xs text-text-3 mb-3">按顺序尝试；上面失败才用下面。</p>
      <div className="space-y-2">
        {chainWithInfo.map(({ id, provider }, idx) => (
          <div key={id} className="flex items-center gap-2 px-3 py-2 bg-surface border border-border-subtle rounded-lg">
            <div className="flex-shrink-0 w-6 text-center text-text-3 text-xs">{idx + 1}</div>
            <div className="flex-1">
              <div className="text-sm text-text">{provider?.name ?? id}</div>
              <div className="text-xs text-text-3">
                {provider?.enabled ? provider.defaultModel : '❗ 未启用'}
              </div>
            </div>
            <button
              type="button"
              disabled={idx === 0}
              onClick={() => move(idx, -1)}
              className="p-1 text-text-2 rounded cursor-pointer hover:text-text hover:bg-surface-2 disabled:opacity-30 disabled:cursor-not-allowed"
            ><ArrowUp size={14} /></button>
            <button
              type="button"
              disabled={idx === chainWithInfo.length - 1}
              onClick={() => move(idx, 1)}
              className="p-1 text-text-2 rounded cursor-pointer hover:text-text hover:bg-surface-2 disabled:opacity-30 disabled:cursor-not-allowed"
            ><ArrowDown size={14} /></button>
            <button
              type="button"
              onClick={() => remove(id)}
              className="p-1 text-text-2 rounded cursor-pointer hover:text-error hover:bg-error/10"
              title="从链中移除"
            ><X size={14} /></button>
          </div>
        ))}

        {enabledButUnranked.length > 0 && (
          <div className="pt-2 flex flex-wrap gap-2">
            <span className="text-xs text-text-3 py-1">可添加：</span>
            {enabledButUnranked.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => add(p.id)}
                className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20"
              >+ {p.name}</button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ── Providers ───────────────────────────────────────────────────────

function ProvidersSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">供应商</h2>
      <div className="space-y-2">
        {settings.modelProviders.map(provider => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onChange={next => update(s => ({
              ...s,
              modelProviders: s.modelProviders.map(p => p.id === provider.id ? next : p),
            }))}
          />
        ))}
      </div>
    </section>
  )
}

function McpSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const [runtime, setRuntime] = useState<Record<string, Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]>>({})

  useEffect(() => {
    window.ava.mcp.listServers()
      .then(list => setRuntime(Object.fromEntries(list.map(item => [item.id, item]))))
      .catch(() => { /* noop */ })
    const off = window.ava.mcp.onStatus(server => {
      setRuntime(prev => ({ ...prev, [server.id]: server }))
    })
    return off
  }, [])

  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">MCP Servers</h2>
      <div className="space-y-2">
        {settings.mcpServers.map(server => (
          <McpServerRow
            key={server.id}
            server={server}
            runtime={runtime[server.id]}
            onChange={next => update(s => ({
              ...s,
              mcpServers: s.mcpServers.map(item => (item.id === server.id ? next : item)),
            }))}
          />
        ))}
      </div>
    </section>
  )
}

function PluginsSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
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
              return {
                key: server.name,
                label: `${server.name} · ${server.type} · ${server.status}${runtime?.status ? ` · runtime ${runtime.status}` : ''}${server.command ? ` · ${server.command} ${(server.args ?? []).join(' ')}` : ''}`,
                detail: runtime?.lastError ?? server.cwd ?? server.error,
                tone: (server.status === 'loaded' && runtime?.status !== 'error') ? 'normal' as const : 'warning' as const,
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
              {item.detail && <div className="text-text-3 break-all">{item.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function McpServerRow({
  server,
  runtime,
  onChange,
}: {
  server: McpServerConfig
  runtime?: Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]
  onChange: (next: McpServerConfig) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const addDirectory = async () => {
    const dir = await window.ava.dialog.pickDirectory()
    if (!dir) return
    const current = new Set(server.allowedDirs ?? [])
    current.add(dir)
    onChange({ ...server, allowedDirs: Array.from(current) })
  }

  const removeDirectory = (dir: string) => {
    onChange({
      ...server,
      allowedDirs: (server.allowedDirs ?? []).filter(item => item !== dir),
    })
  }

  const restart = async () => {
    setRestarting(true)
    try {
      await window.ava.mcp.restart(server.id)
    } finally {
      setRestarting(false)
    }
  }

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
            <span className="text-sm text-text">{server.name}</span>
            {runtime?.status && (
              <span className="px-1.5 py-0.5 text-[10px] text-text-3 bg-surface-2 rounded">
                {runtime.status}
              </span>
            )}
          </div>
          <div className="text-xs text-text-3 truncate">{server.command} {(server.args ?? []).join(' ')}</div>
        </div>
        <Toggle
          value={server.enabled}
          onChange={v => onChange({ ...server, enabled: v })}
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border-subtle">
          <div>
            <div className="text-xs text-text-3 mb-1">允许目录</div>
            <div className="flex flex-wrap gap-2">
              {(server.allowedDirs ?? []).map(dir => (
                <span key={dir} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-surface-2 rounded-full text-text-2">
                  <span className="max-w-[24rem] truncate" title={dir}>{dir}</span>
                  <button
                    type="button"
                    onClick={() => removeDirectory(dir)}
                    className="cursor-pointer text-text-3 hover:text-error"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {(server.allowedDirs ?? []).length === 0 && (
                <span className="text-xs text-text-3">还没有白名单目录</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addDirectory}
              className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20"
            >
              + Add directory
            </button>
            <button
              type="button"
              onClick={restart}
              disabled={restarting}
              className="px-2.5 py-1 text-xs text-text bg-surface-2 rounded-full cursor-pointer hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {restarting ? '重启中…' : 'Restart'}
            </button>
            <span className="text-xs text-text-3">
              {runtime?.status === 'running'
                ? `运行中 · ${(runtime.tools ?? []).length} 个工具`
                : runtime?.lastError ?? '未运行'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function ProviderRow({ provider, onChange }: { provider: ModelProvider; onChange: (p: ModelProvider) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<string | null>(null)

  const probe = async () => {
    setProbing(true)
    setProbeResult(null)
    try {
      const result = await window.ava.llm.probe({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        providerId: provider.id,
      })
      if (result.ok) {
        if (result.models.length > 0) {
          onChange({ ...provider, models: result.models })
          setProbeResult(`✓ 发现 ${result.models.length} 个模型`)
        } else {
          setProbeResult('✓ 连通，但没返回模型列表')
        }
      } else {
        setProbeResult(`✗ ${result.error}`)
      }
    } finally {
      setProbing(false)
    }
  }

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
            <span className="text-sm text-text">{provider.name}</span>
            <span className="px-1.5 py-0.5 text-[10px] text-text-3 bg-surface-2 rounded">{provider.type}</span>
          </div>
          <div className="text-xs text-text-3 truncate">{provider.baseUrl || '（未设置 baseUrl）'}</div>
        </div>
        <Toggle
          value={provider.enabled}
          onChange={v => onChange({ ...provider, enabled: v })}
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border-subtle">
          <LabeledInput
            label="Base URL"
            value={provider.baseUrl}
            onChange={v => onChange({ ...provider, baseUrl: v })}
            placeholder="http://127.0.0.1:1234"
          />
          <LabeledInput
            label="API Key"
            value={provider.apiKey}
            onChange={v => onChange({ ...provider, apiKey: v })}
            type="password"
            placeholder={provider.type === 'local' ? '本地一般不需要' : 'sk-...'}
          />
          <LabeledInput
            label="默认模型"
            value={provider.defaultModel}
            onChange={v => onChange({ ...provider, defaultModel: v })}
            list={provider.models}
          />
          {(provider.models.length > 0 || provider.defaultModel) && (
            <ModelChips
              models={provider.models}
              value={provider.defaultModel}
              onPick={v => onChange({ ...provider, defaultModel: v })}
            />
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={probe}
              disabled={!provider.baseUrl || probing}
              className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {probing ? '探测中…' : '探测连通性'}
            </button>
            {probeResult && (
              <span className={`text-xs ${probeResult.startsWith('✓') ? 'text-success' : 'text-error'}`}>
                {probeResult}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ModelChips({
  models, value, onPick,
}: { models: string[]; value: string; onPick: (v: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const THRESHOLD = 16
  // If the current defaultModel isn't in the discovered catalog (e.g. a custom
  // alias, or a half-typed string), show it as a virtual leading chip so user
  // still sees which one is active. This does NOT persist to `provider.models`.
  const displayModels = useMemo(
    () => (value && !models.includes(value) ? [value, ...models] : models),
    [models, value],
  )
  const shown = expanded ? displayModels : displayModels.slice(0, THRESHOLD)
  const rest = displayModels.length - shown.length

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
        {shown.map(m => {
          const active = m === value
          return (
            <button
              key={m}
              type="button"
              onClick={() => onPick(m)}
              className={`px-2 py-0.5 text-xs rounded-full cursor-pointer transition-colors border ${
                active
                  ? 'text-accent bg-accent/15 border-accent/40'
                  : 'text-text-2 bg-surface-2 border-border-subtle hover:text-text hover:bg-surface-3'
              }`}
              title={m}
            >
              {m}
            </button>
          )
        })}
        {rest > 0 && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-2 py-0.5 text-xs rounded-full cursor-pointer text-text-3 bg-surface-2 border border-border-subtle hover:text-text-2"
          >
            还有 {rest} 个…
          </button>
        )}
        {expanded && models.length > THRESHOLD && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="px-2 py-0.5 text-xs rounded-full cursor-pointer text-text-3 bg-surface-2 border border-border-subtle hover:text-text-2"
          >
            收起
          </button>
        )}
      </div>
    </div>
  )
}

// ── Shared inputs ───────────────────────────────────────────────────

function LabeledInput({
  label, value, onChange, placeholder, type, list,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  list?: string[]
}) {
  const id = `inp-${label.replace(/\s+/g, '-')}`
  const listId = list && list.length > 0 ? `${id}-list` : undefined
  return (
    <label className="block">
      <span className="block text-xs text-text-3 mb-1">{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        list={listId}
        className="w-full px-3 py-1.5 text-sm text-text bg-bg border border-border-subtle rounded-md outline-none focus:border-accent/60"
      />
      {listId && (
        <datalist id={listId}>
          {list!.map(m => <option key={m} value={m} />)}
        </datalist>
      )}
    </label>
  )
}

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors cursor-pointer ${
        value ? 'bg-accent' : 'bg-surface-3'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
      aria-pressed={value}
    >
      <span
        className={`inline-block w-4 h-4 rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
