import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Upload, FolderOpen, Plus } from 'lucide-react'
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
import { STTClient } from '../lib/voiceClient'
import { detectTraitsFromText } from '../lib/agent/traits'
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
  const [sttClient, setSttClient] = useState<STTClient | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [sttText, setSttText] = useState<string | undefined>(undefined)
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
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

  // Project Status & Context (Level 2 & 3)
  const [projectBrief, setProjectBrief] = useState<{ tasksDone: number; tasksTotal: number; files: string[] } | null>(null)

  const syncProjectContext = useCallback(async () => {
    if (!activeConversation?.folderPath) {
      setProjectBrief(null)
      return
    }
    try {
      const folder = activeConversation.folderPath
      const fileList = await window.ava.fs.listDir(folder)
      const files = fileList.map(f => f.name)
      
      let tasksDone = 0
      let tasksTotal = 0
      try {
        const tasksMd = await window.ava.fs.readFile(`${folder}/TASKS.md`)
        const lines = tasksMd.split('\n')
        lines.forEach(line => {
          if (line.includes('[ ]') || line.includes('[x]')) {
            tasksTotal++
            if (line.includes('[x]')) tasksDone++
          }
        })
      } catch { /* TASKS.md might not exist yet */ }

      setProjectBrief({ tasksDone, tasksTotal, files })
    } catch (err) {
      console.warn('Project sync failed:', err)
    }
  }, [activeConversation?.folderPath])

  useEffect(() => {
    syncProjectContext()
  }, [syncProjectContext])

  // Real-time Preview Sync (Level 4: Design Awareness)
  useEffect(() => {
    if (!activeConversation) return
    const messages = activeConversation.messages
    if (messages.length === 0) return

    const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistantMessage) return

    const text = partsToText(lastAssistantMessage.content)
    
    // 优先匹配 ``` 块内的内容，如果没有，则匹配标签本身
    let htmlContent = ''
    const blockMatch = text.match(/```(?:html|svg)\s*([\s\S]*?)\s*```/i)
    if (blockMatch) {
      htmlContent = blockMatch[1]
    } else {
      const tagMatch = text.match(/<(html|svg)[\s\S]*?<\/\1>/i) || text.match(/<svg[\s\S]*?>[\s\S]*/i)
      if (tagMatch) htmlContent = tagMatch[0]
    }
    
    if (htmlContent) {
      // 延迟一小会儿确保预览窗口已经 Ready
      setTimeout(() => {
        window.ava.window.updatePreview(htmlContent)
      }, 500)
    }
  }, [activeConversation?.messages, activeConversation?.id])


  const toggleStt = useCallback(async () => {
    if (!state.settings.voice?.enabled) return

    if (isRecording) {
      sttClient?.stop()
      setIsRecording(false)
      setSttClient(null)
      return
    }

    try {
      const client = new STTClient(state.settings.voice.sttServerUrl)
      client.onFinalTranscript = (text) => {
        setSttText(text)
        // Reset after a short delay so the effect triggers again if the same text is spoken
        setTimeout(() => setSttText(undefined), 100)
      }
      client.onEndpoint = () => {
        client.stop()
        setIsRecording(false)
        setSttClient(null)
      }
      await client.start()
      setSttClient(client)
      setIsRecording(true)
    } catch (err) {
      console.warn('Failed to start STT:', err)
      setIsRecording(false)
    }
  }, [isRecording, sttClient, state.settings.voice])

  // Tell STT server when bot is speaking for echo cancellation
  useEffect(() => {
    if (sttClient && isStreaming) {
      sttClient.sendBotState(true)
    } else if (sttClient && !isStreaming) {
      sttClient.sendBotState(false)
    }
  }, [isStreaming, sttClient])

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

        // 🟢 流结束后，如果当前还是通用聊天状态，则尝试根据最新内容升级特性
        const currentTraits = activeConversation?.traits || ['chat']
        if (currentTraits.length === 0 || currentTraits[0] === 'chat') {
          const lastMsg = conversationSnapshot.messages[conversationSnapshot.messages.length - 1]
          const combinedText = partsToText(lastMsg.content)
          const newTraits = detectTraitsFromText(combinedText)
          if (newTraits.length > 0 && newTraits[0] !== 'chat') {
            dispatch({ type: 'SET_TRAITS', id: conversationId, traits: newTraits })
          }
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
    async (content: string, attachments: string[] = [], conversation: Conversation, commandInvocation?: CommandInvocation) => {
      const taskId = makeTaskId()
      
      // Level 3: RAG Injection
      let enrichedContent = content
      if (projectBrief) {
        const fileList = projectBrief.files.join(', ')
        const progress = projectBrief.tasksTotal > 0 ? `Progress: ${projectBrief.tasksDone}/${projectBrief.tasksTotal}` : ''
        enrichedContent = `[System Context: Active Folder "${conversation.folderPath}". Files: ${fileList}. ${progress}]\n\n${content}`
      }

      const userMsg = makeUserMessage(enrichedContent, commandInvocation, taskId, attachments)
      const placeholder = makeAssistantPlaceholder(taskId)
      const conversationId = conversation.id

      dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })

      // Auto-title from first user message
      if (conversation.messages.length === 0) {
        const title = content.length > 30 ? `${content.slice(0, 30)}…` : content
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
        
        // 🟢 首次发送或当前为通用状态时，立即识别特性
        const currentTraits = conversation.traits || ['chat']
        if (currentTraits.length === 0 || currentTraits[0] === 'chat') {
          const initialTraits = detectTraitsFromText(content)
          if (initialTraits.length > 0 && initialTraits[0] !== 'chat') {
            dispatch({ type: 'SET_TRAITS', id: conversationId, traits: initialTraits })
          }
        }
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
    (content: string, attachments?: string[], commandInvocation?: CommandInvocation) => {
      const conversation = activeConversation ?? createConversation()
      runSend(content, attachments ?? [], conversation, commandInvocation)
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

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    // Only set dragging false if we actually leave the container (not entering a child)
    if (e.currentTarget === e.target) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setDroppedFiles(files)
      // Reset after a tick to allow PromptInput to see the change
      setTimeout(() => setDroppedFiles([]), 100)
    }
  }

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
      await runSend(content, [], activeConversation, message.commandInvocation)
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
    <div 
      className="flex flex-col flex-1 min-h-0 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bg/80 backdrop-blur-sm border-2 border-dashed border-accent m-4 rounded-3xl pointer-events-none transition-all animate-in fade-in zoom-in duration-200">
          <div className="w-20 h-20 bg-accent/10 rounded-full flex items-center justify-center text-accent mb-4">
            <Upload size={32} className="animate-bounce" />
          </div>
          <div className="text-xl font-medium text-text">释放以添加文件</div>
          <div className="text-sm text-text-3 mt-1">支持图片、文档、代码等</div>
        </div>
      )}

      {/* Level 2: Project Status Bar */}
      {projectBrief && activeConversation?.folderPath && (
        <div className="mx-6 mt-4 p-2 bg-accent/5 border border-accent/10 rounded-xl flex items-center justify-between animate-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
              <FolderOpen size={16} />
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] font-medium text-text-1">Project Active: {activeConversation.folderPath.split(/[\\/]/).pop()}</span>
              <span className="text-[9px] text-text-3">{projectBrief.files.length} files detected</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {projectBrief.tasksTotal > 0 && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2 text-[9px] font-mono text-accent">
                  <span>TASKS</span>
                  <span>{projectBrief.tasksDone}/{projectBrief.tasksTotal}</span>
                </div>
                <div className="w-24 h-1 bg-white/5 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-accent transition-all duration-1000" 
                    style={{ width: `${(projectBrief.tasksDone / projectBrief.tasksTotal) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <button 
              onClick={() => syncProjectContext()}
              className="p-1.5 rounded-md hover:bg-white/5 text-text-3 hover:text-white transition-colors"
              title="Sync Project Context"
            >
              <Plus size={14} className="rotate-45" /> {/* Use as sync/refresh icon */}
            </button>
          </div>
        </div>
      )}

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
        disabledReason={!hasProvider ? '请在设置中配置并启用 LLM' : undefined}
        commands={commands}
        commandsLoading={commandsLoading}
        onRefreshCommands={refreshCommands}
        voiceEnabled={state.settings.voice?.enabled}
        isRecording={isRecording}
        onSttToggle={toggleStt}
        sttText={sttText}
        externalDroppedFiles={droppedFiles}
      />
    </div>
  )
}
