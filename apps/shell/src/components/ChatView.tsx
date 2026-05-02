import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Upload, FolderOpen, Terminal, Code, LayoutPanelLeft, MoreHorizontal,
  FolderPlus, Archive, Trash2, X, Pin, Edit2, Copy, PanelRightOpen,
  GitFork, Clock3, MonitorUp, HardDrive, FileText,
} from 'lucide-react'
import { useStore } from '../store'
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

function makeProjectContextMessage(
  taskId: string,
  folderPath: string | undefined,
  brief: { files: string[]; tasksDone: number; tasksTotal: number } | undefined,
): ContentPart[] | null {
  if (!brief || !folderPath) return null
  const fileList = brief.files.join(', ')
  const progress = brief.tasksTotal > 0 ? `Progress: ${brief.tasksDone}/${brief.tasksTotal}` : ''
  return [{
    type: 'text',
    text: [
      'Project context for the current task only.',
      `Active folder: ${folderPath}`,
      `Files: ${fileList || '(none)'}`,
      progress,
      'Use this as background context. Do not repeat it unless the user asks.',
    ].filter(Boolean).join('\n'),
  }]
}

function ChatSessionBar({
  conversation,
  onOpenPreview,
  onDelete,
}: {
  conversation: Conversation | null
  onOpenPreview: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const { dispatch } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const folderPath = conversation?.folderPath
  const title = conversation?.title || t('sidebar.new_chat', 'New session')
  const primaryTrait = conversation?.traits?.[0] || 'chat'
  const canPreview = Boolean(conversation && (
    primaryTrait === 'design' ||
    primaryTrait === 'code' ||
    primaryTrait === 'video' ||
    conversation.messages.length > 0
  ))

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setMenuOpen(false)
  }

  const copyMarkdown = async () => {
    if (!conversation) return
    const markdown = [
      `# ${conversation.title}`,
      '',
      ...conversation.messages.map(message => {
        const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role
        const body = partsToText(message.content).trim()
        return `## ${label}\n\n${body || '_No text content_'}`
      }),
      '',
    ].join('\n')
    await copyText(markdown)
  }

  const handleRename = () => {
    if (!conversation) return
    const nextTitle = window.prompt(t('sidebar.rename', 'Rename'), conversation.title)
    if (nextTitle?.trim()) {
      dispatch({ type: 'RENAME_CONVERSATION', id: conversation.id, title: nextTitle.trim() })
    }
    setMenuOpen(false)
  }

  const handlePin = () => {
    if (!conversation) return
    dispatch({ type: 'TOGGLE_PIN_CONVERSATION', id: conversation.id })
    setMenuOpen(false)
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLinkFolder = async () => {
    if (!conversation) return
    setMenuOpen(false)
    const path = await window.ava.dialog.pickDirectory()
    if (path) {
      dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path })
    }
  }

  const handleUnlinkFolder = () => {
    if (!conversation) return
    setMenuOpen(false)
    dispatch({ type: 'SET_CONVERSATION_FOLDER', id: conversation.id, path: '' })
  }

  const handleArchive = () => {
    if (!conversation) return
    setMenuOpen(false)
    dispatch({ type: 'ARCHIVE_CONVERSATION', id: conversation.id })
  }

  return (
    <div className="relative z-50 flex h-10 shrink-0 items-center justify-between bg-bg/20 px-4 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="truncate text-[13px] font-semibold text-text">{title}</div>
        {conversation && (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(v => !v)}
              className="rounded p-1 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.session_actions', 'Session actions')}
            >
              <MoreHorizontal size={14} />
            </button>

            {menuOpen && (
              <div className="ava-menu absolute left-0 top-7 z-[999] w-68 py-1.5">
                <button onClick={handlePin} className="ava-menu-item">
                  <Pin size={13} className={conversation.pinned ? 'text-accent' : 'text-text-3'} fill={conversation.pinned ? 'currentColor' : 'none'} />
                  <span>{conversation.pinned ? t('sidebar.unpin', 'Unpin chat') : t('sidebar.pin', 'Pin chat')}</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+P</span>
                </button>
                <button onClick={handleRename} className="ava-menu-item">
                  <Edit2 size={13} className="text-text-3" />
                  <span>{t('sidebar.rename', 'Rename chat')}</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+R</span>
                </button>
                <button onClick={handleArchive} className="ava-menu-item">
                  <Archive size={13} className="text-text-3" />
                  <span>{t('sidebar.archive', 'Archive chat')}</span>
                  <span className="ava-menu-shortcut">Ctrl+Shift+A</span>
                </button>

                <div className="ava-menu-separator" />

                <button
                  onClick={() => folderPath && copyText(folderPath)}
                  disabled={!folderPath}
                  className="ava-menu-item disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <HardDrive size={13} className="text-text-3" />
                  <span>Copy working directory</span>
                  <span className="ava-menu-shortcut">Ctrl+Shift+C</span>
                </button>
                <button onClick={() => copyText(conversation.id)} className="ava-menu-item">
                  <Copy size={13} className="text-text-3" />
                  <span>Copy session ID</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+C</span>
                </button>
                <button onClick={() => copyText(`ava://session/${conversation.id}`)} className="ava-menu-item">
                  <Copy size={13} className="text-text-3" />
                  <span>Copy deeplink</span>
                  <span className="ava-menu-shortcut">Ctrl+Alt+L</span>
                </button>
                <button onClick={copyMarkdown} className="ava-menu-item">
                  <FileText size={13} className="text-text-3" />
                  <span>Copy as Markdown</span>
                </button>

                <div className="ava-menu-separator" />

                <button disabled className="ava-menu-item ava-menu-item-disabled">
                  <PanelRightOpen size={13} className="text-text-3" />
                  <span>Open side chat</span>
                </button>
                <button disabled className="ava-menu-item ava-menu-item-disabled">
                  <GitFork size={13} className="text-text-3" />
                  <span>Fork into local</span>
                </button>
                <button disabled className="ava-menu-item ava-menu-item-disabled">
                  <GitFork size={13} className="text-text-3" />
                  <span>Fork into new worktree</span>
                </button>
                <button disabled className="ava-menu-item ava-menu-item-disabled">
                  <Clock3 size={13} className="text-text-3" />
                  <span>Add automation...</span>
                </button>

                <div className="ava-menu-separator" />

                {folderPath ? (
                  <button onClick={handleUnlinkFolder} className="ava-menu-item">
                    <X size={13} className="text-text-3" />
                    <span>{t('sidebar.unlink_folder', 'Unlink folder')}</span>
                  </button>
                ) : (
                  <button onClick={handleLinkFolder} className="ava-menu-item">
                    <FolderPlus size={13} className="text-text-3" />
                    <span>{t('sidebar.link_folder', 'Link folder')}</span>
                  </button>
                )}
                <button disabled className="ava-menu-item ava-menu-item-disabled">
                  <MonitorUp size={13} className="text-text-3" />
                  <span>Open in mini window</span>
                </button>
                {onDelete && (
                  <button onClick={onDelete} className="ava-menu-item text-red-400 hover:bg-red-500/10 hover:text-red-300">
                    <Trash2 size={13} />
                    <span>{t('sidebar.delete', 'Delete')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {folderPath && (
          <>
            <button
              type="button"
              onClick={() => window.ava.shell.openPath(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={folderPath}
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.ava.shell.openInVSCode(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.open_code', 'Open in VS Code')}
            >
              <Code size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.ava.shell.openInTerminal(folderPath)}
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
              title={t('chat.open_terminal', 'Open in Terminal')}
            >
              <Terminal size={14} />
            </button>
          </>
        )}
        {canPreview && (
          <button
            type="button"
            onClick={onOpenPreview}
            className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-white/[0.06] hover:text-text"
            title={t('chat.open_preview', 'Open Design Preview Window')}
          >
            <LayoutPanelLeft size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export function ChatView() {
  const { t } = useTranslation()
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

  // Project Status & Context (Level 3)
  const projectBrief = state.projectBriefs[activeConversation?.id ?? '']

  const syncProjectContext = useCallback(async () => {
    if (!activeConversation) return
    if (!activeConversation.folderPath) {
      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief: null })
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

      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief: { tasksDone, tasksTotal, files } })
    } catch (err) {
      console.warn('Project sync failed:', err)
      dispatch({ type: 'SET_PROJECT_BRIEF', conversationId: activeConversation.id, brief: null })
    }
  }, [activeConversation?.folderPath, activeConversation?.id, dispatch])

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
          onStatus: ({ taskId, phase }) => {
            if (taskId && taskId !== activeTaskId) return
            dispatch({
              type: 'UPDATE_MESSAGE',
              conversationId,
              messageId: placeholderId,
              patch: { runPhase: phase },
            })
          },
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
            patch: { streaming: false, runPhase: 'completed' },
          })
        } else if (result.error === 'aborted') {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, aborted: true, runPhase: 'aborted' },
          })
        } else {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: result.error, runPhase: 'error' },
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
            patch: { streaming: false, aborted: true, runPhase: 'aborted' },
          })
        } else {
          dispatch({
            type: 'UPDATE_MESSAGE',
            conversationId,
            messageId: placeholderId,
            patch: { streaming: false, error: msg, runPhase: 'error' },
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
      
      const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments)
      const projectContext = makeProjectContextMessage(taskId, conversation.folderPath, projectBrief)
      const contextMsg = projectContext
        ? {
            id: `ctx_${taskId}`,
            taskId,
            role: 'system' as const,
            content: projectContext,
            createdAt: Date.now(),
          }
        : null
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
        {
          ...conversation,
          messages: contextMsg
            ? [...conversation.messages, contextMsg, userMsg]
            : [...conversation.messages, userMsg],
        },
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

  const handleOpenPreview = useCallback(async () => {
    await window.ava.window.openPreview(state.settings.theme)
    if (!activeConversation) return

    const lastAssistantMessage = [...activeConversation.messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistantMessage) return

    const text = partsToText(lastAssistantMessage.content)
    const htmlMatch = text.match(/```(?:html|svg)\s*([\s\S]*?)\s*```/i) ||
                      text.match(/<(html|svg)[\s\S]*?<\/\1>/i) ||
                      text.match(/<svg[\s\S]*?>[\s\S]*/i)

    if (htmlMatch) {
      const htmlContent = htmlMatch[1] || htmlMatch[0]
      setTimeout(() => {
        window.ava.window.updatePreview(htmlContent)
      }, 800)
    }
  }, [activeConversation, state.settings.theme])

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

  const handleEditResend = useCallback(
    async (messageId: string) => {
      if (!activeConversation || isStreaming) return
      const idx = activeConversation.messages.findIndex(m => m.id === messageId)
      if (idx < 0) return
      const message = activeConversation.messages[idx]
      if (message.role !== 'user') return

      const currentText = partsToText(message.content)
      const nextText = window.prompt(t('chat.edit_resend', 'Edit and resend'), currentText)
      if (!nextText?.trim() || nextText === currentText) return

      const taskId = message.taskId ?? makeTaskId()
      const editedUser = {
        ...message,
        taskId,
        content: [{ type: 'text' as const, text: nextText.trim() }],
        createdAt: Date.now(),
      }
      const conversationId = activeConversation.id

      for (const stale of activeConversation.messages.slice(idx + 1)) {
        dispatch({ type: 'DELETE_MESSAGE', conversationId, messageId: stale.id })
      }
      dispatch({
        type: 'UPDATE_MESSAGE',
        conversationId,
        messageId,
        patch: {
          taskId,
          content: editedUser.content,
          createdAt: editedUser.createdAt,
        },
      })

      if (idx === 0) {
        const title = nextText.length > 30 ? `${nextText.slice(0, 30)}…` : nextText
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
        const traits = detectTraitsFromText(nextText)
        dispatch({ type: 'SET_TRAITS', id: conversationId, traits })
      }

      const placeholder = makeAssistantPlaceholder(taskId)
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })
      await driveStream(
        {
          ...activeConversation,
          messages: [
            ...activeConversation.messages.slice(0, idx),
            editedUser,
          ],
        },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [activeConversation, dispatch, driveStream, isStreaming, t],
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
      <ChatSessionBar
        conversation={activeConversation}
        onOpenPreview={handleOpenPreview}
        onDelete={activeConversation ? handleDeleteConversation : undefined}
      />

      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bg/80 backdrop-blur-sm border-2 border-dashed border-accent m-4 rounded-3xl pointer-events-none transition-all animate-in fade-in zoom-in duration-200">
          <div className="w-20 h-20 bg-accent/10 rounded-full flex items-center justify-center text-accent mb-4">
            <Upload size={32} className="animate-bounce" />
          </div>
          <div className="text-xl font-medium text-text">{t('chat.drop_to_upload', 'Drop to upload files')}</div>
          <div className="text-sm text-text-3 mt-1">{t('chat.drop_types', 'Images, documents, code, etc.')}</div>
        </div>
      )}

      <div ref={scrollRef} className="relative z-0 flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col no-scrollbar-x">
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
                  onEditResend={!isStreaming && m.role === 'user' ? () => handleEditResend(m.id) : undefined}
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
        disabledReason={!hasProvider ? t('chat.no_provider_error', 'Please configure and enable LLM in settings') : undefined}
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
