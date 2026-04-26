import { useEffect } from 'react'
import { StoreProvider, useStore } from './store'
import { ChatView } from './components/ChatView'
import { SettingsView } from './components/SettingsView'
import { ConversationSidebar } from './components/ConversationSidebar'

import { ChatHeader } from './components/ChatHeader'

function Shell() {
  const { state, dispatch, activeConversation, createConversation } = useStore()

  useEffect(() => {
    if (state.settings.theme) {
      document.documentElement.setAttribute('data-theme', state.settings.theme)
    }
  }, [state.settings.theme])

  if (!state.hydrated) {
    return (
      <div className="flex items-center justify-center flex-1 text-text-3 text-sm">
        正在加载…
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 h-screen overflow-hidden rounded-xl border border-border-subtle shadow-2xl relative bg-bg/20">
      {state.settings.theme === 'aura-glass' && (
        <div className="aura-container">
          <div className="aura-sphere aura-sphere-1" />
          <div className="aura-sphere aura-sphere-2" />
          <div className="aura-sphere aura-sphere-3" />
        </div>
      )}
      
      {/* 全局统一标题栏 */}
      <ChatHeader
        activeConversation={activeConversation}
        sidebarOpen={state.sidebarOpen}
        onToggleSidebar={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        onNewConversation={createConversation}
        onOpenSettings={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
        onDeleteConversation={activeConversation ? () => dispatch({ type: 'DELETE_CONVERSATION', id: activeConversation.id }) : undefined}
      />

      <div className="flex flex-row flex-1 min-h-0 relative">
        {state.sidebarOpen && <ConversationSidebar />}
        <div className="flex flex-col flex-1 min-w-0 backdrop-blur-main">
          {state.viewMode === 'settings' ? <SettingsView /> : <ChatView />}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
