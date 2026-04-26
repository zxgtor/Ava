import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { ChatHeader } from './ChatHeader'
import { EmptyState } from './EmptyState'
import { MessageBubble } from './MessageBubble'
import { PromptInput } from './PromptInput'
import {
  makeAssistantPlaceholder,
  makeStreamId,
  makeTaskId,
  makeUserMessage,
  sendChat,
} from '../lib/agent/chat'
import { getEnabledProviders } from '../lib/llm/providers'
import type { CommandInvocation, ContentPart, Conversation, PluginCommand } from '../types'

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

function hasFailedToolCall(conversation: Conversation, messageId: string): boolean {
  const message = conversation.messages.find(m => m.id === messageId)
  return Boolean(message?.content.some(part =>
    part.type === 'tool_call' && (part.status === 'error' || part.status === 'aborted'),
  ))
}

function lastStreamingAssistant(conversation: Conversation): string | null {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]
    if (message.role === 'assistant' && message.streaming) return message.id
  }
  return null
}

export function ChatView() {
  const { state, dispatch, activeConversation, createConversation } = useStore()
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamId, setStreamId] = useState<string | null>(null)
  const [commands, setCommands] = useState<PluginCommand[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const hasProvider = useMemo(
    () => getEnabledProviders(state.settings).length > 0,
    [state.settings],
  )

  const userInitial = (state.settings.persona.userName || 'U').slice(0, 1).toUpperCase()
  const assistantInitial = (state.settings.persona.assistantName || 'A').slice(0, 1).toUpperCase()

  const refreshCommands = useCallback(async () => {
    setCommandsLoading(true)
    try {
      const list = await window.ava.plugins.listCommands(state.settings.pluginStates)
      setCommands(list)
    } catch {
      setCommands([])
    } finally {
      setCommandsLoading(false)
    }
  }, [state.settings.pluginStates])

  useEffect(() => {
    refreshCommands()
  }, [refreshCommands])

  // Auto-scroll on new messages / streaming
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeConversation?.messages, isStreaming])

  // Shared streaming driver. `conversationSnapshot.messages` is the full history
  // that should be sent to the LLM (NOT including the placeholder).
  const driveStream = useCallback(
    async (
      conversationSnapshot: Conversation,
      conversationId: string,
      placeholderId: string,
      activeTaskId: string,
    ) => {
      const id = makeStreamId()
      setStreamId(id)
      setIsStreaming(true)

      try {
        const result = await sendChat({
          conversation: conversationSnapshot,
          settings: state.settings,
          streamId: id,
          activeTaskId,
          onDelta: delta => {
            dispatch({
              type: 'APPEND_DELTA',
              conversationId,
              messageId: placeholderId,
              delta,
            })
          },
          onPart: ({ taskId, part }) => {
            if (taskId && taskId !== activeTaskId) return
            dispatch({
              type: 'ADD_PART',
              conversationId,
              messageId: placeholderId,
              part: part.type === 'tool_call' ? { ...part, taskId: part.taskId ?? activeTaskId } : part,
            })
          },
          onPartUpdate: ({ taskId, partIndex, partId, patch }) => {
            if (taskId && taskId !== activeTaskId) return
            dispatch({
              type: 'UPDATE_PART',
              conversationId,
              messageId: placeholderId,
              partIndex,
              partId,
              patch,
            })
          },
        })

        if (result.ok) {
          if (result.detectedToolFormat !== 'none') {
            const key = `${result.providerId}:${result.model}`
            dispatch({
              type: 'UPDATE_SETTINGS',
              settings: {
                ...state.settings,
                modelToolFormatMap: {
                  ...state.settings.modelToolFormatMap,
                  [key]: result.detectedToolFormat,
                },
              },
            })
          }
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false },
          })
        } else if (result.error === 'aborted') {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, aborted: true },
          })
        } else {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: result.error },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'aborted') {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, aborted: true },
          })
        } else {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: msg },
          })
        }
      } finally {
        setIsStreaming(false)
        setStreamId(null)
      }
    },
    [dispatch, state.settings],
  )

  const runSend = useCallback(
    async (content: string, conversation: Conversation, commandInvocation?: CommandInvocation) => {
      const taskId = makeTaskId()
      const userMsg = makeUserMessage(content, commandInvocation, taskId)
      const placeholder = makeAssistantPlaceholder(taskId)
      const conversationId = conversation.id

      dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })

      // Auto-title from first user message
      if (conversation.messages.length === 0) {
        const title = content.length > 30 ? `${content.slice(0, 30)}…` : content
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
      }

      await driveStream(
        { ...conversation, messages: [...conversation.messages, userMsg] },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [dispatch, driveStream],
  )

  const handleSend = useCallback(
    (content: string, commandInvocation?: CommandInvocation) => {
      const conversation = activeConversation ?? createConversation()
      runSend(content, conversation, commandInvocation)
    },
    [activeConversation, createConversation, runSend],
  )

  const handleStop = useCallback(() => {
    if (streamId) {
      const lastAssistantId = activeConversation ? lastStreamingAssistant(activeConversation) : null
      if (activeConversation && lastAssistantId) {
        dispatch({
          type: 'ABORT_RUNNING_PARTS',
          conversationId: activeConversation.id,
          messageId: lastAssistantId,
        })
      }
      window.ava.llm.abort(streamId).catch(() => { /* noop */ })
    }
  }, [activeConversation, dispatch, streamId])

  const handleDeleteMessage = useCallback(
    (id: string) => {
      if (!activeConversation) return
      dispatch({ type: 'DELETE_MESSAGE', conversationId: activeConversation.id, messageId: id })
    },
    [activeConversation, dispatch],
  )

  const handleNewConversation = useCallback(() => {
    createConversation()
  }, [createConversation])

  const handleDeleteConversation = useCallback(() => {
    if (!activeConversation) return
    dispatch({ type: 'DELETE_CONVERSATION', id: activeConversation.id })
  }, [activeConversation, dispatch])

  const handleOpenSettings = useCallback(() => {
    dispatch({ type: 'SET_VIEW', view: 'settings' })
  }, [dispatch])

  const handleToggleSidebar = useCallback(() => {
    dispatch({ type: 'SET_SIDEBAR', open: !state.sidebarOpen })
  }, [dispatch, state.sidebarOpen])

  const handleRetry = useCallback(
    async (failedId: string) => {
      if (!activeConversation || isStreaming) return
      const msgs = activeConversation.messages
      const idx = msgs.findIndex(m => m.id === failedId)
      if (idx < 0) return
      const target = msgs[idx]
      if (
        target.role !== 'assistant' ||
        (!target.error && !target.aborted && !hasFailedToolCall(activeConversation, failedId))
      ) return
      // Only allow retrying the last message, to avoid desynchronizing later turns.
      if (idx !== msgs.length - 1) return

      const conversationId = activeConversation.id
      dispatch({ type: 'DELETE_MESSAGE', conversationId, messageId: failedId })

      const previousUser = (() => {
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (msgs[i].role === 'user') return msgs[i]
        }
        return null
      })()
      const taskId = target.taskId ?? previousUser?.taskId ?? makeTaskId()
      const placeholder = makeAssistantPlaceholder(taskId)
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })

      await driveStream(
        { ...activeConversation, messages: msgs.slice(0, idx) },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [activeConversation, isStreaming, dispatch, driveStream],
  )

  const handleCommandRetry = useCallback(
    async (messageId: string) => {
      if (!activeConversation || isStreaming) return
      const message = activeConversation.messages.find(m => m.id === messageId)
      if (!message || message.role !== 'user' || !message.commandInvocation) return
      const content = partsToText(message.content)
      if (!content.trim()) return
      await runSend(content, activeConversation, message.commandInvocation)
    },
    [activeConversation, isStreaming, runSend],
  )

  const messages = (activeConversation?.messages ?? []).filter(m => {
    // Skip ghost assistant messages: empty content, not streaming, no error/abort
    if (
      m.role === 'assistant' &&
      !m.streaming &&
      !m.error &&
      !m.aborted &&
      m.content.length === 0
    ) return false
    return true
  })
  const showEmpty = !activeConversation || messages.length === 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChatHeader
        activeConversation={activeConversation}
        sidebarOpen={state.sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        onNewConversation={handleNewConversation}
        onOpenSettings={handleOpenSettings}
        onDeleteConversation={activeConversation ? handleDeleteConversation : undefined}
      />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {showEmpty ? (
          <EmptyState
            userName={state.settings.persona.userName}
            onPick={content => handleSend(content)}
            disabled={!hasProvider}
          />
        ) : (
          <div className="py-4">
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1
              const canRetry =
                isLast &&
                m.role === 'assistant' &&
                !m.streaming &&
                (Boolean(m.error) || Boolean(m.aborted) || hasFailedToolCall(activeConversation, m.id))
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  userInitial={userInitial}
                  assistantInitial={assistantInitial}
                  onDelete={handleDeleteMessage}
                  onRetry={canRetry ? () => handleRetry(m.id) : undefined}
                  onCommandRetry={
                    !isStreaming && m.role === 'user' && m.commandInvocation
                      ? () => handleCommandRetry(m.id)
                      : undefined
                  }
                />
              )
            })}
          </div>
        )}
      </div>

      <PromptInput
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        disabled={!hasProvider}
        disabledReason="请先在设置中启用至少一个 LLM 供应商"
        commands={commands}
        commandsLoading={commandsLoading}
        onRefreshCommands={refreshCommands}
      />
    </div>
  )
}
