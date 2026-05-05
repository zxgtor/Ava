import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react'
import type { DiscoveredPlugin, MarketplaceCatalog, MarketplaceItem, MarketplaceItemSource, MarketplaceItemType, Settings } from '../../types'

type MarketTab = 'plugin' | 'skill'
const MARKETPLACE_SOURCES: Array<{ id: MarketplaceItemSource; label: string; detail: string }> = [
  { id: 'claude', label: 'Claude Official', detail: 'Official Claude Code plugin marketplace' },
  { id: 'codex', label: 'Codex Marketplace', detail: 'codex-marketplace.com community catalog' },
  { id: 'ava', label: 'Ava Local', detail: 'Installed local plugins and skills' },
]

export function MarketplaceSection({
  settings,
  localPlugins,
  onInstall,
}: {
  settings: Settings
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
  const [enabledSources, setEnabledSources] = useState<MarketplaceItemSource[]>(['claude', 'codex', 'ava'])

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.ava.plugins.getMarketplaceCatalog(settings.pluginStates, { sources: enabledSources }) as MarketplaceCatalog
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
  }, [settings.pluginStates, enabledSources])

  const items = catalog?.items ?? []
  const counts = useMemo(() => ({
    plugin: items.filter(item => item.type === 'plugin').length,
    skill: items.filter(item => item.type === 'skill').length,
  }), [items])

  const categories = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = items.filter(item => {
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
  }, [items, query, tab])

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
          <h3 className="text-lg font-semibold tracking-tight text-text">{t('settings.marketplace_title', 'Marketplace')}</h3>
          <div className="mt-1 text-xs text-text-3">
            {t('settings.marketplace_desc', 'Discover plugins and skills from Claude Code, Codex, and Ava local catalogs.')}
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
        <div className="mb-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-3">Marketplace Sources</div>
          <div className="grid gap-2 md:grid-cols-3">
            {MARKETPLACE_SOURCES.map(item => (
              <SourcePick
                key={item.id}
                source={item}
                active={enabledSources.includes(item.id)}
                disabled={enabledSources.length === 1 && enabledSources.includes(item.id)}
                onToggle={() => {
                  setEnabledSources(prev => {
                    if (prev.includes(item.id)) {
                      return prev.length === 1 ? prev : prev.filter(source => source !== item.id)
                    }
                    return [...prev, item.id]
                  })
                }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <TabButton active={tab === 'plugin'} onClick={() => setTab('plugin')}>
            Plugin Marketplace <span className="text-text-3">{counts.plugin}</span>
          </TabButton>
          <TabButton active={tab === 'skill'} onClick={() => setTab('skill')}>
            Skill Market <span className="text-text-3">{counts.skill}</span>
          </TabButton>
        </div>

        <div className="mt-3">
          <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-bg px-3 py-2">
            <Search size={14} className="text-text-3" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search marketplace..."
              className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-3"
            />
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
          {t('settings.marketplace_loading', 'Loading Marketplace...')}
        </div>
      ) : categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle p-8 text-center text-xs text-text-3">
          No marketplace items match the current filters.
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
  loading,
  onInstall,
}: {
  item: MarketplaceItem
  localPlugins: DiscoveredPlugin[]
  loading: boolean
  onInstall: () => void
}) {
  const installed = Boolean(item.installedPluginId) || isInstalledByRepo(item, localPlugins)
  const canInstall = item.installKind === 'git' && Boolean(item.installUrl) && !installed
  return (
    <article className="group overflow-hidden rounded-2xl border border-border-subtle bg-surface transition-colors hover:border-accent/35">
      <div className={`relative h-20 ${thumbnailClass(item)}`}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,.22),transparent_28%)]" />
        <div className="absolute bottom-2 right-3 text-2xl font-black tracking-tighter text-white/90">
          {glyph(item)}
        </div>
      </div>
      <div className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text">{item.name}</div>
            <div className="truncate text-[11px] text-text-3">{item.author}</div>
          </div>
          <ActionButton installed={installed} canInstall={canInstall} loading={loading} note={item.installNote} onInstall={onInstall} />
        </div>
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
      </div>
    </article>
  )
}

function SourcePick({
  source,
  active,
  disabled,
  onToggle,
}: {
  source: { id: MarketplaceItemSource; label: string; detail: string }
  active: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-accent/30 bg-accent/10'
          : 'border-border-subtle bg-surface-2 hover:bg-surface-3'
      } ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
      title={disabled ? 'At least one marketplace source must stay enabled.' : undefined}
    >
      <span className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border ${
        active ? 'border-accent bg-accent text-bg' : 'border-border-subtle bg-bg'
      }`}>
        {active ? '✓' : ''}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-text">{source.label}</span>
        <span className="block truncate text-[11px] text-text-3">{source.detail}</span>
      </span>
    </button>
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

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function glyph(item: MarketplaceItem): string {
  const words = item.name.split(/\s|-/).filter(Boolean)
  if (item.type === 'skill') return words[0]?.slice(0, 2).toUpperCase() || 'SK'
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return item.name.slice(0, 2).toUpperCase()
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
