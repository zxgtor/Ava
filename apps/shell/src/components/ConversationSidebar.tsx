import { useEffect, useMemo, useRef, useState } from 'react'
import { 
  Settings, Trash2, Edit2, Plus, ChevronRight, X,
  MoreVertical, Pin, Archive, FolderPlus, FolderOpen,
  MessageSquare
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { getTraitConfig } from '../lib/agent/traits'
import type { Conversation } from '../types'

function formatRelativeTime(dateMs: number) {
  const diff = Date.now() - dateMs
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y`
}

export function ConversationSidebar() {
  const { t } = useTranslation()
  const { state, dispatch, createConversation } = useStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const editInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const sorted = useMemo(() => {
    return [...state.conversations]
      .filter(c => showArchived ? c.archived : !c.archived)
      .sort((a, b) => {
        if (!showArchived) {
          if (a.pinned && !b.pinned) return -1
          if (!a.pinned && b.pinned) return 1
        }
        return b.updatedAt - a.updatedAt
      })
  }, [state.conversations, showArchived])

  const handleSelect = (id: string) => {
    dispatch({ type: 'SELECT_CONVERSATION', id })
    dispatch({ type: 'SET_VIEW', view: 'chat' })
  }

  const handleNew = () => {
    createConversation()
    dispatch({ type: 'SET_VIEW', view: 'chat' })
  }

  const startEditing = (conv: Conversation) => {
    setEditingId(conv.id)
    setEditTitle(conv.title)
    setMenuOpenId(null)
  }

  const saveEditing = () => {
    if (editingId && editTitle.trim()) {
      dispatch({ type: 'RENAME_CONVERSATION', id: editingId, title: editTitle.trim() })
    }
    setEditingId(null)
  }

  const handleLinkFolder = async (id: string) => {
    setMenuOpenId(null)
    const conv = state.conversations.find(c => c.id === id)
    if (!conv) return

    try {
      const path = await window.ava.dialog.pickDirectory()
      if (path) {
        // 1. 更新状态
        dispatch({ type: 'SET_CONVERSATION_FOLDER', id, path })

        // 2. 立即执行自动化初始化
        const trait = conv.traits?.[0] || 'chat'
        
        // 生成任务清单
        const tasksContent = `# Tasks: ${conv.title}\n\n- [ ] Initial Research\n- [ ] Brainstorming\n- [ ] Draft Implementation\n- [ ] Review & Refine\n`
        await window.ava.fs.writeFile(`${path}/TASKS.md`, tasksContent)

        // 根据特性生成专属文档
        let specFile = 'GOALS.md'
        let specContent = `# Goals: ${conv.title}\n\nDescribe the main objectives here.`

        if (trait === 'code') {
          specFile = 'SPECS.md'
          specContent = `# Technical Specs: ${conv.title}\n\n## Architecture\n- \n\n## Dependencies\n- \n`
        } else if (trait === 'business') {
          specFile = 'BUSINESS_PLAN.md'
          specContent = `# Business Plan: ${conv.title}\n\n## Market Analysis\n- \n\n## Revenue Model\n- \n`
        } else if (trait === 'video') {
          specFile = 'SCRIPT.md'
          specContent = `# Script/Storyboard: ${conv.title}\n\n## Scene 1\n- \n`
        } else if (trait === 'design') {
          specFile = 'DESIGN_SPEC.md'
          specContent = `# Design Spec: ${conv.title}\n\n## Brand/Mood\n- \n\n## Color Palette\n- \n\n## Typography\n- \n`
          // 额外生成一个资产清单
          await window.ava.fs.writeFile(`${path}/ASSETS.md`, `# Design Assets: ${conv.title}\n\n- [ ] Logo\n- [ ] Icons\n- [ ] Mockups\n`)
        }

        await window.ava.fs.writeFile(`${path}/${specFile}`, specContent)
        
        // 3. 打开文件夹展示成果
        window.ava.shell.openPath(path)
      }
    } catch (err) {
      console.warn('Failed to link and init folder:', err)
    }
  }

  const handleInitWorkspace = async (conv: Conversation) => {
    // Keep this for manual re-runs if ever needed, or remove if strictly auto
    // For now, I'll keep the logic here but remove the button
    const folder = conv.folderPath
    if (!folder) return
    try {
      // ... same logic as above ...
    } catch (err) { console.error(err) }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpenId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  return (
    <div className="flex flex-col h-full w-64 flex-shrink-0 bg-surface/60 backdrop-blur-3xl border-r border-border-subtle select-none text-[12px] custom-sidebar-scroll">
      <div className="p-2 flex items-center justify-between gap-1">
        <div className="flex flex-[2] items-center gap-1">
          <button 
            onClick={() => setShowArchived(false)}
            title={t('sidebar.active')}
            className={`flex-1 flex items-center justify-center py-2 rounded-md transition-all ${!showArchived ? 'bg-accent/10 text-accent' : 'text-text-3 hover:text-text-2 hover:bg-white/5'}`}
          >
            <MessageSquare size={16} />
          </button>
          <button 
            onClick={() => setShowArchived(true)}
            title={t('sidebar.archived')}
            className={`flex-1 flex items-center justify-center py-2 rounded-md transition-all ${showArchived ? 'bg-accent/10 text-accent' : 'text-text-3 hover:text-text-2 hover:bg-white/5'}`}
          >
            <Archive size={16} />
          </button>
        </div>

        <div className="w-[1px] h-4 bg-white/5 mx-1" />

        <button
          type="button"
          onClick={handleNew}
          title={t('sidebar.new_chat')}
          className="flex-1 flex items-center justify-center py-2 rounded-md hover:bg-white/5 text-text-3 hover:text-white transition-all"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="px-1 space-y-0.5 pb-2">
          {sorted.length === 0 ? (
            <div className="px-4 py-8 text-center text-text-3 italic opacity-40">
              {t('sidebar.no_conversations')}
            </div>
          ) : (
            sorted.map((conv) => {
              const isActive = state.activeConversationId === conv.id
              const { icon: TraitIcon, color: traitColor } = getTraitConfig(conv.traits?.[0] || 'chat')
              const isMenuOpen = menuOpenId === conv.id

              return (
                <div
                  key={conv.id}
                  onClick={() => handleSelect(conv.id)}
                  className={`
                    group relative flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer transition-all
                    ${isActive ? 'bg-white/[0.08] text-white shadow-sm' : 'text-text-2 hover:bg-white/[0.04] hover:text-white'}
                  `}
                >
                  <div className="flex items-center gap-2.5 flex-1 min-w-0 pr-2">
                    <div className="shrink-0 flex items-center justify-center w-4 h-4 relative">
                      <TraitIcon 
                        size={14} 
                        className={`transition-all duration-300 ${traitColor} ${isActive ? 'opacity-100 scale-110' : 'opacity-40 group-hover:opacity-80'}`} 
                      />
                      {conv.pinned && (
                        <div className="absolute -top-1 -left-1 text-accent animate-in fade-in zoom-in duration-300">
                          <Pin size={8} fill="currentColor" />
                        </div>
                      )}
                    </div>
                    
                    {editingId === conv.id ? (
                      <input
                        ref={editInputRef}
                        value={editTitle}
                        onChange={e => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEditing()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        onClick={e => e.stopPropagation()}
                        onBlur={saveEditing}
                        className="flex-1 min-w-0 bg-black/40 border border-accent/40 rounded px-1.5 py-0.5 text-[11px] text-white focus:outline-none"
                      />
                    ) : (
                      <div className="flex-1 min-w-0 flex flex-col">
                        <span className={`truncate font-normal tracking-tight transition-colors ${isActive ? 'text-white' : 'text-text-2 group-hover:text-text-1'}`}>
                          {conv.title || t('sidebar.untitled', 'Untitled')}
                        </span>
                        {conv.folderPath && (
                          <div className="flex flex-col gap-0.5 mt-0.5">
                            <span className="text-[9px] text-text-3 truncate opacity-50 flex items-center gap-1">
                              <FolderOpen size={8} />
                              {conv.folderPath.split(/[\\/]/).pop()}
                              {state.projectBriefs[conv.id] && (
                                <span className="opacity-70">
                                  · {state.projectBriefs[conv.id].files.length} {t('chat.files_detected', 'files')}
                                </span>
                              )}
                            </span>
                            {state.projectBriefs[conv.id]?.tasksTotal > 0 && (
                              <div className="flex items-center gap-1.5 h-1">
                                <div className="flex-1 h-[2px] bg-white/5 rounded-full overflow-hidden">
                                  <div 
                                    className="h-full bg-accent transition-all" 
                                    style={{ width: `${(state.projectBriefs[conv.id].tasksDone / state.projectBriefs[conv.id].tasksTotal) * 100}%` }}
                                  />
                                </div>
                                <span className="text-[8px] font-mono text-accent opacity-60">
                                  {Math.round((state.projectBriefs[conv.id].tasksDone / state.projectBriefs[conv.id].tasksTotal) * 100)}%
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {editingId !== conv.id && (
                    <div className="flex items-center shrink-0 ml-1">
                      <span className={`text-[10px] font-mono opacity-30 group-hover:hidden ${isActive ? 'opacity-50' : ''}`}>
                        {formatRelativeTime(conv.updatedAt)}
                      </span>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpenId(isMenuOpen ? null : conv.id)
                        }}
                        className={`p-1 rounded hover:bg-white/10 transition-colors ${isMenuOpen ? 'bg-white/10 opacity-100' : 'hidden group-hover:block opacity-40 hover:opacity-100'}`}
                      >
                        <MoreVertical size={13} />
                      </button>
                    </div>
                  )}

                  {isMenuOpen && (
                    <div 
                      ref={menuRef}
                      className="absolute right-2 top-8 z-50 w-48 bg-[#1a1b1e]/98 border border-white/10 rounded-lg shadow-[0_20px_50px_rgba(0,0,0,0.8)] backdrop-blur-2xl py-1.5 animate-in fade-in zoom-in duration-150 ring-1 ring-black/5"
                      onClick={e => e.stopPropagation()}
                    >
                      <button onClick={() => startEditing(conv)} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-white">
                        <Edit2 size={13} className="opacity-60" />
                        <span>{t('sidebar.rename', 'Rename')}</span>
                      </button>
                      <button onClick={() => dispatch({ type: 'TOGGLE_PIN_CONVERSATION', id: conv.id })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-white">
                        <Pin size={13} className={conv.pinned ? 'text-accent' : 'opacity-60'} fill={conv.pinned ? 'currentColor' : 'none'} />
                        <span>{conv.pinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pin', 'Pin')}</span>
                      </button>
                      {conv.folderPath ? (
                        <>
                          <button onClick={() => dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conv.id, path: '' })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-white">
                            <X size={13} className="opacity-60" />
                            <span>{t('sidebar.unlink_folder', 'Unlink folder')}</span>
                          </button>
                        </>
                      ) : (
                        <button onClick={() => handleLinkFolder(conv.id)} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-white">
                          <FolderPlus size={13} className="opacity-60" />
                          <span>{t('sidebar.link_folder', 'Link folder')}</span>
                        </button>
                      )}
                      <div className="h-[1px] bg-white/5 my-1.5 mx-2" />
                      {conv.archived ? (
                        <button onClick={() => dispatch({ type: 'ARCHIVE_CONVERSATION', id: conv.id, archived: false })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-white">
                          <Archive size={13} className="text-accent" />
                          <span>{t('sidebar.restore', 'Restore')}</span>
                        </button>
                      ) : (
                        <button onClick={() => dispatch({ type: 'ARCHIVE_CONVERSATION', id: conv.id })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-white">
                          <Archive size={13} className="opacity-60" />
                          <span>{t('sidebar.archive', 'Archive')}</span>
                        </button>
                      )}
                      <button onClick={() => {
                        dispatch({ type: 'DELETE_CONVERSATION', id: conv.id })
                        setMenuOpenId(null)
                      }} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-red-500/10 text-red-400 hover:text-red-300 transition-colors">
                        <Trash2 size={13} className="opacity-80" />
                        <span>{t('sidebar.delete', 'Delete')}</span>
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="p-1.5 border-t border-border-subtle bg-black/10">
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
          className={`
            w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition-colors
            ${state.viewMode === 'settings' ? 'bg-white/10 text-white' : 'text-text-3 hover:bg-white/5 hover:text-text-2'}
          `}
        >
          <Settings size={14} />
          <span className="font-medium">{t('sidebar.settings')}</span>
        </button>
      </div>
    </div>
  )
}
