import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Upload, FolderOpen, Terminal, Code, LayoutPanelLeft, MoreHorizontal,
  FolderPlus, Archive, Trash2, X, Pin, Edit2, Copy,
  HardDrive, FileText,
} from 'lucide-react'
import { useStore } from '../store'
import { EmptyState } from './EmptyState'
import { MessageBubble } from './MessageBubble'
import { PromptInput } from './PromptInput'
import {
  makeAssistantPlaceholder,
  makeMessageId,
  makeStreamId,
  makeTaskId,
  makeUserMessage,
  partsToText,
  estimateContextUsage,
  sendChat,
} from '../lib/agent/chat'
import { getEnabledProviders } from '../lib/llm/providers'
import { STTClient } from '../lib/voiceClient'
import { detectTraitsFromText } from '../lib/agent/traits'
import type { CommandInvocation, ContentPart, Conversation, InitiativeTrait, Message, PluginCommand } from '../types'

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

interface PendingTaskIntake {
  conversationId: string
  taskId: string
  content: string
  attachments: string[]
  commandInvocation?: CommandInvocation
}

const TASK_INTAKE_INTENT_RE = /\b(build|create|make|generate|implement|fix|debug|refactor|modify|update|edit|write|add|remove|delete|site|app|component|page|feature|bug|code|html|css|javascript|typescript|react|three\.?js|3d)\b|创建|生成|实现|修复|调试|重构|修改|更新|添加|删除|网站|应用|组件|页面|功能|代码|三维|3d/i
const LARGE_TASK_INTENT_RE = /\b(3d|three\.?js|animation|animated|site|website|landing page|app|full app|project|professional|production ready|complete|responsive|dashboard|frontend|ui|ux|migrate|refactor|implement feature|create|build|generate)\b|三维|动画|网站|站点|落地页|应用|完整|专业|响应式|前端|界面|迁移|重构|项目/i
const CONFIRM_TASK_RE = /^(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run|执行|开始|继续|确认|可以|好的|好|没问题|就这样)\b/i
const MAX_AUTO_CONTINUE_ROUNDS = 3

function shouldRequireTaskIntake(content: string, commandInvocation?: CommandInvocation): boolean {
  if (commandInvocation) return true
  return TASK_INTAKE_INTENT_RE.test(content)
}

function isTaskConfirmation(content: string): boolean {
  return CONFIRM_TASK_RE.test(content.trim())
}

function makeTaskIntakeText(content: string, conversation: Conversation): string {
  const folder = conversation.folderPath || '(未关联工作目录)'
  const firstLine = content.trim().split('\n')[0]
  const isLargeTask = LARGE_TASK_INTENT_RE.test(content) || content.length > 300
  const plan = isLargeTask
    ? [
        '小步执行计划（为本地模型小上下文优化）：',
        '1. 用 project.map 获取压缩项目图，确认目录、入口、配置和关键文件。',
        '2. 初始化或补齐最小项目结构，不一次性生成过大的代码块。',
        '3. 安装/确认必要依赖。',
        '4. 分批写入核心文件：入口、样式、组件/3D 场景。',
        '5. 启动 dev server，并用 preview.console 检查运行错误。',
        '6. 用 preview.screenshot 截图检查视觉结果。',
        '7. 根据 console/screenshot 反馈修复问题，必要时重复检查。',
        '8. 运行 project.validate 或等价 build/typecheck。',
        '9. 最终报告文件改动、验证结果、剩余风险。',
      ]
    : [
        '执行计划：',
        '1. 检查相关文件/项目状态。',
        '2. 做最小必要修改。',
        '3. 运行可用验证。',
        '4. 汇报改动、验证结果、剩余风险。',
      ]
  return [
    '我先确认一下我的理解：',
    '',
    `目标：${firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine}`,
    `工作目录：${folder}`,
    '',
    ...plan,
    '',
    '完成标准：',
    '- 必须写入/修改实际项目文件，不能只在聊天里输出代码。',
    '- 需要预览的前端/3D任务必须检查 console；可截图时保存 screenshot。',
    '- 能验证就必须验证；不能验证时必须说明原因。',
    '- 没有通过验证或未完成时，不能声称完成。',
    '',
    '如果理解正确，请回复「确认」或「开始」。如果有误，请直接补充修正。',
  ].join('\n')
}

