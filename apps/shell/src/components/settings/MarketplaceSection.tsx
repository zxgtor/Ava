import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Download, ExternalLink, Loader2, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import type { AddOnSource, DiscoveredPlugin, MarketplaceCatalog, MarketplaceItem, MarketplaceItemSource, MarketplaceItemType, Settings } from '../../types'
import { SPEECH_PLUGIN_ID } from '../../lib/speechPlugin'
import { LabeledInput, Toggle } from './shared'

type MarketTab = MarketplaceItemType
const ADD_SOURCE_OPTION = '__add_source__'
const BUILT_IN_SOURCES: Array<{ id: MarketplaceItemSource; group: 'third-party'; label: string; detail: string }> = [
  { id: 'claude', group: 'third-party', label: 'Claude Official', detail: 'Official Claude Code plugin catalog' },
  { id: 'codex', group: 'third-party', label: 'Codex Catalog', detail: 'codex-marketplace.com community catalog' },
]

export function MarketplaceSection({
  settings,
  update,
  localPlugins,
  onInstall,
}: {
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
  localPlugins: DiscoveredPlugin[]
  onInstall: (url: string) => Promise<void>
  onUninstall: (id: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<MarketplaceCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<MarketTab>('plugin')
  const [query, setQuery] = useState('')
  const [enabledSources, setEnabledSources] = useState<MarketplaceItemSource[]>(['ava'])
  const [selectedCustomSourceIds, setSelectedCustomSourceIds] = useState<string[]>([])
  const [sourcePick, setSourcePick] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [sourceUrlDraft, setSourceUrlDraft] = useState('')
  const [runtime, setRuntime] = useState<Record<string, Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]>>({})
  const [expandedPluginIds, setExpandedPluginIds] = useState<Record<string, boolean>>({})

  const selectedCustomSources = useMemo(
    () => settings.addOnSources.filter(source => selectedCustomSourceIds.includes(source.id)),
    [settings.addOnSources, selectedCustomSourceIds],
  )
  const selectedBuiltInSourceIds = useMemo(
    () => enabledSources.filter((source): source is 'claude' | 'codex' => source === 'claude' || source === 'codex'),
    [enabledSources],
  )
  const hasSelectedExternalSources = selectedBuiltInSourceIds.length > 0 || selectedCustomSources.length > 0
  const requestSources = useMemo<MarketplaceItemSource[]>(
    () => {
      const sources: MarketplaceItemSource[] = hasSelectedExternalSources ? [...selectedBuiltInSourceIds] : ['ava']
      return selectedCustomSources.length > 0
        ? [...sources, 'custom']
        : sources
    },
    [hasSelectedExternalSources, selectedBuiltInSourceIds, selectedCustomSources.length],
  )

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.ava.plugins.getMarketplaceCatalog(settings.pluginStates, {
        sources: requestSources,
        customSources: selectedCustomSources.map(source => ({ ...source, enabled: true })),
      }) as MarketplaceCatalog
      setCatalog(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.pluginStates, requestSources, selectedCustomSources])

  useEffect(() => {
    window.ava.mcp.listServers()
      .then(list => setRuntime(Object.fromEntries(list.map(item => [item.id, item]))))
      .catch(() => { /* noop */ })
    const off = window.ava.mcp.onStatus(server => {
      setRuntime(prev => ({ ...prev, [server.id]: server }))
    })
    return off
  }, [])

  const selectThirdPartySource = (value: string) => {
    if (!value) return
    if (value === ADD_SOURCE_OPTION) {
      setAddingSource(true)
      setSourcePick('')
      return
    }
    if (value === 'claude' || value === 'codex') {
      setEnabledSources(prev => prev.includes(value) ? prev : [...prev, value])
    } else if (value.startsWith('custom:')) {
      const id = value.slice('custom:'.length)
      setSelectedCustomSourceIds(prev => prev.includes(id) ? prev : [...prev, id])
    }
    setSourcePick('')
  }

  const removeThirdPartySource = (value: string) => {
    if (value === 'claude' || value === 'codex') {
      setEnabledSources(prev => prev.filter(source => source !== value))
    } else {
      setSelectedCustomSourceIds(prev => prev.filter(id => id !== value))
    }
  }

  const addCustomSource = () => {
    const url = sourceUrlDraft.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) {
      setError('Custom source must be an http(s) JSON catalog URL.')
      return
    }
    const existing = settings.addOnSources.find(source => source.url.toLowerCase() === url.toLowerCase())
    if (existing) {
      setSelectedCustomSourceIds(prev => prev.includes(existing.id) ? prev : [...prev, existing.id])
      setSourceUrlDraft('')
      setAddingSource(false)
      return
    }
    const id = `custom-${Date.now().toString(36)}`
    update(s => {
      const next: AddOnSource = {
        id,
        label: inferSourceName(url),
        url,
        enabled: true,
      }
      return { ...s, addOnSources: [...s.addOnSources, next] }
    })
    setSelectedCustomSourceIds(prev => [...prev, id])
    setSourceUrlDraft('')
    setAddingSource(false)
  }

  const items = catalog?.items ?? []
  const visibleItems = useMemo(
    () => items.filter(item => {
      if (item.installedPluginId === 'bundled-ava-core' || /^ava:(plugin|skill|mcp):bundled-ava-core\b/.test(item.id)) {
        return false
      }
      if (!hasSelectedExternalSources) {
        return item.source === 'ava'
      }
      if (item.source === 'custom') {
        return selectedCustomSources.length > 0
      }
      return selectedBuiltInSourceIds.includes(item.source as 'claude' | 'codex')
    }),
    [hasSelectedExternalSources, items, selectedBuiltInSourceIds, selectedCustomSources.length],
  )
  const counts = useMemo(() => ({
    plugin: visibleItems.filter(item => item.type === 'plugin').length,
    skill: visibleItems.filter(item => item.type === 'skill').length,
    mcp: visibleItems.filter(item => item.type === 'mcp').length,
  }), [visibleItems])
  const selectedBuiltInThirdPartySources = BUILT_IN_SOURCES.filter(
    source => (source.id === 'claude' || source.id === 'codex') && selectedBuiltInSourceIds.includes(source.id),
  )
  const thirdPartyOptions = BUILT_IN_SOURCES
    .filter(source => source.group === 'third-party' && !enabledSources.includes(source.id))
    .map(source => ({ value: source.id, label: source.label }))
  const customOptions = settings.addOnSources
    .filter(source => !selectedCustomSourceIds.includes(source.id))
    .map(source => ({ value: `custom:${source.id}`, label: source.label }))

  const categories = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = visibleItems.filter(item => {
      if (item.type !== tab) return false
      if (!q) return true
      return `${item.name} ${item.description} ${item.author} ${item.category} ${item.sourceBadges.join(' ')}`.toLowerCase().includes(q)
    })
    const grouped = new Map<string, MarketplaceItem[]>()
    for (const item of filtered) {
      const key = titleCase(item.category || 'uncategorized')
      grouped.set(key, [...(grouped.get(key) ?? []), item])
    }
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, list]) => [category, list.sort((a, b) => scoreItem(b) - scoreItem(a) || a.name.localeCompare(b.name))] as const)
  }, [visibleItems, query, tab])

  const setPluginEnabled = (pluginId: string, enabled: boolean) => {
    const plugin = localPlugins.find(item => item.id === pluginId)
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

  const install = async (item: MarketplaceItem) => {
    if (!item.installUrl || item.installKind !== 'git') return
    setLoadingId(item.id)
    setError(null)
    try {
      await window.ava.plugins.installGit(item.installUrl)
      await onInstall(item.installUrl)
      await refresh()
    } catch (e) {
      setError(`${t('settings.marketplace_install_failed', 'Installation failed')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight text-text">{t('settings.marketplace_title', 'Add-ons')}</h3>
          <div className="mt-1 text-xs text-text-3">
            {t('settings.marketplace_desc', 'Add optional plugins, skills, and MCP servers from Ava local catalogs and trusted external sources.')}
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-3 py-1.5 text-xs text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="rounded-2xl border border-border-subtle bg-surface/80 p-3">
        <div className="mb-3 space-y-3">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-3">Add-on Sources</div>
            </div>
            <div className="space-y-2">
              <select
                value={sourcePick}
                onChange={e => selectThirdPartySource(e.target.value)}
                className="w-full cursor-pointer appearance-none rounded-lg border border-border-subtle bg-black/40 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:20px_20px] bg-[right_0.5rem_center] bg-no-repeat px-3 py-1.5 pr-8 text-sm text-text shadow-sm outline-none transition-all hover:border-text-3 focus:border-accent focus:ring-2 focus:ring-accent/20"
              >
                <option value="" className="bg-[#1a1b1e] text-white">Select or add add-on source...</option>
                {thirdPartyOptions.map(option => (
                  <option key={option.value} value={option.value} className="bg-[#1a1b1e] text-white">{option.label}</option>
                ))}
                {customOptions.map(option => (
                  <option key={option.value} value={option.value} className="bg-[#1a1b1e] text-white">{option.label}</option>
                ))}
                <option value={ADD_SOURCE_OPTION} className="bg-[#1a1b1e] text-white">+ Add source URL...</option>
              </select>
              <div className="flex min-h-[28px] flex-wrap items-center gap-2">
                {selectedBuiltInThirdPartySources.map(source => (
                  <SelectedSourceChip
                    key={source.id}
                    label={source.label}
                    detail={source.detail}
                    onRemove={() => removeThirdPartySource(source.id)}
                  />
                ))}
                {selectedCustomSources.map(source => (
                  <SelectedSourceChip
                    key={source.id}
                    label={source.label}
                    detail={source.url}
                    onRemove={() => removeThirdPartySource(source.id)}
                  />
                ))}
              </div>
            </div>
            {addingSource && (
              <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg/50 p-2 md:flex-row md:items-center">
                <input
                  value={sourceUrlDraft}
                  onChange={e => setSourceUrlDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addCustomSource()
                    if (e.key === 'Escape') {
                      setAddingSource(false)
                      setSourceUrlDraft('')
                    }
                  }}
                  placeholder="Paste add-on catalog URL..."
                  autoFocus
                  className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-black/40 px-3 py-1.5 text-sm text-text outline-none transition-all placeholder:text-text-3 hover:border-text-3 focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addCustomSource}
                    className="rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingSource(false)
                      setSourceUrlDraft('')
                    }}
                    className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-xs text-text-2 hover:bg-surface-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-subtle bg-bg px-3 py-2 md:flex-row md:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Search size={14} className="text-text-3" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search add-ons..."
              className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-3"
            />
          </div>
          <div className="flex flex-wrap justify-end gap-1.5 md:flex-nowrap">
            <TabButton active={tab === 'plugin'} onClick={() => setTab('plugin')}>
              Plugins <span className="text-text-3">{counts.plugin}</span>
            </TabButton>
            <TabButton active={tab === 'skill'} onClick={() => setTab('skill')}>
              Skills <span className="text-text-3">{counts.skill}</span>
            </TabButton>
            <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>
              MCP Servers <span className="text-text-3">{counts.mcp}</span>
            </TabButton>
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</div>}
      {catalog?.warnings.length ? (
        <div className="space-y-1 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2">
          {catalog.warnings.map(warning => <div key={warning} className="text-xs text-warning">{warning}</div>)}
        </div>
      ) : null}

      {loading && !catalog ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-subtle p-8 text-xs text-text-3">
          <Loader2 size={14} className="animate-spin" />
          {t('settings.marketplace_loading', 'Loading Add-ons...')}
        </div>
      ) : categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle p-8 text-center text-xs text-text-3">
          No add-ons match the current filters.
        </div>
      ) : (
        <div className="space-y-6">
          {categories.map(([category, list]) => (
            <section key={category} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_14px_rgba(90,220,170,.75)]" />
                  <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-text-2">{category}</h4>
                </div>
                <span className="text-[11px] text-text-3">{list.length} item{list.length === 1 ? '' : 's'}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {list.map(item => (
                  <MarketplaceCard
                    key={item.id}
                    item={item}
                    localPlugins={localPlugins}
                    settings={settings}
                    update={update}
                    runtimeServers={Object.values(runtime)}
                    expanded={item.installedPluginId ? Boolean(expandedPluginIds[item.installedPluginId]) : false}
                    onToggleExpanded={() => {
                      if (!item.installedPluginId) return
                      setExpandedPluginIds(prev => ({ ...prev, [item.installedPluginId!]: !prev[item.installedPluginId!] }))
                    }}
                    onTogglePlugin={setPluginEnabled}
                    loading={loadingId === item.id}
                    onInstall={() => install(item)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function MarketplaceCard({
  item,
  localPlugins,
  settings,
  update,
  runtimeServers,
  expanded,
  onToggleExpanded,
  onTogglePlugin,
  loading,
  onInstall,
}: {
  item: MarketplaceItem
  localPlugins: DiscoveredPlugin[]
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
  runtimeServers: Awaited<ReturnType<typeof window.ava.mcp.listServers>>
  expanded: boolean
  onToggleExpanded: () => void
  onTogglePlugin: (pluginId: string, enabled: boolean) => void
  loading: boolean
  onInstall: () => void
}) {
  const installed = Boolean(item.installedPluginId) || isInstalledByRepo(item, localPlugins)
  const localPlugin = item.installedPluginId
    ? localPlugins.find(plugin => plugin.id === item.installedPluginId)
    : undefined
  const manageablePlugin = item.type === 'plugin' && localPlugin && localPlugin.id !== 'bundled-ava-core'
  const canInstall = item.installKind === 'git' && Boolean(item.installUrl) && !installed
  return (
    <article className="group overflow-hidden rounded-2xl border border-border-subtle bg-surface transition-colors hover:border-accent/35">
      <div className={`relative h-14 ${thumbnailClass(item)}`}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,.22),transparent_28%)]" />
        <div className="absolute left-3 right-24 top-1/2 -translate-y-1/2">
          <div className="truncate text-sm font-semibold text-white">{item.name}</div>
          <div className="truncate text-[11px] text-white/65">{item.author}</div>
        </div>
        {manageablePlugin && (
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <button
              type="button"
              onClick={onToggleExpanded}
              className="rounded-md bg-black/20 p-1 text-white/80 backdrop-blur hover:bg-black/35 hover:text-white"
              title={expanded ? 'Collapse plugin details' : 'Expand plugin details'}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <Toggle
              value={localPlugin.enabled}
              disabled={!localPlugin.valid}
              onChange={v => onTogglePlugin(localPlugin.id, v)}
            />
          </div>
        )}
        {!manageablePlugin && (
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <ActionButton installed={installed} canInstall={canInstall} loading={loading} note={item.installNote} onInstall={onInstall} />
          </div>
        )}
      </div>
      <div className="space-y-3 p-3">
        <p className="line-clamp-3 min-h-[48px] text-xs leading-relaxed text-text-2">{item.description}</p>
        <div className="flex flex-wrap gap-1.5">
          {item.sourceBadges.map(badge => <Badge key={badge}>{badge}</Badge>)}
          <Badge>{item.type}</Badge>
          {item.parentPluginName && <Badge>{item.parentPluginName}</Badge>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
          <span className="truncate text-[11px] text-text-3">{item.sourceLabel}</span>
          {item.sourceUrl && (
            <button
              type="button"
              onClick={() => window.open(item.sourceUrl, '_blank')}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-accent"
            >
              Source <ExternalLink size={11} />
            </button>
          )}
        </div>
        {manageablePlugin && expanded && (
          <PluginDetails
            plugin={localPlugin}
            settings={settings}
            update={update}
            runtimeServers={runtimeServers.filter(server => server.pluginId === localPlugin.id)}
          />
        )}
      </div>
    </article>
  )
}

function PluginDetails({
  plugin,
  settings,
  update,
  runtimeServers,
}: {
  plugin: DiscoveredPlugin
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
  runtimeServers: Awaited<ReturnType<typeof window.ava.mcp.listServers>>
}) {
  return (
    <div className="space-y-2 border-t border-border-subtle pt-3">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded bg-surface-2 px-2 py-1.5 text-text-2">MCP: {plugin.mcpServerCount}</div>
        <div className="rounded bg-surface-2 px-2 py-1.5 text-text-2">Skills: {plugin.skillCount}</div>
        <div className="rounded bg-surface-2 px-2 py-1.5 text-text-2">Commands: {plugin.commandCount}</div>
      </div>
      {plugin.id === SPEECH_PLUGIN_ID && (
        <SpeechPluginSettings settings={settings} update={update} disabled={!plugin.enabled} />
      )}
      <div className="text-xs text-text-3 break-all">{plugin.rootPath}</div>
      {plugin.source.uri && (
        <div className="text-xs text-text-3 break-all">Source: {plugin.source.uri}</div>
      )}
      <PluginDetailList
        title="Permissions"
        empty="No extra permissions declared."
        items={plugin.permissions.map(item => ({ key: item, label: item, tone: 'normal' as const }))}
      />
      <PluginDetailList
        title="MCP Servers"
        empty="No MCP servers."
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
        empty="No skills."
        items={plugin.skills.map(skill => ({
          key: skill.sourcePath,
          label: `${skill.name} · ${skill.status}`,
          detail: skill.sourcePath,
          tone: skill.status === 'loaded' ? 'normal' as const : 'warning' as const,
        }))}
      />
      <PluginDetailList
        title="Commands"
        empty="No commands."
        items={plugin.commands.map(command => ({
          key: command.sourcePath,
          label: `${command.name} · ${command.status}`,
          detail: command.sourcePath,
          tone: command.status === 'loaded' ? 'normal' as const : 'warning' as const,
        }))}
      />
      {plugin.errors.map(err => <div key={err} className="text-xs text-error">{err}</div>)}
      {plugin.warnings.map(warning => <div key={warning} className="text-xs text-warning">{warning}</div>)}
    </div>
  )
}

function SpeechPluginSettings({
  settings,
  update,
  disabled,
}: {
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
  disabled: boolean
}) {
  const { voice } = settings
  return (
    <div className={`space-y-3 rounded-lg border border-border-subtle bg-bg/60 p-3 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-text">Speech runtime config</div>
          <div className="text-xs text-text-3">One plugin exposes separate speech.stt and speech.tts capabilities.</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-2">
          <span>Chat controls</span>
          <Toggle
            value={voice.enabled}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, enabled: v } }))}
          />
        </div>
      </div>
      <div className={`space-y-3 ${voice.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label="STT Server URL (WebSocket)"
            value={voice.sttServerUrl}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, sttServerUrl: v } }))}
            placeholder="ws://127.0.0.1:8000/ws"
          />
          <LabeledInput
            label="TTS Server URL (HTTP)"
            value={voice.ttsServerUrl}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, ttsServerUrl: v } }))}
            placeholder="http://127.0.0.1:8002/tts"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label="Default Voice ID"
            value={voice.voiceId}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, voiceId: v } }))}
            placeholder="e.g. Chinese Female"
          />
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-2 px-3 py-2">
            <span className="text-xs text-text-2">Auto-read replies</span>
            <Toggle
              value={voice.autoRead}
              onChange={v => update(s => ({ ...s, voice: { ...s.voice, autoRead: v } }))}
            />
          </div>
        </div>
      </div>
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
      <div className="mb-1 text-xs text-text-3">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-text-3">{empty}</div>
      ) : (
        <div className="space-y-1">
          {items.map(item => (
            <div key={item.key} className="rounded bg-surface-2 px-2 py-1.5 text-xs">
              <div className={item.tone === 'warning' ? 'text-warning' : 'text-text-2'}>{item.label}</div>
              {item.detail && <div className="break-all whitespace-pre-wrap text-text-3">{item.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SelectedSourceChip({
  label,
  detail,
  onRemove,
}: {
  label: string
  detail: string
  onRemove: () => void
}) {
  return (
    <div className="flex max-w-full items-center gap-2 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-text">{label}</div>
        <div className="truncate text-[11px] text-text-3">{detail}</div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-md p-1 text-text-3 hover:bg-error/10 hover:text-error"
        title="Remove source"
      >
        <X size={13} />
      </button>
    </div>
  )
}

function ActionButton({
  installed,
  canInstall,
  loading,
  note,
  onInstall,
}: {
  installed: boolean
  canInstall: boolean
  loading: boolean
  note?: string
  onInstall: () => void
}) {
  if (installed) {
    return <span className="rounded-full bg-success/10 px-2 py-1 text-[11px] text-success">Installed</span>
  }
  return (
    <button
      type="button"
      onClick={onInstall}
      disabled={!canInstall || loading}
      title={canInstall ? 'Install' : note ?? 'Not directly installable yet'}
      className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {loading ? <Loader2 size={12} className="animate-spin" /> : canInstall ? <Download size={12} /> : <Sparkles size={12} />}
      {canInstall ? 'Install' : 'Listed'}
    </button>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs transition-colors ${active ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-text-3 hover:text-text'}`}
    >
      {children}
    </button>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-3">{children}</span>
}

