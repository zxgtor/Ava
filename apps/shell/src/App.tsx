import { StoreProvider, useStore } from './store'
import { ChatView } from './components/ChatView'
import { SettingsView } from './components/SettingsView'
import { ConversationSidebar } from './components/ConversationSidebar'

function Shell() {
  const { state } = useStore()

  if (!state.hydrated) {
    return (
      <div className="flex items-center justify-center flex-1 text-text-3 text-sm">
        正在加载…
      </div>
    )
  }

  return (
    <div className="flex flex-row flex-1 min-h-0">
      {state.sidebarOpen && <ConversationSidebar />}
      <div className="flex flex-col flex-1 min-w-0">
        {state.viewMode === 'settings' ? <SettingsView /> : <ChatView />}
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
