import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, ChevronDown, ChevronRight, Eye, HelpCircle, Wrench } from 'lucide-react'
import type { ModelCapabilityProfile, ModelProvider, Settings } from '../../types'
import { LabeledInput, ModelChips, Toggle } from './shared'

export function ProvidersSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const { t } = useTranslation()
  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">{t('settings.llm', 'LLM Providers')}</h2>
      <div className="space-y-2">
        {settings.modelProviders.map(provider => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            capability={settings.modelCapabilityMap[`${provider.id}:${provider.defaultModel}`]}
            onChange={next => update(s => ({
              ...s,
              modelProviders: s.modelProviders.map(p => p.id === provider.id ? mergeProviderUpdate(p, next, provider) : p),
            }))}
            onCapability={profile => update(s => ({
              ...s,
              modelCapabilityMap: {
                ...s.modelCapabilityMap,
                [`${profile.providerId}:${profile.model}`]: profile,
              },
              modelToolFormatMap:
                profile.toolFormat === 'openai' || profile.toolFormat === 'hermes' || profile.toolFormat === 'none'
                  ? {
                      ...s.modelToolFormatMap,
                      [`${profile.providerId}:${profile.model}`]: profile.toolFormat,
                    }
                  : s.modelToolFormatMap,
            }))}
          />
        ))}
      </div>
    </section>
  )
}

function mergeProviderUpdate(current: ModelProvider, next: ModelProvider, base: ModelProvider): ModelProvider {
  const merged = { ...current, ...next }
  // Async probe callbacks may carry an older ProviderRow snapshot. If the user
  // changed the selected model after that snapshot, do not revert it.
  if (current.defaultModel !== base.defaultModel && next.defaultModel === base.defaultModel) {
    merged.defaultModel = current.defaultModel
  }
  return merged
}

function ProviderRow({
  provider,
  capability,
  onChange,
  onCapability,
}: {
  provider: ModelProvider
  capability?: ModelCapabilityProfile
  onChange: (p: ModelProvider) => void
  onCapability: (profile: ModelCapabilityProfile) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [probing, setProbing] = useState(false)
  const [capProbing, setCapProbing] = useState(false)
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
          setProbeResult(t('settings.discover_models', { count: result.models.length }))
        } else {
          setProbeResult(t('settings.connected_no_models', '✓ Connected, but no model list returned'))
        }
      } else {
        setProbeResult(`✗ ${result.error}`)
      }
    } finally {
      setProbing(false)
    }
  }

  const probeSeqRef = useRef(0)
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current)
  }, [])

  const probeCapabilities = async (model = provider.defaultModel) => {
    if (!provider.baseUrl || !model) return
    const seq = ++probeSeqRef.current
    setProbeResult(null)
    setCapProbing(true)
    try {
      const result = await window.ava.llm.probeModelCapabilities({
        provider: { ...provider, defaultModel: model },
        model,
      })
      if (seq !== probeSeqRef.current) return
      onCapability(result.profile)
      if (!result.ok) setProbeResult(`✗ ${result.error}`)
    } finally {
      if (seq === probeSeqRef.current) setCapProbing(false)
    }
  }

  const changeModel = (model: string) => {
    onChange({ ...provider, defaultModel: model })
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current)
    if (!provider.baseUrl || !model) return
    const known = provider.models.includes(model)
    const delay = known ? 0 : 600
    probeTimerRef.current = setTimeout(() => { void probeCapabilities(model) }, delay)
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
            <CapabilityBadges profile={capability} probing={capProbing} />
          </div>
          <div className="text-xs text-text-3 truncate">{provider.baseUrl || t('settings.no_base_url', '(no baseUrl set)')}</div>
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
            placeholder={provider.type === 'local' ? t('settings.local_api_key_placeholder') : t('settings.api_key_placeholder')}
          />
          <LabeledInput
            label={t('settings.default_model', 'Default Model')}
            value={provider.defaultModel}
            onChange={changeModel}
            list={provider.models}
          />
          <label className="block">
            <span className="block text-xs text-text-3 mb-1">Reasoning policy</span>
            <select
              value={provider.reasoningMode ?? 'auto'}
              onChange={e => onChange({
                ...provider,
                reasoningMode:
                  e.target.value === 'off' || e.target.value === 'on'
                    ? e.target.value
                    : 'auto',
              })}
              className="w-full px-3 py-1.5 text-sm text-text bg-bg border border-border-subtle rounded-md outline-none focus:border-accent/60 [&>option]:bg-surface [&>option]:text-text"
            >
              <option value="auto">Auto decide</option>
              <option value="off">Always off</option>
              <option value="on">Always on</option>
            </select>
            <span className="mt-1 block text-[11px] text-text-3">
              Auto keeps simple Q&A direct and allows reasoning for debugging, planning, refactors, reviews, and tool-heavy work.
            </span>
          </label>
          {(provider.models.length > 0 || provider.defaultModel) && (
            <ModelChips
              models={provider.models}
              value={provider.defaultModel}
              onPick={changeModel}
            />
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={probe}
              disabled={!provider.baseUrl || probing}
              className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {probing ? t('settings.probing', 'Probing...') : t('settings.probe_connectivity', 'Probe Connectivity')}
            </button>
            <button
              type="button"
              onClick={() => probeCapabilities()}
              disabled={!provider.baseUrl || !provider.defaultModel || capProbing}
              className="px-2.5 py-1 text-xs text-success bg-success/10 rounded-full cursor-pointer hover:bg-success/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {capProbing ? 'Detecting...' : 'Detect capabilities'}
            </button>
            {probeResult && (
              <span className={`text-xs ${probeResult.startsWith('✓') ? 'text-success' : 'text-error'}`}>
                {probeResult}
              </span>
            )}
          </div>
          {capability && (
            <div className="text-[11px] text-text-3">
              Capabilities checked {new Date(capability.checkedAt).toLocaleString()} via {capability.source}
              {capability.error ? `; ${capability.error}` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CapabilityBadges({ profile, probing }: { profile?: ModelCapabilityProfile; probing: boolean }) {
  const stale = profile ? Date.now() - profile.checkedAt > 7 * 24 * 60 * 60 * 1000 : false
  if (probing) {
    return <span className="text-[10px] text-warning">detecting...</span>
  }
  if (!profile) {
    return (
      <span title="Model capabilities not detected yet" className="inline-flex items-center gap-1 text-text-3">
        <HelpCircle size={12} />
      </span>
    )
  }
  return (
    <span
      title={`Vision: ${profile.vision}; Tools: ${profile.tools}; Thinking: ${profile.thinking}; Format: ${profile.toolFormat}${stale ? '; stale' : ''}`}
      className={`inline-flex items-center gap-1 text-[10px] ${stale ? 'text-warning' : 'text-text-3'}`}
    >
      <Eye size={12} className={capColor(profile.vision)} />
      <Wrench size={12} className={capColor(profile.tools)} />
      <Brain size={12} className={capColor(profile.thinking)} />
      <span className={profile.toolFormat === 'unknown' || profile.toolFormat === 'none' ? 'text-text-3' : 'text-success'}>
        {formatLabel(profile.toolFormat)}
      </span>
    </span>
  )
}

function capColor(value: ModelCapabilityProfile['vision']): string {
  if (value === 'yes') return 'text-success'
  if (value === 'no') return 'text-error'
  return 'text-text-3'
}

function formatLabel(format: ModelCapabilityProfile['toolFormat']): string {
  if (format === 'openai') return 'native'
  return format
}