function scoreItem(item: MarketplaceItem): number {
  return (item.installedPluginId ? 10 : 0) + (item.source === 'ava' ? 4 : 0) + (item.source === 'claude' ? 2 : 0)
}

function isInstalledByRepo(item: MarketplaceItem, localPlugins: DiscoveredPlugin[]): boolean {
  const repo = normalizeRepo(item.repoUrl ?? item.installUrl ?? '')
  if (!repo) return false
  return localPlugins.some(plugin => normalizeRepo(plugin.source.uri ?? '') === repo)
}

function normalizeRepo(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '')
}

function inferSourceName(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, '')
    const pathName = parsed.pathname
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.(json|txt)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    const base = pathName && !/^ava add?ons?$/i.test(pathName) ? `${host} ${pathName}` : host
    return titleCase(base)
  } catch {
    return url
  }
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function thumbnailClass(item: MarketplaceItem): string {
  const seed = hash(`${item.source}:${item.category}:${item.name}`) % 5
  const classes = [
    'bg-[linear-gradient(135deg,rgba(74,222,128,.42),rgba(34,42,65,.9))]',
    'bg-[linear-gradient(135deg,rgba(96,165,250,.46),rgba(39,30,70,.9))]',
    'bg-[linear-gradient(135deg,rgba(251,191,36,.45),rgba(80,50,30,.9))]',
    'bg-[linear-gradient(135deg,rgba(244,114,182,.42),rgba(50,34,70,.9))]',
    'bg-[linear-gradient(135deg,rgba(45,212,191,.38),rgba(25,40,55,.9))]',
  ]
  return classes[seed]
}

function hash(value: string): number {
  let out = 0
  for (let i = 0; i < value.length; i += 1) out = (out * 31 + value.charCodeAt(i)) >>> 0
  return out
}
