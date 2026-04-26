import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { MessageSquarePlus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import type { Conversation } from '../types'

export function ConversationSidebar() {
  const { state, dispatch, createConversation } = useStore()

  const sorted = useMemo(
    () => [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations],
  )

  const handleNew = () => {
    createConversation()
    if (state.viewMode !== 'chat') {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
    }
  }

  const handleSelect = (id: string) => {
    dispatch({ type: 'SELECT_CONVERSATION', id })
    if (state.viewMode !== 'chat') {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
    }
  }

  const handleDelete = (c: Conversation) => {
    const ok = window.confirm(`删除「${c.title}」？此对话的所有消息都会丢失。`)
    if (!ok) return
    dispatch({ type: 'DELETE_CONVERSATION', id: c.id })
  }

  const handleRename = (id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    dispatch({ type: 'RENAME_CONVERSATION', id, title: trimmed })
  }

  return (
    <div className="flex flex-col h-full w-60 flex-shrink-0 bg-bg border-r border-border-subtle">
      <div className="flex items-center justify-between h-11 px-3 border-b border-border-subtle">
        <span className="text-xs text-text-3 uppercase tracking-wide">对话</span>
        <button
          type="button"
          onClick={handleNew}
          className="flex items-center gap-1 px-2 py-1 text-xs text-accent bg-accent/10 rounded-md cursor-pointer hover:bg-accent/20 transition-colors"
          title="新对话"
        >
          <MessageSquarePlus size={14} />
          新建
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-3">还没有对话</div>
        ) : (
          sorted.map(c => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === state.activeConversationId}
              onSelect={() => handleSelect(c.id)}
              onDelete={() => handleDelete(c)}
              onRename={title => handleRename(c.id, title)}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface RowProps {
  conversation: Conversation
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (title: string) => void
}

function ConversationRow({ conversation, active, onSelect, onDelete, onRename }: RowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conversation.title)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    if (!editing) setDraft(conversation.title)
  }, [conversation.title, editing])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  const cancel = () => {
    setDraft(conversation.title)
    setEditing(false)
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return (
    <div
      onClick={editing ? undefined : onSelect}
      onDoubleClick={() => setEditing(true)}
      className={`group flex items-center gap-1 mx-1 px-2 py-1.5 rounded-md transition-colors ${
        editing
          ? 'bg-surface-2 cursor-default'
          : active
            ? 'bg-surface-2 cursor-pointer border-l-2 border-accent'
            : 'cursor-pointer hover:bg-surface border-l-2 border-transparent'
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
          className="flex-1 min-w-0 bg-bg border border-accent/60 rounded px-1.5 py-0.5 text-sm text-text outline-none"
        />
      ) : (
        <>
          <div className="flex-1 min-w-0 text-sm text-text truncate">{conversation.title}</div>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              onDelete()
            }}
            className="flex-shrink-0 p-1 text-text-3 opacity-0 rounded cursor-pointer group-hover:opacity-100 hover:text-error hover:bg-error/10 transition-colors"
            title="删除对话"
          >
            <Trash2 size={12} />
          </button>
        </>
      )}
    </div>
  )
}