function makeConfirmedTaskPlanPrompt(content: string, conversation: Conversation): string {
  const folder = conversation.folderPath || '(no active folder)'
  const isLargeTask = LARGE_TASK_INTENT_RE.test(content) || content.length > 300
  return [
    'User confirmed the task plan. Execute it now.',
    `Task: ${content}`,
    `Working directory: ${folder}`,
    isLargeTask
      ? [
          'This is a large task for a local LLM with limited context.',
          'Use small steps. Do not try to complete the whole project in one giant response.',
          'Keep each tool round focused on the next smallest step.',
          'Recommended step order:',
          '1. project.map for compact project picture, then project.detect/file reads as needed.',
          'Do not print raw commands such as "dir"; call project.map or file.list_dir for directory inspection.',
          '2. initialize or inspect project structure.',
          '3. install/confirm dependencies.',
          '4. write files in small batches.',
          '5. devserver.start and preview.console.',
          '6. preview.screenshot for visual feedback.',
          '7. repair any console/build/visual issues.',
          '8. project.validate or equivalent build/typecheck.',
          '9. final report with changed files, validation result, and remaining risks.',
        ].join('\n')
      : [
          'Use the smallest safe workflow: inspect, edit, validate, report.',
        ].join('\n'),
    'If interrupted, continue from existing file state. Never restart from scratch unless explicitly asked.',
    'Do not mark the task complete unless validation/checks support that conclusion.',
  ].join('\n')
}

function appendLocalDelta(parts: ContentPart[], delta: string): ContentPart[] {
  const last = parts[parts.length - 1]
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + delta }]
  }
  return [...parts, { type: 'text', text: delta }]
}

function updateLocalToolPart(parts: ContentPart[], partIndex: number, partId: string | undefined, patch: Record<string, unknown>): ContentPart[] {
  return parts.map((part, idx) => {
    const isTarget = partId ? part.type === 'tool_call' && part.id === partId : idx === partIndex
    return isTarget && part.type === 'tool_call' ? { ...part, ...patch } : part
  })
}

function makeContinuationMessages(taskId: string, parts: ContentPart[], stopReason: string, round: number): Message[] {
  const assistant: Message = {
    id: makeMessageId(),
    taskId,
    role: 'assistant',
    content: parts,
    createdAt: Date.now(),
  }
  const instruction: Message = {
    id: makeMessageId(),
    taskId,
    role: 'system',
    content: [{
      type: 'text',
      text: [
        `Automatic continuation round ${round}.`,
        `Previous attempt stopped because: ${stopReason}.`,
        'Continue the same task from the existing project/file state.',
        'Do not restart from scratch and do not repeat completed work.',
        'Inspect files or run project.detect/search.ripgrep if needed, then complete the next smallest remaining step.',
        'Before final reporting on a coding/design task, validate with project.validate or an equivalent command when available.',
        'Final report must state changed files, validation result, and any unverified risk. If validation was not possible, say why.',
      ].join('\n'),
    }],
    createdAt: Date.now(),
  }
  return [assistant, instruction]
}

function stopReasonText(stopReason: string): string {
  if (stopReason === 'output_limit') return 'output token limit reached'
  if (stopReason === 'server_disconnected') return 'model server disconnected'
  if (stopReason === 'tool_loop_limit') return 'tool loop limit reached'
  if (stopReason === 'raw_command_no_tool') return 'model output raw command instead of tool call'
  return stopReason
}

