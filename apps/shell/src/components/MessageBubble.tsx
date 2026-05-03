import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Copy, Edit2, RotateCw, Trash2, Brain, Wrench } from 'lucide-react'
import type { AssistantRunPhase, ContentPart, Message } from '../types'
import { MarkdownContent } from './MarkdownContent'
import { ToolCallBubble } from './ToolCallBubble'
import { useStore } from '../store'
import { playTTS } from '../lib/voiceClient'

interface Props {
  message: Message
  userInitial: string
  assistantInitial: string
  onDelete?: (id: string) => void
  onRetry?: () => void
  onCommandRetry?: () => void
  onEditResend?: (id: string) => void
}

function StreamingDots() {
  return (
    <span className="inline-flex gap-1 ml-1 align-middle" aria-label="streaming">
      <span className="w-1 h-1 rounded-full bg-text-3" style={{ animation: 'streaming-dot 1.4s ease-in-out infinite' }} />
      <span className="w-1 h-1 rounded-full bg-text-3" style={{ animation: 'streaming-dot 1.4s ease-in-out 0.15s infinite' }} />
      <span className="w-1 h-1 rounded-full bg-text-3" style={{ animation: 'streaming-dot 1.4s ease-in-out 0.3s infinite' }} />
    </span>
  )
}

function RunIndicator({ phase }: { phase?: AssistantRunPhase }) {
  if (phase === 'tool_running') {
    return (
      <span className="run-indicator run-indicator-tool" aria-label="tool running">
        <span />
        <span />
      </span>
    )
  }
  if (phase === 'fallback') {
    return (
      <span className="run-indicator run-indicator-fallback" aria-label="fallback">
        <span />
        <span />
      </span>
    )
  }
  if (phase === 'generating') {
    return <span className="run-indicator run-indicator-generating" aria-label="generating" />
  }
  if (phase === 'waiting_first_token') {
    return (
      <span className="run-indicator run-indicator-waiting" aria-label="waiting">
        <span />
        <span />
        <span />
      </span>
    )
  }
  return (
    <span className="run-indicator run-indicator-connecting" aria-label="connecting">
      <span />
    </span>
  )
}

// ── Collapsible Thinking Block ──────────────────────────────────────

/** Returns elapsed time in milliseconds. */
function useElapsedTimer(active: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    if (!active) return
    startRef.current = Date.now()
    setElapsedMs(0)
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startRef.current)
    }, 100)
    return () => window.clearInterval(interval)
  }, [active])

  return elapsedMs
}

