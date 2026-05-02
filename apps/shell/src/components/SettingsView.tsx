import { useCallback, useState, useEffect } from 'react'
import { useStore } from '../store'
import {
  mergeMcpServers,
  mergeModelProviders,
  normalizeProviderChain,
} from '../lib/llm/providers'
import type { Settings } from '../types'

import { PersonaSection } from './settings/PersonaSection'
import { AppearanceSection } from './settings/AppearanceSection'
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
        {state.settingsSection === 'persona' && <PersonaSection settings={state.settings} update={update} />}
        {state.settingsSection === 'appearance' && <AppearanceSection settings={state.settings} update={update} />}
        {state.settingsSection === 'chain' && <ChainSection settings={state.settings} update={update} />}
        {state.settingsSection === 'providers' && <ProvidersSection settings={state.settings} update={update} />}
        {state.settingsSection === 'mcp' && <McpSection settings={state.settings} update={update} />}
        {state.settingsSection === 'audit' && <ToolAuditSection />}
        {state.settingsSection === 'marketplace' && (
          <MarketplaceSection
            settings={state.settings}
            localPlugins={localPlugins}
            onInstall={refreshPlugins}
            onUninstall={refreshPlugins}
          />
        )}
        {state.settingsSection === 'plugins' && <PluginsSection settings={state.settings} update={update} />}
        {state.settingsSection === 'voice' && <VoiceSection settings={state.settings} update={update} />}
        {state.settingsSection === 'about' && <AboutSection />}
      </div>
    </div>
  )
}
