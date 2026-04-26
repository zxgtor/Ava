import { useMemo } from 'react'
import { ArrowUp, ArrowDown, X } from 'lucide-react'
import type { Settings } from '../../types'

export function ChainSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
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
