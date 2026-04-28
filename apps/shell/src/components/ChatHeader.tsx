import { MessageSquarePlus, Settings, Trash2, FolderOpen, Terminal, Code, LayoutPanelLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Logo } from './Logo'
import type { Conversation } from '../types'

interface Props {
  activeConversation: Conversation | null
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewConversation: () => void
  onOpenSettings: () => void
  onDeleteConversation?: () => void
  onOpenPreview?: () => void
}

export function ChatHeader({
  activeConversation,
  sidebarOpen,
  onToggleSidebar,
  onNewConversation,
  onOpenSettings,
  onDeleteConversation,
  onOpenPreview,
}: Props) {
  const { t } = useTranslation()
  const folderPath = activeConversation?.folderPath
  const folderName = folderPath ? folderPath.split(/[\\/]/).pop() : null

  const handleOpenFolder = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (folderPath) window.ava.shell.openPath(folderPath)
  }

  const handleOpenTerminal = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (folderPath) window.ava.shell.openInTerminal(folderPath)
  }

  const handleOpenCode = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (folderPath) window.ava.shell.openInVSCode(folderPath)
  }

  return (
    <div 
      className="flex items-center h-12 px-3 border-b border-border-subtle bg-surface/20 backdrop-blur-xl select-none relative"
      style={{ webkitAppRegion: 'drag' } as any}
    >
      {/* 左侧：Logo + 项目信息 */}
      <div className="flex items-center gap-3 shrink-0" style={{ webkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={onToggleSidebar}
          className="flex items-center gap-3 px-2 py-1 -ml-1 rounded-lg transition-all hover:bg-white/5 active:scale-95 group cursor-pointer"
        >
          <Logo size={22} className="transition-transform group-hover:scale-110" />
          <div className="flex items-center gap-1.5">
            <span className="text-[15px] font-light text-white/90 tracking-[0.15em]">Ava</span>
            <span className="w-1 h-1 rounded-full bg-accent shadow-[0_0_8px_rgba(59,130,246,0.8)] animate-pulse" />
          </div>
        </button>

        {folderPath && (
          <>
            <div className="h-4 w-[1px] bg-white/10 mx-1" />
            <div className="flex items-center gap-1">
              <button
                onClick={handleOpenFolder}
                className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all group"
                title={folderPath}
              >
                <FolderOpen size={13} className="text-accent opacity-70 group-hover:opacity-100" />
                <span className="text-[11px] text-text-2 truncate max-w-[120px] group-hover:text-white">
                  {folderName}
                </span>
              </button>
              <div className="flex items-center bg-black/20 rounded-md p-0.5 border border-white/5">
                <button onClick={handleOpenTerminal} className="p-1 rounded hover:bg-white/10 text-text-3 hover:text-white transition-colors" title={t('chat.open_terminal', 'Open in Terminal')}>
                  <Terminal size={12} />
                </button>
                <button onClick={handleOpenCode} className="p-1 rounded hover:bg-white/10 text-text-3 hover:text-white transition-colors" title={t('chat.open_code', 'Open in VS Code')}>
                  <Code size={12} />
                </button>
              </div>
              <button 
                onClick={onOpenPreview}
                className="flex items-center gap-2 px-2 py-1 rounded-md bg-accent/10 border border-accent/20 text-accent hover:bg-accent/20 transition-all group ml-1"
                title={t('chat.open_preview', 'Open Design Preview Window')}
              >
                <LayoutPanelLeft size={13} />
                <span className="text-[10px] font-medium uppercase tracking-wider">{t('chat.preview', 'Preview')}</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* 中间：拖拽区 */}
      <div className="flex-1 h-full" style={{ webkitAppRegion: 'drag' } as any} />

      {/* 右侧：占位区 (避开系统按钮) */}
      <div className="w-[140px] shrink-0 h-full pointer-events-none" />
    </div>
  )
}