/** Format duration: <1s shows "320ms", ≥1s shows "3s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${Math.floor(ms / 1000)}s`
}

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const elapsed = useElapsedTimer(isStreaming)
  const finalDurationRef = useRef(0)

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (!isStreaming && content) {
      finalDurationRef.current = elapsed
      const timer = window.setTimeout(() => setCollapsed(true), 400)
      return () => window.clearTimeout(timer)
    }
  }, [isStreaming, content])

  if (!content && !isStreaming) return null

  const durationMs = isStreaming ? elapsed : finalDurationRef.current
  const label = isStreaming
    ? `Thinking for ${formatDuration(durationMs)}`
    : `Thought for ${formatDuration(durationMs)}`

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="inline-flex items-center gap-1.5 text-[11px] text-text-3 hover:text-text-2 transition-colors cursor-pointer select-none"
      >
        <Brain size={12} className={isStreaming ? 'animate-pulse text-accent' : 'text-text-3'} />
        <span>{label}</span>
        <ChevronRight
          size={10}
          className={`transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}
        />
      </button>
      {!collapsed && (
        <div className="mt-1.5 pl-4 border-l-2 border-accent/20 text-[12px] text-text-3 leading-relaxed max-h-40 overflow-y-auto hide-scrollbar whitespace-pre-wrap">
          {content}
          {isStreaming && <span className="animate-pulse"> ▊</span>}
        </div>
      )}
    </div>
  )
}

function CollapsibleToolCalls({ parts, isStreaming }: { parts: ContentPart[]; isStreaming: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const elapsed = useElapsedTimer(isStreaming)
  const finalDurationRef = useRef(0)
  const toolCalls = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')

  // Auto-collapse when all tool calls are done
  const allDone = toolCalls.length > 0 && toolCalls.every(tc => tc.status === 'ok' || tc.status === 'error' || tc.status === 'aborted')

  useEffect(() => {
    if (allDone) {
      finalDurationRef.current = elapsed
      const timer = window.setTimeout(() => setCollapsed(true), 800)
      return () => window.clearTimeout(timer)
    }
  }, [allDone])

  if (toolCalls.length === 0) return null

  const durationMs = allDone ? finalDurationRef.current : elapsed
  const label = allDone
    ? `Worked for ${formatDuration(durationMs)}`
    : `Working for ${formatDuration(durationMs)}`

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="inline-flex items-center gap-1.5 text-[11px] text-text-3 hover:text-text-2 transition-colors cursor-pointer select-none"
      >
        <Wrench size={12} className={!allDone ? 'animate-spin text-accent' : 'text-text-3'} style={!allDone ? { animationDuration: '2s' } : undefined} />
        <span>{label}</span>
        <span className="text-text-3/50">({toolCalls.length} tool{toolCalls.length > 1 ? 's' : ''})</span>
        <ChevronRight
          size={10}
          className={`transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}
        />
      </button>
      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {toolCalls.map((tc, idx) => <ToolCallBubble key={idx} part={tc} />)}
        </div>
      )}
    </div>
  )
}

function renderParts(parts: ContentPart[], opts: { isUser: boolean; isError: boolean }): ReactNode[] {
  return parts.map((part, idx) => {
    if (part.type === 'text') {
      if (opts.isUser || opts.isError) {
        return (
          <span key={idx} className="whitespace-pre-wrap">
            {part.text}
          </span>
        )
      }
      if (!part.text) return <span key={idx} />
      return <MarkdownContent key={idx} content={part.text} />
    }
    if (part.type === 'image_url') {
      return (
        <div key={idx} className="my-2">
          <img src={part.image_url.url} alt="attachment" className="max-w-full max-h-64 object-contain rounded-lg border border-border-subtle" />
        </div>
      )
    }
    // tool_call
    return <ToolCallBubble key={idx} part={part} />
  })
}

function formatMessageTime(dateMs: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateMs))
}

// ── Main bubble ──────────────────────────────────────────────────────

function MessageBubbleImpl({
  message,
  userInitial,
  assistantInitial,
  onDelete,
  onRetry,
  onCommandRetry,
  onEditResend,
}: Props) {
  const { t } = useTranslation()
  const { state } = useStore()
  const isUser = message.role === 'user'
  const isError = Boolean(message.error)
  const isAborted = Boolean(message.aborted)

  const [isPlaying, setIsPlaying] = useState(false)
  const [copied, setCopied] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const hasAutoPlayed = useRef(false)
  const prevStreaming = useRef(message.streaming)

  const textContent = message.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')

  const textLen = textContent.length
  const hasAnyPart = message.content.length > 0
  const hasVisibleContent = textLen > 0 || hasAnyPart
  const hasToolCalls = message.content.some(p => p.type === 'tool_call')

  // For assistant messages: render text+image parts only (tool calls are rendered by CollapsibleToolCalls).
  // For user messages: render everything via renderParts.
  const renderTextAndImageParts = isUser
    ? renderParts(message.content, { isUser, isError })
    : renderParts(
        message.content.filter(p => p.type !== 'tool_call'),
        { isUser, isError },
      )

  const handleCopy = async () => {
    if (!textContent.trim()) return
    await navigator.clipboard.writeText(textContent)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const handlePlayTTS = async () => {
    if (!state.settings.voice?.enabled || !textContent.trim()) return
    
    if (isPlaying && audioRef.current) {
      audioRef.current.pause()
      setIsPlaying(false)
      return
    }

    setIsPlaying(true)
    const audio = await playTTS(
      textContent,
      state.settings.voice.ttsServerUrl,
      state.settings.voice.voiceId
    )
    
    if (audio) {
      audioRef.current = audio
      audio.onended = () => setIsPlaying(false)
      audio.onerror = () => setIsPlaying(false)
      audio.play().catch(() => setIsPlaying(false))
    } else {
      setIsPlaying(false)
    }
  }

  // Auto-read logic when streaming finishes
  useEffect(() => {
    if (!isUser && !message.error && !message.aborted && state.settings.voice?.enabled && state.settings.voice?.autoRead) {
      const justFinished = prevStreaming.current && !message.streaming
      if (justFinished && !hasAutoPlayed.current && textContent.trim()) {
        hasAutoPlayed.current = true
        handlePlayTTS()
      }
    }
    prevStreaming.current = message.streaming
  }, [message.streaming, isUser, message.error, message.aborted, textContent, state.settings.voice])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  return (
    <div className="mx-auto w-full max-w-[1400px] px-14">
    <div className={`group relative flex py-3 animate-fade-in ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`absolute top-3 flex items-center justify-center w-8 h-8 text-sm font-medium rounded-full ${
          isUser ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-text-2'
        } ${isUser ? '-right-11' : '-left-11'}`}
      >
        {isUser ? userInitial : assistantInitial}
      </div>
      <div className={`flex flex-col max-w-[85%] md:max-w-[75%] min-w-0 ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`relative px-4 py-2.5 rounded-2xl break-words text-sm leading-relaxed glass-bubble overflow-hidden w-fit ${
            isUser
              ? 'glass-bubble-user text-text rounded-br-sm'
              : isError
                ? 'glass-bubble-error text-error rounded-bl-sm'
                : 'glass-bubble-ai text-text rounded-bl-sm'
          } ${isAborted ? 'border border-dashed border-border opacity-80 animate-abort-flash' : ''}`}
        >
          {message.commandInvocation && (
            <div className="mb-2 inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-3 select-none">
              <span className="truncate">
                Command: {message.commandInvocation.pluginName} / {message.commandInvocation.commandName}
              </span>
            </div>
          )}
          <div className="message-selectable">
            {!isUser && message.reasoningContent && (
              <ThinkingBlock content={message.reasoningContent} isStreaming={Boolean(message.streaming)} />
            )}
            {!isUser && hasToolCalls && (
              <CollapsibleToolCalls parts={message.content} isStreaming={Boolean(message.streaming)} />
            )}
            {renderTextAndImageParts}
            {message.streaming && !hasVisibleContent && <RunIndicator phase={message.runPhase} />}
            {message.streaming && hasVisibleContent && <RunIndicator phase={message.runPhase ?? 'generating'} />}
            {isAborted && !hasVisibleContent && (
              <span className="text-text-3">（已中断，没有生成内容）</span>
            )}
            {isError && message.error && (
              <div className="mt-1 text-xs text-error/80 whitespace-pre-wrap">{message.error}</div>
            )}
            {isAborted && hasVisibleContent && (
              <div className="mt-1 text-xs text-text-3">（已中断）</div>
            )}
          </div>
        </div>
        <div className={`mt-1 flex items-center gap-1 px-1 opacity-0 transition-opacity group-hover:opacity-100 ${isUser ? 'justify-end' : 'justify-start'}`}>
          <span className="text-[10px] text-text-3 opacity-60">{formatMessageTime(message.createdAt)}</span>
          {(!message.streaming && (!isUser || onDelete || onRetry || onCommandRetry || onEditResend)) && (
            <div className="flex items-center gap-0.5">
              {!isUser && textContent.trim() && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 text-text-3 rounded cursor-pointer hover:text-accent hover:bg-accent/10"
                  title={copied ? t('chat.copied', 'Copied') : t('chat.copy', 'Copy')}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}
              {isUser && onEditResend && (
                <button
                  type="button"
                  onClick={() => onEditResend(message.id)}
                  className="p-1 text-text-3 rounded cursor-pointer hover:text-accent hover:bg-accent/10"
                  title={t('chat.edit_resend', 'Edit and resend')}
                >
                  <Edit2 size={12} />
                </button>
              )}
              {onCommandRetry && (
                <button
                  type="button"
                  onClick={onCommandRetry}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 transition-colors"
                  title="重新执行命令"
                >
                  <RotateCw size={12} />
                  重跑命令
                </button>
              )}
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 transition-colors"
                  title={t('chat.regenerate', 'Regenerate')}
                >
                  <RotateCw size={12} />
                  {t('settings.retry', 'Retry')}
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(message.id)}
                  className="p-1 text-text-3 rounded cursor-pointer hover:text-accent hover:bg-accent/10"
                  title={t('sidebar.delete', 'Delete')}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
          </div>
      </div>
    </div>
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleImpl)
