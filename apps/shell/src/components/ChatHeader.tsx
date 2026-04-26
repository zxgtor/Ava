import { MessageSquarePlus, Settings, Trash2 } from 'lucide-react'
import { Logo } from './Logo'
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
      className="flex items-center justify-between h-12 px-3 border-b border-border-subtle bg-surface/20 backdrop-blur-xl pr-32 select-none"
      style={{ webkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-3 min-w-0" style={{ webkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={onToggleSidebar}
          className="flex items-center gap-2 px-2 py-1 -ml-1 rounded-lg transition-all hover:bg-white/5 active:scale-95 group cursor-pointer"
          title={sidebarOpen ? '隐藏对话列表' : '显示对话列表'}
        >
          <Logo size={20} className="transition-transform group-hover:scale-110" />
          <span className="text-sm font-bold text-text tracking-widest uppercase opacity-80 group-hover:opacity-100">Ava</span>
        </button>
      </div>

      <div className="flex-1" style={{ webkitAppRegion: 'drag' } as any} />

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
      </div>
    </div>
  )
}
