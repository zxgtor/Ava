import { MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Settings, Trash2 } from 'lucide-react'
import type { Conversation } from '../types'

interface Props {
  activeConversation: Conversation | null
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewConversation: () => void
  onOpenSettings: () => void
  onDeleteConversation?: () => void
}

export function ChatHeader({
  activeConversation,
  sidebarOpen,
  onToggleSidebar,
  onNewConversation,
  onOpenSettings,
  onDeleteConversation,
}: Props) {
  const title = activeConversation?.title ?? 'Ava'

  return (
    <div 
      className="flex items-center justify-between h-11 px-2 border-b border-border-subtle bg-surface/30 backdrop-blur-xl pr-32"
      style={{ webkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-1 min-w-0" style={{ webkitAppRegion: 'no-drag' } as any}>
        <button
          type="button"
          onClick={onToggleSidebar}
          className="p-1.5 text-text-3 rounded-lg cursor-pointer hover:text-text hover:bg-surface-2 transition-colors"
          title={sidebarOpen ? '隐藏对话列表' : '显示对话列表'}
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <div className="text-sm text-text-2 truncate px-2">{title}</div>
      </div>
      <div className="flex items-center gap-1" style={{ webkitAppRegion: 'no-drag' } as any}>
        {activeConversation && onDeleteConversation && (
          <button
            type="button"
            onClick={onDeleteConversation}
            className="p-1.5 text-text-3 rounded-lg cursor-pointer hover:text-error hover:bg-error/10 transition-colors"
            title="删除当前对话"
          >
            <Trash2 size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={onNewConversation}
          className="p-1.5 text-text-2 rounded-lg cursor-pointer hover:text-text hover:bg-surface-2 transition-colors"
          title="新对话"
        >
          <MessageSquarePlus size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="p-1.5 text-text-2 rounded-lg cursor-pointer hover:text-text hover:bg-surface-2 transition-colors"
          title="设置"
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  )
}
