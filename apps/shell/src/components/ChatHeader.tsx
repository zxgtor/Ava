import { MessageSquarePlus, Settings, Trash2, FolderOpen } from 'lucide-react'
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
  const folderPath = activeConversation?.folderPath
  const folderName = folderPath ? folderPath.split(/[\\/]/).pop() : null

  const handleOpenFolder = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (folderPath) {
      window.ava.shell.openPath(folderPath)
    }
  }

  return (
    <div 
      className="flex items-center justify-between h-12 px-3 border-b border-border-subtle bg-surface/20 backdrop-blur-xl pr-32 select-none"
      style={{ webkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-3 min-w-0" style={{ webkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={onToggleSidebar}
          className="flex items-center gap-3 px-2 py-1 -ml-1 rounded-lg transition-all hover:bg-white/5 active:scale-95 group cursor-pointer"
          title={sidebarOpen ? '隐藏对话列表' : '显示对话列表'}
        >
          <Logo size={22} className="transition-transform group-hover:scale-110" />
          <div className="flex items-center gap-1.5">
            <span className="text-[15px] font-light text-white/90 tracking-[0.15em]">Ava</span>
            <span className="w-1 h-1 rounded-full bg-accent shadow-[0_0_8px_rgba(59,130,246,0.8)] animate-pulse" />
          </div>
        </button>

        {folderPath && (
          <div className="h-4 w-[1px] bg-white/10 mx-1" />
        )}

        {folderPath && (
          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all group max-w-[200px]"
            title={folderPath}
          >
            <FolderOpen size={13} className="text-accent opacity-70 group-hover:opacity-100" />
            <span className="text-[11px] text-text-2 truncate group-hover:text-white">
              {folderName}
            </span>
          </button>
        )}
      </div>

      <div className="flex-1" style={{ webkitAppRegion: 'drag' } as any} />

      <div className="flex items-center gap-1" style={{ webkitAppRegion: 'no-drag' } as any}>
        {/* Empty area to keep layout balance if needed, or just clean space */}
      </div>
    </div>
  )
}
