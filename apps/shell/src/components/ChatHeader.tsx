import { FolderOpen, Terminal, Code, LayoutPanelLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SyntaxBrand } from './Logo'
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
      className="flex items-center h-9 px-2.5 border-b border-border-subtle bg-surface/20 backdrop-blur-xl select-none relative"
      style={{ webkitAppRegion: 'drag' } as any}
    >
      {/* 左侧：Logo + 项目信息 */}
      <div className="flex items-center gap-2 shrink-0" style={{ webkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={onToggleSidebar}
          className="flex items-center px-1 py-0.5 -ml-1 rounded-md transition-all hover:bg-white/5 active:scale-95 group cursor-pointer"
        >
          <SyntaxBrand className="scale-[0.78] origin-left" />
        </button>

        {folderPath && (
          <>
            <div className="h-3.5 w-[1px] bg-white/10 mx-0.5" />
            <div className="flex items-center gap-1">
              <button
                onClick={handleOpenFolder}
                className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-white/5 transition-all group"
                title={folderPath}
              >
                <FolderOpen size={13} className="text-accent opacity-70 group-hover:opacity-100" />
                <span className="text-[11px] text-text-2 truncate max-w-[120px] group-hover:text-white">
                  {folderName}
                </span>
              </button>
              <div className="flex items-center gap-0.5">
                <button onClick={handleOpenTerminal} className="p-1 rounded-md hover:bg-white/5 text-text-3 hover:text-white transition-colors" title={t('chat.open_terminal', 'Open in Terminal')}>
                  <Terminal size={13} />
                </button>
                <button onClick={handleOpenCode} className="p-1 rounded-md hover:bg-white/5 text-text-3 hover:text-white transition-colors" title={t('chat.open_code', 'Open in VS Code')}>
                  <Code size={13} />
                </button>
                <button
                  onClick={onOpenPreview}
                  className="p-1 rounded-md hover:bg-white/5 text-text-3 hover:text-white transition-colors"
                  title={t('chat.open_preview', 'Open Design Preview Window')}
                >
                  <LayoutPanelLeft size={13} />
                </button>
              </div>
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
