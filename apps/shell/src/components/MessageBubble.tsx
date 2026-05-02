import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw, Trash2, Volume2, VolumeX } from 'lucide-react'
import type { ContentPart, Message } from '../types'
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
}

function StreamingDots() {
  return (
    <span className="inline-flex gap-1 ml-1 align-middle">
      <span className="w-1 h-1 rounded-full bg-text-3" style={{ animation: 'streaming-dot 1.4s ease-in-out infinite' }} />
      <span className="w-1 h-1 rounded-full bg-text-3" style={{ animation: 'streaming-dot 1.4s ease-in-out 0.15s infinite' }} />
      <span className="w-1 h-1 rounded-full bg-text-3" style={{ animation: 'streaming-dot 1.4s ease-in-out 0.3s infinite' }} />
    </span>
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

// ── Main bubble ──────────────────────────────────────────────────────

function MessageBubbleImpl({
  message,
  userInitial,
  assistantInitial,
  onDelete,
  onRetry,
  onCommandRetry,
}: Props) {
  const { t } = useTranslation()
  const { state } = useStore()
  const isUser = message.role === 'user'
  const isError = Boolean(message.error)
  const isAborted = Boolean(message.aborted)

  const [isPlaying, setIsPlaying] = useState(false)
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
    <div className={`group flex gap-3 px-6 py-3 animate-fade-in ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`flex items-center justify-center flex-shrink-0 w-8 h-8 text-sm font-medium rounded-full ${
          isUser ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-text-2'
        }`}
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
            <div className="mb-2 inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-3">
              <span className="truncate">
                Command: {message.commandInvocation.pluginName} / {message.commandInvocation.commandName}
              </span>
            </div>
          )}
          {renderParts(message.content, { isUser, isError })}
          {message.streaming && !hasVisibleContent && <span className="text-text-3">…</span>}
          {message.streaming && hasVisibleContent && <StreamingDots />}
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
        {(onDelete || onRetry || onCommandRetry || (!isUser && textLen > 0 && state.settings.voice?.enabled)) && !message.streaming && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            {!isUser && textLen > 0 && state.settings.voice?.enabled && (
              <button
                type="button"
                onClick={handlePlayTTS}
                className="p-1 text-text-3 rounded cursor-pointer hover:text-accent hover:bg-accent/10"
                title={isPlaying ? "停止朗读" : "朗读回复"}
              >
                {isPlaying ? <VolumeX size={12} className="text-accent animate-pulse" /> : <Volume2 size={12} />}
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
                className="p-1 text-text-3 rounded cursor-pointer hover:text-error hover:bg-error/10"
                title={t('sidebar.delete', 'Delete')}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleImpl)
