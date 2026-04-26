import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ModelProvider, Settings } from '../../types'
import { LabeledInput, ModelChips, Toggle } from './shared'

export function ProvidersSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
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
