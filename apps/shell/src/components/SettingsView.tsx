import { useCallback, useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useStore } from '../store'
import {
  mergeMcpServers,
  mergeModelProviders,
  normalizeProviderChain,
} from '../lib/llm/providers'
import type { Settings } from '../types'

import { PersonaSection } from './settings/PersonaSection'
import { ChainSection } from './settings/ChainSection'
import { ProvidersSection } from './settings/ProvidersSection'
import { McpSection } from './settings/McpSection'
import { ToolAuditSection } from './settings/ToolAuditSection'
import { PluginsSection } from './settings/PluginsSection'
import { MarketplaceSection } from './settings/MarketplaceSection'
import { VoiceSection } from './settings/VoiceSection'
import { AboutSection } from './settings/AboutSection'

export function SettingsView() {
  const { state, dispatch } = useStore()
  const [localPlugins, setLocalPlugins] = useState<any[]>([])

  const refreshPlugins = useCallback(async () => {
    try {
      const list = await window.ava.plugins.list(state.settings.pluginStates)
      setLocalPlugins(list)
    } catch (e) {
      // noop
    }
  }, [state.settings.pluginStates])

  useEffect(() => {
    refreshPlugins()
  }, [refreshPlugins])

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
        <ToolAuditSection />
        <MarketplaceSection 
          settings={state.settings} 
          localPlugins={localPlugins} 
          onInstall={refreshPlugins}
          onUninstall={refreshPlugins}
        />
        <PluginsSection settings={state.settings} update={update} />
        <VoiceSection settings={state.settings} update={update} />
        <AboutSection />
      </div>
    </div>
  )
}
