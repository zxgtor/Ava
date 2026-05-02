import { useEffect, useMemo, useRef, useState } from 'react'
import { 
  Settings, Trash2, Edit2, X,
  MoreVertical, Pin, Archive, FolderPlus, ChevronDown, ChevronRight,
  ListFilter, Plus, User, Palette, GitBranch, Server, ClipboardList,
  Store, Puzzle, Mic, Info, Brain, ArrowLeft,
  CirclePlus, RefreshCw, MessageCircle, ArchiveRestore,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { getTraitConfig } from '../lib/agent/traits'
import type { Conversation, InitiativeTrait } from '../types'

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

interface SidebarGroup {
  id: string
  label: string
  trait: InitiativeTrait
  icon: any
  iconColor: string
  conversations: Conversation[]
}

const SETTINGS_CATEGORIES = [
  { id: 'persona', labelKey: 'settings.persona', fallback: 'Persona', icon: User },
  { id: 'appearance', labelKey: 'settings.theme', fallback: 'Appearance', icon: Palette },
  { id: 'providers', labelKey: 'settings.llm', fallback: 'LLM Providers', icon: Brain },
  { id: 'chain', labelKey: 'settings.fallback_chain', fallback: 'Fallback Chain', icon: GitBranch },
  { id: 'mcp', labelKey: 'settings.mcp', fallback: 'MCP Servers', icon: Server },
  { id: 'audit', labelKey: 'settings.audit_title', fallback: 'Tool Audit Log', icon: ClipboardList },
  { id: 'marketplace', labelKey: 'settings.marketplace_title', fallback: 'Plugin Marketplace', icon: Store },
  { id: 'plugins', labelKey: 'settings.plugins', fallback: 'Plugins', icon: Puzzle },
  { id: 'voice', labelKey: 'settings.voice', fallback: 'Voice & STT', icon: Mic },
  { id: 'about', labelKey: 'settings.about', fallback: 'About', icon: Info },
]

export function ConversationSidebar() {
  const { t } = useTranslation()
  const { state, dispatch } = useStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [organizeOpenId, setOrganizeOpenId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [groupSorts, setGroupSorts] = useState<Record<string, 'updated' | 'created'>>({})
  const [groupShowModes, setGroupShowModes] = useState<Record<string, 'active' | 'all'>>({})
  const editInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const groups = useMemo<SidebarGroup[]>(() => {
    const active = [...state.conversations]
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return b.updatedAt - a.updatedAt
      })

    const shouldShow = (groupId: string, conv: Conversation) => {
      const showMode = groupShowModes[groupId] || 'active'
      return showMode === 'all' || !conv.archived
    }

    const allPinned = active.filter(c => c.pinned)
    const pinned = allPinned.filter(c => shouldShow('pinned', c))
    const byTrait = new Map<string, Conversation[]>()
    const allByTrait = new Map<string, Conversation[]>()
    const sortConversations = (groupId: string, conversations: Conversation[]) => {
      const sortBy = groupSorts[groupId] || 'updated'
      return [...conversations].sort((a, b) =>
        sortBy === 'created'
          ? b.createdAt - a.createdAt
          : b.updatedAt - a.updatedAt,
      )
    }

    active
      .filter(c => !c.pinned)
      .forEach(conv => {
        const trait = conv.traits?.[0] || 'chat'
        const allItems = allByTrait.get(trait) || []
        allItems.push(conv)
        allByTrait.set(trait, allItems)
        if (!shouldShow(`trait:${trait}`, conv)) return
        const items = byTrait.get(trait) || []
        items.push(conv)
        byTrait.set(trait, items)
      })

    const nextGroups: SidebarGroup[] = []
    if (allPinned.length > 0) {
      nextGroups.push({
        id: 'pinned',
        label: t('sidebar.pinned', 'Pinned'),
        trait: 'chat',
        icon: Pin,
        iconColor: 'text-accent',
        conversations: sortConversations('pinned', pinned),
      })
    }

    Array.from(allByTrait.entries())
      .sort(([, a], [, b]) => b[0].updatedAt - a[0].updatedAt)
      .forEach(([trait]) => {
        const id = `trait:${trait}`
        const traitConfig = getTraitConfig(trait)
        nextGroups.push({
          id,
          label: t(`traits.${trait}`, traitConfig.label),
          trait: trait as InitiativeTrait,
          icon: traitConfig.icon,
          iconColor: traitConfig.color,
          conversations: sortConversations(id, byTrait.get(trait) || []),
        })
      })

    return nextGroups
  }, [groupShowModes, groupSorts, state.conversations, t])

  const hasConversations = groups.some(group => group.conversations.length > 0)

  const toggleGroup = (id: string) => {
    setCollapsedGroups(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleNewSession = () => {
    dispatch({ type: 'CLEAR_ACTIVE_CONVERSATION' })
    dispatch({ type: 'SET_VIEW', view: 'chat' })
  }

  const handleSelect = (id: string) => {
    dispatch({ type: 'SELECT_CONVERSATION', id })
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

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpenId(null)
        setOrganizeOpenId(null)
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

  if (state.viewMode === 'settings') {
    return (
      <div className="flex flex-col h-full w-64 flex-shrink-0 bg-surface/60 backdrop-blur-3xl border-r border-border-subtle select-none text-[12px] custom-sidebar-scroll">
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 pt-1.5 pb-2">
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'chat' })}
            className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-text-3 transition-colors hover:bg-white/[0.04] hover:text-text"
          >
            <ArrowLeft size={14} />
            <span>{t('settings.back', 'Back')}</span>
          </button>
          <div className="px-2 py-2 text-[11px] font-medium text-text-3">{t('settings.title', 'Settings')}</div>
          <div className="space-y-0.5">
            {SETTINGS_CATEGORIES.map(category => {
              const Icon = category.icon
              const active = state.settingsSection === category.id
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => dispatch({ type: 'SET_SETTINGS_SECTION', section: category.id })}
                  className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    active ? 'bg-white/[0.08] text-text' : 'text-text-2 hover:bg-white/[0.04] hover:text-text'
                  }`}
                >
                  <Icon size={14} className={active ? 'text-accent' : 'text-text-3 group-hover:text-text-2'} />
                  <span className="truncate">{t(category.labelKey, category.fallback)}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-64 flex-shrink-0 bg-surface/60 backdrop-blur-3xl border-r border-border-subtle select-none text-[12px] custom-sidebar-scroll">
      <div className="px-1 pt-1.5 pb-1">
        <button
          type="button"
          onClick={handleNewSession}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-text-2 transition-colors hover:bg-white/[0.04] hover:text-text"
          title={t('sidebar.new_chat', 'New session')}
        >
          <Plus size={14} />
          <span className="font-medium">{t('sidebar.new_chat', 'New session')}</span>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="px-1 space-y-0.5 pb-2">
          {!hasConversations ? (
            <div className="px-4 py-8 text-center text-text-3 italic opacity-40">
              {t('sidebar.no_conversations')}
            </div>
          ) : (
            groups.map((group) => {
              const collapsed = collapsedGroups[group.id]
              const GroupIcon = collapsed ? ChevronRight : ChevronDown
              const TypeIcon = group.icon
              const isOrganizeOpen = organizeOpenId === group.id
              const canUseGroupActions = group.id !== 'pinned'
              const groupSort = groupSorts[group.id] || 'updated'
              const groupShowMode = groupShowModes[group.id] || 'active'

              return (
                <div key={group.id} className="pt-2 first:pt-0">
                  <div className="group/title relative flex h-6 w-full items-center justify-between px-2 text-[11px] font-medium text-text-3 hover:text-text-2">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="flex min-w-0 items-center gap-1.5 text-left"
                    >
                      <TypeIcon size={12} className={`${group.iconColor} opacity-70`} />
                      <span className="truncate">{group.label}</span>
                      <GroupIcon size={12} className="opacity-0 transition-opacity group-hover/title:opacity-70" />
                    </button>

                    {canUseGroupActions && (
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/title:opacity-80">
                      <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation()
                            setOrganizeOpenId(isOrganizeOpen ? null : group.id)
                            setMenuOpenId(null)
                          }}
                          className={`rounded p-1 hover:bg-white/10 hover:text-text ${isOrganizeOpen ? 'bg-white/10 text-text' : ''}`}
                          title={t('sidebar.organize_group', 'Organize')}
                        >
                          <ListFilter size={12} />
                        </button>
                      </div>
                    )}

                    {canUseGroupActions && isOrganizeOpen && (
                      <div
                        ref={menuRef}
                        className="absolute right-8 top-6 z-50 w-44 rounded-lg border border-white/10 bg-[#252528]/98 py-2 text-[12px] text-text-2 shadow-[0_20px_50px_rgba(0,0,0,0.65)] backdrop-blur-2xl"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="px-3 pb-1 text-[11px] font-medium text-text-3">{t('sidebar.sort_by', 'Sort by')}</div>
                        <button
                          onClick={() => setGroupSorts(prev => ({ ...prev, [group.id]: 'created' }))}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 hover:text-text"
                        >
                          <CirclePlus size={13} className="text-text-3" />
                          <span className="font-medium">{t('sidebar.sort_created', 'Created')}</span>
                          {groupSort === 'created' && <span className="ml-auto text-text-3">✓</span>}
                        </button>
                        <button
                          onClick={() => setGroupSorts(prev => ({ ...prev, [group.id]: 'updated' }))}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 hover:text-text"
                        >
                          <RefreshCw size={13} className="text-text-3" />
                          <span className="font-medium">{t('sidebar.sort_updated', 'Updated')}</span>
                          {groupSort === 'updated' && <span className="ml-auto text-text-3">✓</span>}
                        </button>

                        <div className="mx-3 my-2 h-[1px] bg-white/8" />
                        <div className="px-3 pb-1 text-[11px] font-medium text-text-3">{t('sidebar.show', 'Show')}</div>
                        <button
                          onClick={() => setGroupShowModes(prev => ({ ...prev, [group.id]: 'all' }))}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 hover:text-text"
                        >
                          <MessageCircle size={13} className="text-text-3" />
                          <span className="font-medium">{t('sidebar.all_chats', 'All chats')}</span>
                          {groupShowMode === 'all' && <span className="ml-auto text-text-3">✓</span>}
                        </button>
                        <button
                          onClick={() => setGroupShowModes(prev => ({ ...prev, [group.id]: 'active' }))}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 hover:text-text"
                        >
                          <ArchiveRestore size={13} className="text-text-3" />
                          <span className="font-medium">{t('sidebar.active', 'Active')}</span>
                          {groupShowMode === 'active' && <span className="ml-auto text-text-3">✓</span>}
                        </button>
                      </div>
                    )}
                  </div>

                  {!collapsed && (
                    <div className="space-y-0.5">
                      {group.conversations.map((conv) => {
                        const isActive = state.activeConversationId === conv.id
                        const isMenuOpen = menuOpenId === conv.id
                        const isArchived = Boolean(conv.archived)

                        return (
                          <div
                            key={conv.id}
                            onClick={() => handleSelect(conv.id)}
                            className={`
                              group relative flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer transition-all
                              ${
                                isActive
                                  ? 'bg-white/[0.08] text-text shadow-sm'
                                  : isArchived
                                    ? 'text-text-3 opacity-70 hover:bg-white/[0.035] hover:text-text-2 hover:opacity-100'
                                    : 'text-text-2 hover:bg-white/[0.04] hover:text-text'
                              }
                            `}
                          >
                            <div className="flex items-center flex-1 min-w-0 pr-8 pl-[18px]">
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
                                  className="flex-1 min-w-0 bg-black/40 border border-accent/40 rounded px-1.5 py-0.5 text-[11px] text-text focus:outline-none"
                                />
                              ) : (
                                <div className="flex-1 min-w-0 flex flex-col">
                                  <span className={`flex items-center gap-1 truncate font-normal tracking-tight transition-colors ${
                                    isActive
                                      ? 'text-text'
                                      : isArchived
                                        ? 'text-text-3 group-hover:text-text-2'
                                        : 'text-text-2 group-hover:text-text'
                                  }`}>
                                    <span className="truncate">{conv.title || t('sidebar.untitled', 'Untitled')}</span>
                                    {isArchived && <Archive size={10} className="shrink-0 opacity-60" />}
                                  </span>
                                </div>
                              )}
                            </div>

                            {editingId !== conv.id && (
                              <div className="absolute right-2 top-1/2 h-5 w-7 -translate-y-1/2">
                                <span className={`absolute inset-0 flex items-center justify-end text-[10px] font-mono opacity-30 transition-opacity group-hover:opacity-0 ${isActive ? 'opacity-50' : ''}`}>
                                  {formatRelativeTime(conv.updatedAt)}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setMenuOpenId(isMenuOpen ? null : conv.id)
                                  }}
                                  className={`absolute right-0 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-white/10 transition-colors ${isMenuOpen ? 'bg-white/10 opacity-100' : 'opacity-0 group-hover:opacity-70 hover:opacity-100'}`}
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
                                <button onClick={() => startEditing(conv)} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-text">
                                  <Edit2 size={13} className="opacity-60" />
                                  <span>{t('sidebar.rename', 'Rename')}</span>
                                </button>
                                <button onClick={() => dispatch({ type: 'TOGGLE_PIN_CONVERSATION', id: conv.id })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-text">
                                  <Pin size={13} className={conv.pinned ? 'text-accent' : 'opacity-60'} fill={conv.pinned ? 'currentColor' : 'none'} />
                                  <span>{conv.pinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pin', 'Pin')}</span>
                                </button>
                                {conv.folderPath ? (
                                  <>
                                    <button onClick={() => dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conv.id, path: '' })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-text">
                                      <X size={13} className="opacity-60" />
                                      <span>{t('sidebar.unlink_folder', 'Unlink folder')}</span>
                                    </button>
                                  </>
                                ) : (
                                  <button onClick={() => handleLinkFolder(conv.id)} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-text">
                                    <FolderPlus size={13} className="opacity-60" />
                                    <span>{t('sidebar.link_folder', 'Link folder')}</span>
                                  </button>
                                )}
                                <div className="h-[1px] bg-white/5 my-1.5 mx-2" />
                                {conv.archived ? (
                                  <button onClick={() => dispatch({ type: 'ARCHIVE_CONVERSATION', id: conv.id, archived: false })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-text">
                                    <Archive size={13} className="text-accent" />
                                    <span>{t('sidebar.restore', 'Restore')}</span>
                                  </button>
                                ) : (
                                  <button onClick={() => dispatch({ type: 'ARCHIVE_CONVERSATION', id: conv.id })} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors text-text-2 hover:text-text">
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
                      })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="p-1.5">
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition-colors text-text-3 hover:bg-white/5 hover:text-text-2"
        >
          <Settings size={14} />
          <span className="font-medium">{t('sidebar.settings')}</span>
        </button>
      </div>
    </div>
  )
}