function ChatSessionBar({
  conversation,
  suggestedTrait,
  onAcceptTraitSuggestion,
  onDismissTraitSuggestion,
  onOpenPreview,
  onDelete,
}: {
  conversation: Conversation | null
  suggestedTrait?: InitiativeTrait
  onAcceptTraitSuggestion?: () => void
  onDismissTraitSuggestion?: () => void
  onOpenPreview: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const { dispatch } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const menuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
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

  const startRename = () => {
    if (!conversation) return
    setRenameTitle(conversation.title)
    setRenaming(true)
    setMenuOpen(false)
  }

  const saveRename = () => {
    if (conversation && renameTitle.trim()) {
      dispatch({ type: 'RENAME_CONVERSATION', id: conversation.id, title: renameTitle.trim() })
    }
    setRenaming(false)
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

  useEffect(() => {
    if (!renaming) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renaming])

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
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameTitle}
            onChange={e => setRenameTitle(e.target.value)}
            onBlur={saveRename}
            onKeyDown={e => {
              if (e.key === 'Enter') saveRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="min-w-0 rounded-md border border-accent/40 bg-black/30 px-2 py-1 text-[13px] font-semibold text-text outline-none"
          />
        ) : (
          <div className="truncate text-[13px] font-semibold text-text">{title}</div>
        )}
        {suggestedTrait && (
          <div className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            <span>{t('chat.move_to_trait', 'Looks like {{trait}}', { trait: t(`traits.${suggestedTrait}`, suggestedTrait) })}</span>
            <button
              type="button"
              onClick={onAcceptTraitSuggestion}
              className="rounded px-1 font-medium hover:bg-accent/15"
            >
              {t('chat.move', 'Move')}
            </button>
            <button
              type="button"
              onClick={onDismissTraitSuggestion}
              className="rounded px-1 text-text-3 hover:bg-white/10 hover:text-text"
              aria-label={t('chat.dismiss', 'Dismiss')}
            >
              ×
            </button>
          </div>
        )}
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
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    startRename()
                  }}
                  className="ava-menu-item"
                >
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
                {onDelete && (
                  <button onClick={onDelete} className="ava-menu-item">
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
  const [editDraft, setEditDraft] = useState<{ messageId: string; text: string } | null>(null)
  const [traitSuggestion, setTraitSuggestion] = useState<{ conversationId: string; trait: InitiativeTrait } | null>(null)
  const [dismissedTraitSuggestions, setDismissedTraitSuggestions] = useState<Record<string, InitiativeTrait>>({})
  const [pendingTaskIntake, setPendingTaskIntake] = useState<PendingTaskIntake | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const hasProvider = useMemo(
    () => getEnabledProviders(state.settings).length > 0,
    [state.settings],
  )

  const userInitial = (state.settings.persona.userName || 'U').slice(0, 1).toUpperCase()
  const assistantInitial = (state.settings.persona.assistantName || 'A').slice(0, 1).toUpperCase()
  const projectBrief = state.projectBriefs[activeConversation?.id ?? '']
  const contextUsage = useMemo(() => {
    if (!activeConversation) return undefined
    return estimateContextUsage(
      activeConversation,
      state.settings,
      projectBrief,
      activeConversation.folderPath,
    )
  }, [activeConversation, projectBrief, state.settings])

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

  useEffect(() => {
    setEditDraft(null)
    setTraitSuggestion(null)
    setPendingTaskIntake(null)
  }, [activeConversation?.id])

  // Auto-scroll on new messages / streaming
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeConversation?.messages, isStreaming])

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
    
    // 優先匹配 ``` 塊內的內容，如果沒有，則匹配標籤本身
    let htmlContent = ''
    const blockMatch = text.match(/```(?:html|svg)\s*([\s\S]*?)\s*```/i)
    if (blockMatch) {
      htmlContent = blockMatch[1]
    } else {
      const tagMatch = text.match(/<(html|svg)[\s\S]*?<\/\1>/i) || text.match(/<svg[\s\S]*?>[\s\S]*/i)
      if (tagMatch) htmlContent = tagMatch[0]
    }
    
    if (htmlContent) {
      // 延遲一小會兒確保預覽窗口已經 Ready
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
      setIsStreaming(true)
      let currentSnapshot = conversationSnapshot
      let accumulatedParts: ContentPart[] = []
      let continuationRound = 0

      try {
        while (true) {
          const streamId = continuationRound === 0 ? id : makeStreamId()
          setStreamId(streamId)
          const result = await sendChat({
            conversation: currentSnapshot,
            settings: state.settings,
            projectBrief,
            folderPath: currentSnapshot.folderPath,
            streamId,
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
              accumulatedParts = appendLocalDelta(accumulatedParts, delta)
              dispatch({
                type: 'APPEND_DELTA',
                conversationId,
                messageId: placeholderId,
                delta,
              })
            },
            onReasoningDelta: delta => {
              dispatch({
                type: 'APPEND_REASONING_DELTA',
                conversationId,
                messageId: placeholderId,
                delta,
              })
            },
            onPart: ({ taskId, part }) => {
              if (taskId && taskId !== activeTaskId) return
              const nextPart = part.type === 'tool_call' ? { ...part, taskId: part.taskId ?? activeTaskId } : part
              accumulatedParts = [...accumulatedParts, nextPart]
              dispatch({
                type: 'ADD_PART',
                conversationId,
                messageId: placeholderId,
                part: nextPart,
              })
            },
            onPartUpdate: ({ taskId, partIndex, partId, patch }) => {
              if (taskId && taskId !== activeTaskId) return
              accumulatedParts = updateLocalToolPart(accumulatedParts, partIndex, partId, patch)
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
            if (result.stopReason) {
              if (result.stopReason !== 'raw_command_no_tool' && continuationRound < MAX_AUTO_CONTINUE_ROUNDS) {
                continuationRound += 1
                currentSnapshot = {
                  ...conversationSnapshot,
                  messages: [
                    ...currentSnapshot.messages,
                    ...makeContinuationMessages(activeTaskId, accumulatedParts, stopReasonText(result.stopReason), continuationRound),
                  ],
                }
                continue
              }

              const error =
                result.stopReason === 'output_limit'
                  ? `Stopped: output token limit reached after ${MAX_AUTO_CONTINUE_ROUNDS} automatic continuation round(s). Ava preserved current file state but could not safely finish.`
                  : result.stopReason === 'server_disconnected'
                    ? `Stopped: model server disconnected after ${MAX_AUTO_CONTINUE_ROUNDS} automatic continuation round(s).`
                    : result.stopReason === 'raw_command_no_tool'
                      ? 'Stopped: model output a raw command instead of calling a tool. Ava did not execute the plain text command; please retry or switch to a model/profile that follows tool-call format.'
                      : `Stopped: tool loop limit reached after ${MAX_AUTO_CONTINUE_ROUNDS} automatic continuation round(s).`
              dispatch({
                type: 'UPDATE_MESSAGE',
                conversationId,
                messageId: placeholderId,
                patch: { streaming: false, error, runPhase: 'error' },
              })
              return
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
          break
        }

        // After the initial message, classification changes are suggestions.
        // Category is user-owned organization, so never move sessions silently.
        const currentTraits = conversationSnapshot.traits || ['chat']
        if (conversationSnapshot.messages.length > 1) {
          const lastMsg = conversationSnapshot.messages[conversationSnapshot.messages.length - 1]
          const combinedText = partsToText(lastMsg.content)
          const newTraits = detectTraitsFromText(combinedText)
          const suggested = newTraits[0] as InitiativeTrait | undefined
          if (
            suggested &&
            suggested !== 'chat' &&
            suggested !== currentTraits[0] &&
            dismissedTraitSuggestions[conversationId] !== suggested
          ) {
            setTraitSuggestion({ conversationId, trait: suggested })
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
    [dismissedTraitSuggestions, dispatch, state.settings],
  )

  const runSend = useCallback(
    async (content: string, attachments: string[] = [], conversation: Conversation, commandInvocation?: CommandInvocation) => {
      const taskId = makeTaskId()
      const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments)
      const placeholder = makeAssistantPlaceholder(taskId)
      const conversationId = conversation.id

      dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })

      // Auto-title from first user message
      if (conversation.messages.length === 0) {
        const title = content.length > 30 ? `${content.slice(0, 30)}…` : content
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
        
        // 🟢 首次發送或當前為通用狀態時，立即識別特性
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
          messages: [...conversation.messages, userMsg],
        },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [dispatch, driveStream],
  )

  const runEditedResend = useCallback(
    async (messageId: string, content: string, attachments: string[] = [], conversation: Conversation) => {
      const idx = conversation.messages.findIndex(m => m.id === messageId)
      if (idx < 0) {
        setEditDraft(null)
        await runSend(content, attachments, conversation)
        return
      }
      const original = conversation.messages[idx]
      if (original.role !== 'user') {
        setEditDraft(null)
        await runSend(content, attachments, conversation)
        return
      }

      const nextText = content.trim()
      if (!nextText) return
      setEditDraft(null)

      const taskId = makeTaskId()
      const editedUser = makeUserMessage(nextText, original.commandInvocation, taskId, attachments)
      const conversationId = conversation.id

      if (shouldRequireTaskIntake(nextText, original.commandInvocation)) {
        const intakeMsg = makeAssistantPlaceholder(taskId)
        dispatch({
          type: 'REPLACE_MESSAGES_FROM',
          conversationId,
          fromMessageId: messageId,
          messages: [
            editedUser,
            {
              ...intakeMsg,
              content: [{ type: 'text', text: makeTaskIntakeText(nextText, conversation) }],
              streaming: false,
              runPhase: 'completed',
            },
          ],
        })
        setPendingTaskIntake({
          conversationId,
          taskId,
          content: nextText,
          attachments,
          commandInvocation: original.commandInvocation,
        })
        return
      }

      const placeholder = makeAssistantPlaceholder(taskId)

      dispatch({
        type: 'REPLACE_MESSAGES_FROM',
        conversationId,
        fromMessageId: messageId,
        messages: [editedUser, placeholder],
      })

      if (idx === 0) {
        const title = nextText.length > 30 ? `${nextText.slice(0, 30)}…` : nextText
        dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
        const traits = detectTraitsFromText(nextText)
        dispatch({ type: 'SET_TRAITS', id: conversationId, traits })
      }

      await driveStream(
        {
          ...conversation,
          messages: [...conversation.messages.slice(0, idx), editedUser],
        },
        conversationId,
        placeholder.id,
        taskId,
      )
    },
    [dispatch, driveStream, runSend],
  )

  const handleSend = useCallback(
    (content: string, attachments?: string[], commandInvocation?: CommandInvocation) => {
      const conversation = activeConversation ?? createConversation()
      if (editDraft && activeConversation) {
        runEditedResend(editDraft.messageId, content, attachments ?? [], activeConversation)
        return
      }

      if (
        pendingTaskIntake &&
        pendingTaskIntake.conversationId === conversation.id &&
        isTaskConfirmation(content)
      ) {
        const pending = pendingTaskIntake
        const placeholder = makeAssistantPlaceholder(pending.taskId)
        const confirmationContext = {
          id: `ctx_${pending.taskId}_confirmed`,
          taskId: pending.taskId,
          role: 'system' as const,
          content: [{ type: 'text' as const, text: makeConfirmedTaskPlanPrompt(pending.content, conversation) }],
          createdAt: Date.now(),
        }
        setPendingTaskIntake(null)
        dispatch({ type: 'ADD_MESSAGE', conversationId: conversation.id, message: placeholder })
        driveStream(
          { ...conversation, messages: [...conversation.messages, confirmationContext] },
          conversation.id,
          placeholder.id,
          pending.taskId,
        )
        return
      }

      if (!pendingTaskIntake && shouldRequireTaskIntake(content, commandInvocation)) {
        const taskId = makeTaskId()
        const userMsg = makeUserMessage(content, commandInvocation, taskId, attachments ?? [])
        const intakeMsg = makeAssistantPlaceholder(taskId)
        const intakeText = makeTaskIntakeText(content, conversation)
        const conversationId = conversation.id

        dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg })
        dispatch({
          type: 'ADD_MESSAGE',
          conversationId,
          message: {
            ...intakeMsg,
            content: [{ type: 'text', text: intakeText }],
            streaming: false,
            runPhase: 'completed',
          },
        })

        if (conversation.messages.length === 0) {
          const title = content.length > 30 ? `${content.slice(0, 30)}…` : content
          dispatch({ type: 'RENAME_CONVERSATION', id: conversationId, title })
          const initialTraits = detectTraitsFromText(content)
          if (initialTraits.length > 0 && initialTraits[0] !== 'chat') {
            dispatch({ type: 'SET_TRAITS', id: conversationId, traits: initialTraits })
          }
        }

        setPendingTaskIntake({
          conversationId,
          taskId,
          content,
          attachments: attachments ?? [],
          commandInvocation,
        })
        return
      }

      if (
        pendingTaskIntake &&
        pendingTaskIntake.conversationId === conversation.id &&
        !isTaskConfirmation(content)
      ) {
        setPendingTaskIntake(null)
      }

      runSend(content, attachments ?? [], conversation, commandInvocation)
    },
    [activeConversation, createConversation, dispatch, driveStream, editDraft, pendingTaskIntake, runEditedResend, runSend],
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

  const activeTraitSuggestion = traitSuggestion && traitSuggestion.conversationId === activeConversation?.id
    ? traitSuggestion.trait
    : undefined

  const acceptTraitSuggestion = useCallback(() => {
    if (!activeConversation || !activeTraitSuggestion) return
    dispatch({ type: 'SET_TRAITS', id: activeConversation.id, traits: [activeTraitSuggestion] })
    setTraitSuggestion(null)
  }, [activeConversation, activeTraitSuggestion, dispatch])

  const dismissTraitSuggestion = useCallback(() => {
    if (!activeConversation || !activeTraitSuggestion) return
    setDismissedTraitSuggestions(prev => ({ ...prev, [activeConversation.id]: activeTraitSuggestion }))
    setTraitSuggestion(null)
  }, [activeConversation, activeTraitSuggestion])

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
      const retryMessages = msgs.slice(0, idx)
      if (target.error?.includes('output token limit')) {
        retryMessages.push({
          id: `ctx_${taskId}_continue_after_output_limit`,
          taskId,
          role: 'system',
          content: [{
            type: 'text',
            text: [
              'The previous assistant attempt stopped because the output token limit was reached.',
              'Continue the same task from the existing project/file state.',
              'Do not restart from scratch and do not repeat already-written code.',
              'Inspect existing files if needed, then complete the next smallest remaining step.',
            ].join(' '),
          }],
          createdAt: Date.now(),
        })
      }
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: placeholder })

      await driveStream(
        { ...activeConversation, messages: retryMessages },
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
    (messageId: string) => {
      if (!activeConversation || isStreaming) return
      const idx = activeConversation.messages.findIndex(m => m.id === messageId)
      if (idx < 0) return
      const message = activeConversation.messages[idx]
      if (message.role !== 'user') return

      const currentText = partsToText(message.content)
      if (!currentText.trim()) return
      setEditDraft({ messageId, text: currentText })
    },
    [activeConversation, isStreaming],
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
        suggestedTrait={activeTraitSuggestion}
        onAcceptTraitSuggestion={acceptTraitSuggestion}
        onDismissTraitSuggestion={dismissTraitSuggestion}
        onOpenPreview={handleOpenPreview}
        onDelete={activeConversation ? handleDeleteConversation : undefined}
      />

      {/* Top Blur Overlay */}
      <div className="absolute top-10 left-0 right-0 h-8 z-20 pointer-events-none bg-gradient-to-b from-bg/80 via-bg/40 to-transparent backdrop-blur-md [mask-image:linear-gradient(to_bottom,black,transparent)]" />

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
          <div className="pt-4 pb-0">
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

      {/* Bottom Blur Overlay */}
      <div className="relative">
        <div className="absolute -top-8 left-0 right-0 h-8 z-20 pointer-events-none bg-gradient-to-t from-bg/80 via-bg/40 to-transparent backdrop-blur-md [mask-image:linear-gradient(to_top,black,transparent)]" />
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
          contextUsage={contextUsage}
          editDraft={editDraft ? { id: editDraft.messageId, text: editDraft.text } : undefined}
          onCancelEditDraft={() => setEditDraft(null)}
        />
      </div>
    </div>
  )
}
