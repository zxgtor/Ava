import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Settings, Trash2, Edit2, Check, X, SquarePen } from 'lucide-react'
import { useStore } from '../store'
import type { Conversation } from '../types'

export function ConversationSidebar() {
  const { state, dispatch, activeConversation, createConversation } = useStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  const sorted = useMemo(() => {
    return [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [state.conversations])

  const handleSelect = (id: string) => {
    dispatch({ type: 'SELECT_CONVERSATION', id })
    dispatch({ type: 'SET_VIEW', view: 'chat' })
  }

  const handleNew = () => {
    createConversation()
    dispatch({ type: 'SET_VIEW', view: 'chat' })
  }

  const startEditing = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    setEditingId(conv.id)
    setEditTitle(conv.title)
  }

  const cancelEditing = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(null)
  }

  const saveEditing = (e?: React.FormEvent | React.MouseEvent) => {
    e?.stopPropagation()
    if (editingId && editTitle.trim()) {
      dispatch({ type: 'RENAME_CONVERSATION', id: editingId, title: editTitle.trim() })
    }
    setEditingId(null)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') saveEditing()
    if (e.key === 'Escape') setEditingId(null)
  }

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  return (
    <div className="flex flex-col h-full w-64 flex-shrink-0 bg-white/5 backdrop-blur-2xl border-r border-white/10 select-none">
      {/* 顶部：Chat 标题与新建按钮 */}
      <div className="flex items-center justify-between px-5 pt-8 pb-4">
        <h2 className="text-xl font-semibold text-white/90 tracking-tight">Chat</h2>
        <button
          type="button"
          onClick={handleNew}
          className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-all active:scale-90"
          title="新对话"
        >
          <SquarePen size={20} />
        </button>
      </div>

      {/* 中间：历史列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-1">
        {sorted.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-white/30 italic">开启您的第一次对话</p>
          </div>
        ) : (
          sorted.map((conv) => (
            <div
              key={conv.id}
              onClick={() => handleSelect(conv.id)}
              className={`
                group relative flex items-center gap-3 px-3 py-3 rounded-xl cursor-pointer transition-all duration-200
                ${state.activeConversationId === conv.id 
                  ? 'bg-white/10 text-white shadow-sm ring-1 ring-white/10' 
                  : 'text-white/50 hover:bg-white/5 hover:text-white/80'}
              `}
            >
              <div className={`w-1.5 h-1.5 rounded-full transition-all ${state.activeConversationId === conv.id ? 'bg-accent scale-100 shadow-[0_0_8px_rgba(59,130,246,0.6)]' : 'bg-transparent scale-0'}`} />
              
              <div className="flex-1 min-w-0">
                {editingId === conv.id ? (
                  <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <input
                      ref={editInputRef}
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={handleKeyDown}
                      className="w-full bg-black/20 border border-white/20 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-accent"
                    />
                  </div>
                ) : (
                  <div className="text-sm truncate font-medium">
                    {conv.title || '无标题对话'}
                  </div>
                )}
                <div className="text-[10px] opacity-40 mt-0.5 font-light">
                  {new Date(conv.updatedAt).toLocaleDateString()}
                </div>
              </div>

              {/* 列表项操作按钮 */}
              <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                {editingId === conv.id ? (
                  <div className="flex items-center gap-1">
                    <button onClick={saveEditing} className="p-1 hover:text-accent"><Check size={14} /></button>
                    <button onClick={cancelEditing} className="p-1 hover:text-white/50"><X size={14} /></button>
                  </div>
                ) : (
                  <div className="flex items-center">
                    <button 
                      onClick={(e) => startEditing(e, conv)}
                      className="p-1.5 text-white/30 hover:text-white transition-colors"
                    >
                      <Edit2 size={12} />
                    </button>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation()
                        dispatch({ type: 'DELETE_CONVERSATION', id: conv.id })
                      }}
                      className="p-1.5 text-white/30 hover:text-error transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 底部：功能底座 */}
      <div className="p-3 border-t border-white/10 bg-white/5">
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
          className={`
            w-full flex items-center gap-3 py-2.5 px-4 rounded-xl transition-all group
            ${state.viewMode === 'settings' 
              ? 'bg-accent/10 text-accent' 
              : 'text-white/40 hover:bg-white/5 hover:text-white/80'}
          `}
        >
          <Settings size={18} className="group-hover:rotate-90 transition-transform duration-700" />
          <span className="text-sm font-medium">设置</span>
        </button>
      </div>
    </div>
  )
}
