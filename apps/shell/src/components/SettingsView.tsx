import { useCallback, useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import {
  applyWorkspaceAccessToMcpServers,
  mergeMcpServers,
  mergeModelProviders,
  mergeWorkspaces,
  normalizeProviderChain,
} from '../lib/llm/providers'
import type { Settings } from '../types'

import { GeneralSettingsSection } from './settings/GeneralSettingsSection'
import { ProvidersSection } from './settings/ProvidersSection'
import { WorkspaceSection } from './settings/WorkspaceSection'
import { MarketplaceSection } from './settings/MarketplaceSection'

export function SettingsView() {
  const { state, dispatch } = useStore()
  const [localPlugins, setLocalPlugins] = useState<any[]>([])
  const settingsRef = useRef(state.settings)

  useEffect(() => {
    settingsRef.current = state.settings
  }, [state.settings])

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
      const next = producer(structuredClone(settingsRef.current))
      // Re-sanitize providers + chain
      next.modelProviders = mergeModelProviders(next.modelProviders)
      next.primaryModelChain = normalizeProviderChain(next.primaryModelChain, next.modelProviders)
      next.workspaces = mergeWorkspaces(next.workspaces)
      next.mcpServers = applyWorkspaceAccessToMcpServers(mergeMcpServers(next.mcpServers), next.workspaces)
      next.pluginStates = next.pluginStates ?? {}
      settingsRef.current = next
      dispatch({ type: 'UPDATE_SETTINGS', settings: next })
    },
    [dispatch],
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
        {(state.settingsSection === 'general' || state.settingsSection === 'persona' || state.settingsSection === 'appearance' || state.settingsSection === 'about') && (
          <GeneralSettingsSection settings={state.settings} update={update} />
        )}
        {(state.settingsSection === 'providers' || state.settingsSection === 'chain') && <ProvidersSection settings={state.settings} update={update} />}
        {state.settingsSection === 'mcp' && <WorkspaceSection settings={state.settings} update={update} />}
        {state.settingsSection === 'marketplace' && (
          <MarketplaceSection
            settings={state.settings}
            update={update}
            localPlugins={localPlugins}
            onInstall={refreshPlugins}
            onUninstall={refreshPlugins}
          />
        )}
      </div>
    </div>
  )
}
