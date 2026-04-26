import { useEffect, useState } from 'react'
import { Download, Loader2, Monitor, Database, Box, Trash2 } from 'lucide-react'
import type { DiscoveredPlugin, Settings } from '../../types'

interface MarketplaceItem {
  id: string
  name: string
  description: string
  author: string
  repoUrl: string
  icon: string
}

const ICONS: Record<string, any> = {
  Monitor,
  Database,
  Box
}

export function MarketplaceSection({
  settings,
  localPlugins,
  onInstall,
  onUninstall
}: {
  settings: Settings
  localPlugins: DiscoveredPlugin[]
  onInstall: (url: string) => Promise<void>
  onUninstall: (id: string) => Promise<void>
}) {
  const [items, setItems] = useState<MarketplaceItem[]>([])
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.ava.plugins.getMarketplaceCatalog()
      .then(setItems)
      .catch(e => setError(e.message))
  }, [])

  const handleInstall = async (item: MarketplaceItem) => {
    setLoadingId(item.id)
    setError(null)
    try {
      await window.ava.plugins.installGit(item.repoUrl)
      await onInstall(item.repoUrl) // Trigger a reload
    } catch (e: any) {
      setError(`安装失败: ${e.message}`)
    } finally {
      setLoadingId(null)
    }
  }

  const handleUninstall = async (pluginId: string, itemId: string) => {
    setLoadingId(itemId)
    setError(null)
    try {
      await window.ava.plugins.uninstall(pluginId)
      await onUninstall(pluginId) // Trigger a reload
    } catch (e: any) {
      setError(`卸载失败: ${e.message}`)
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text">插件市场 (Marketplace)</h3>
      </div>
      <div className="text-xs text-text-3 mb-2">发现并安装社区提供的强大插件与 MCP Server。</div>
      
      {error && <div className="text-xs text-error p-2 bg-error/10 rounded">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {items.map(item => {
          const Icon = ICONS[item.icon] || Box
          // In a real scenario, we'd match the downloaded plugin id to the marketplace item.
          // The git clone name might be different. Let's just check if repoUrl matches source uri, or generic heuristic.
          const installed = localPlugins.find(p => p.source.uri === item.repoUrl || p.id.includes(item.id.toLowerCase().replace(/[^a-z0-9]/g, '-')))
          
          return (
            <div key={item.id} className="flex flex-col gap-2 p-3 border border-border-subtle rounded-xl bg-surface-1">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-accent/10 text-accent rounded-lg">
                    <Icon size={16} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-text">{item.name}</div>
                    <div className="text-[10px] text-text-3">by {item.author}</div>
                  </div>
                </div>
                <div>
                  {loadingId === item.id ? (
                    <div className="p-1.5 text-text-3"><Loader2 size={16} className="animate-spin" /></div>
                  ) : installed ? (
                    <button
                      onClick={() => handleUninstall(installed.id, item.id)}
                      className="p-1.5 text-text-3 hover:text-error hover:bg-error/10 rounded-md transition-colors"
                      title="卸载"
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleInstall(item)}
                      className="p-1.5 text-accent hover:bg-accent/10 rounded-md transition-colors"
                      title="安装"
                    >
                      <Download size={16} />
                    </button>
                  )}
                </div>
              </div>
              <div className="text-xs text-text-2 mt-1 line-clamp-2">
                {item.description}
              </div>
            </div>
          )
        })}
      </div>
      {items.length === 0 && !error && (
        <div className="text-xs text-text-3 p-4 text-center border border-dashed border-border-subtle rounded-xl">
          正在加载插件市场...
        </div>
      )}
    </div>
  )
}
