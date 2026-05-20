import { PanelRight, PanelRightClose } from 'lucide-react'
import { SyntaxBrand } from './Logo'

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewConversation: () => void
  onOpenSettings: () => void
  onDeleteConversation?: () => void
  rightPanelOpen?: boolean
  onToggleRightPanel?: () => void
}

export function ChatHeader({
  sidebarOpen,
  onToggleSidebar,
  onNewConversation,
  onOpenSettings,
  onDeleteConversation,
  rightPanelOpen,
  onToggleRightPanel,
}: Props) {
  return (
    <div
      className="flex items-center h-9 px-2.5 border-b border-border-subtle bg-surface/20 backdrop-blur-xl select-none relative"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={onToggleSidebar}
          className="flex items-center px-1 py-0.5 -ml-1 rounded-md transition-all hover:bg-white/5 active:scale-95 group cursor-pointer"
        >
          <SyntaxBrand className="scale-[0.78] origin-left" />
        </button>
      </div>

      <div className="flex-1 h-full" style={{ WebkitAppRegion: 'drag' } as any} />

      <div className="flex items-center gap-1 shrink-0 mr-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
        {onToggleRightPanel && (
          <button
            onClick={onToggleRightPanel}
            className="p-1.5 rounded-md text-text-3 hover:text-text hover:bg-white/5 active:scale-95 cursor-pointer transition-all"
            title={rightPanelOpen ? 'Close task panel' : 'Open task panel'}
          >
            {rightPanelOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
          </button>
        )}
      </div>
      <div className="w-[140px] shrink-0 h-full pointer-events-none" />
    </div>
  )
}
