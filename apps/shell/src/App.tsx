import { useEffect, useState } from 'react'
import { StoreProvider, useStore } from './store'
import { ChatView } from './components/ChatView'
import { SettingsView } from './components/SettingsView'
import { ConversationSidebar } from './components/ConversationSidebar'
import { PreviewView } from './components/PreviewView'
import { ChatHeader } from './components/ChatHeader'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './lib/i18n'
import type { ContentPart } from './types'

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

function Shell() {
  const { state, dispatch, activeConversation, createConversation } = useStore()
  const { t } = useTranslation()

  const handleOpenPreview = useCallback(async () => {
    // 1. 开启/聚焦窗口
    await window.ava.window.openPreview(state.settings.theme)

    // 2. 立即尝试同步当前内容
    if (!activeConversation) return
    const messages = activeConversation.messages
    const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistantMessage) return

    const text = partsToText(lastAssistantMessage.content)
    const htmlMatch = text.match(/```(?:html|svg)\s*([\s\S]*?)\s*```/i) || 
                      text.match(/<(html|svg)[\s\S]*?<\/\1>/i) ||
                      text.match(/<svg[\s\S]*?>[\s\S]*/i)
    
    if (htmlMatch) {
      const htmlContent = htmlMatch[1] || htmlMatch[0]
      // 给窗口一点初始化时间
      setTimeout(() => {
        window.ava.window.updatePreview(htmlContent)
      }, 800)
    }
  }, [activeConversation])

  useEffect(() => {
    if (state.settings.theme) {
      document.documentElement.setAttribute('data-theme', state.settings.theme)
      window.ava.window.updateTheme(state.settings.theme)
    }
  }, [state.settings.theme])

  useEffect(() => {
    if (state.settings.language && state.settings.language !== 'auto') {
      i18n.changeLanguage(state.settings.language)
    } else {
      // If auto, we let language-detector do its job, or we could force system language
      i18n.changeLanguage(navigator.language)
    }
  }, [state.settings.language])

  if (!state.hydrated) {
    return (
      <div className="flex items-center justify-center flex-1 text-text-3 text-sm">
        {t('chat.loading', 'Loading...')}
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 h-screen overflow-hidden rounded-lg border border-border-subtle shadow-2xl relative bg-bg/20 backdrop-blur-main">
      {state.settings.theme === 'aura-glass' && (
        <div className="aura-container">
          <div className="aura-sphere aura-sphere-1" />
          <div className="aura-sphere aura-sphere-2" />
          <div className="aura-sphere aura-sphere-3" />
        </div>
      )}
      
      <ChatHeader
        activeConversation={activeConversation}
        sidebarOpen={state.sidebarOpen}
        onToggleSidebar={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        onNewConversation={createConversation}
        onOpenSettings={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
        onDeleteConversation={activeConversation ? () => dispatch({ type: 'DELETE_CONVERSATION', id: activeConversation.id }) : undefined}
        onOpenPreview={handleOpenPreview}
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
  // 识别预览模式：这种模式下不需要 Store，不需要 Sidebar，只需要渲染器
  const isPreview = window.location.search.includes('view=preview')
  const theme = new URLSearchParams(window.location.search).get('theme')

  if (isPreview) {
    const [localTheme, setLocalTheme] = useState(theme)

    useEffect(() => {
      if (localTheme) document.documentElement.setAttribute('data-theme', localTheme)
    }, [localTheme])

    useEffect(() => {
      const cleanup = window.ava.window.onThemeUpdate((newTheme) => {
        setLocalTheme(newTheme)
      })
      return cleanup
    }, [])

    return (
      <div className="flex flex-col flex-1 h-screen overflow-hidden rounded-lg border border-border-subtle shadow-2xl relative bg-bg/20 backdrop-blur-main">
        {localTheme === 'aura-glass' && (
          <div className="aura-container">
            <div className="aura-sphere aura-sphere-1" />
            <div className="aura-sphere aura-sphere-2" />
            <div className="aura-sphere aura-sphere-3" />
          </div>
        )}
        <PreviewView />
      </div>
    )
  }

  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
