import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Copy, Edit2, RotateCw, Trash2, Brain, Wrench, Send, Film } from 'lucide-react'
import type { AssistantRunPhase, ContentPart, Message } from '../types'
import { MarkdownContent } from './MarkdownContent'
import { ToolCallBubble } from './ToolCallBubble'
import { ProjectAnalysisCard } from './ProjectAnalysisCard'
import { useStore } from '../store'
import { playTTS } from '../lib/voiceClient'
import { isSpeechEnabled } from '../lib/speechPlugin'

interface Props {
  message: Message
  userInitial: string
  assistantInitial: string
  onDelete?: (id: string) => void
  onRetry?: () => void
  onCommandRetry?: () => void
  onEditResend?: (id: string) => void
  isLast?: boolean
  onQuickReply?: (text: string) => void
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

function WorkflowPreviewCard({ preview }: { preview: NonNullable<Message['workflowPreview']> }) {
  if (preview.kind !== 'video_workflow') return null
  return (
    <div className="mb-3 rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-3 text-xs text-text select-none">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-400/15 text-cyan-200">
          <Film size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-cyan-100">{preview.title}</div>
          <div className="text-[11px] text-text-3">Output: {preview.outputTarget}</div>
        </div>
      </div>
      <div className="rounded-lg bg-surface-1/70 px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-text-3">Next</div>
        <div className="mt-1 text-[12px] text-text-2">{preview.nextStep}</div>
      </div>
      {preview.limitations.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {preview.limitations.map((item, index) => (
            <span key={`${item}-${index}`} className="rounded-full border border-border-subtle bg-surface-2/70 px-2 py-0.5 text-[10px] text-text-3">
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
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

function renderParts(parts: ContentPart[], opts: { isUser: boolean; isError: boolean; onQuickReply?: (text: string) => void }): ReactNode[] {
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
      // Strip raw Hermes-style <tool_call>…</tool_call> blocks (and trailing
      // open <tool_call> with no close) — these are the model's tool-call
      // payloads leaking into chat text. Real tool calls are rendered by
      // ToolCallBubble; the raw text version is noise that breaks markdown.
      const cleaned = part.text
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_call>[\s\S]*$/g, '')
        .trim()
      if (!cleaned) return <span key={idx} />
      return <MarkdownContent key={idx} content={cleaned} />
    }
    if (part.type === 'image_url') {
      return (
        <div key={idx} className="my-2">
          <img src={part.image_url.url} alt="attachment" className="max-w-full max-h-64 object-contain rounded-lg border border-border-subtle" />
        </div>
      )
    }
    if (part.type === 'project_analysis') {
      return <ProjectAnalysisCard key={idx} analysis={part.analysis} onQuickReply={opts.onQuickReply} />
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

function InlineReplyBox({
  placeholder,
  onSubmit,
}: {
  placeholder: string
  onSubmit?: (text: string) => void
}) {
  const [value, setValue] = useState('')
  const submit = useCallback(() => {
    const text = value.trim()
    if (!text) return
    onSubmit?.(text)
    setValue('')
  }, [onSubmit, value])

  return (
    <div className="mt-3 flex w-full min-w-[280px] max-w-xl items-center gap-2 rounded-2xl border border-border-subtle/70 bg-bg/45 px-2.5 py-2 shadow-inner shadow-black/10">
      <input
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent px-1 text-[13px] text-text outline-none placeholder:text-text-3"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!value.trim()}
        className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-bg transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40"
        title="Send"
      >
        <Send size={14} />
      </button>
    </div>
  )
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
  isLast,
  onQuickReply,
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

  const quickReplies = useMemo(() => {
    if (isUser || !isLast || message.streaming) return []
    const replies = new Set<string>()
    const sentences = textContent.split(/(?<=[.!?。！？\n])\s+/)
    const tailText = sentences.slice(-5).join(' ')
    const asksForConfirmation = /请确认是否开始|请回复[「"']?确认|回复[「"']?确认|if correct.*confirm/i.test(tailText)
    if (asksForConfirmation) return textContent.includes('请确认是否开始') ? ['确认'] : ['确认']

    // If the message looks like code / tool output / JSON, skip chip extraction
    // entirely. Otherwise [..]/"..." inside JSON, HTML, escaped strings, or raw
    // <tool_call> blocks gets mis-extracted as fake option buttons.
    const looksLikeCode =
      /```|<tool_call>|<\/?[a-z][^>]*>|\\n|\bfunction\b|\bconst\s|\blet\s|\bimport\s|\{[\s\S]*?"[^"]+"\s*:/.test(textContent)
    if (looksLikeCode) return []

    const optionSourceMatch = textContent.match(/(?:请选择一个选项|请选择|Options?|选项)\s*[:：]\s*([\s\S]+)/i)
    const optionSource = (optionSourceMatch?.[1] ?? tailText).split(/\n\s*\n/)[0]

    const asksForReply =
      /回复|输入|选择|确认|选项|请选择|请回答|请直接回答/.test(tailText) ||
      /\b(reply|type|choose|select|pick|confirm|option)\b/i.test(tailText)

    if (asksForReply) {
      // Quoted-phrase patterns: 「opt」, 『opt』, "opt", 'opt', `opt`,
      // and bracketed [opt] (commonly emitted by models for option labels).
      const quotedMatches = Array.from(optionSource.matchAll(/[「『"'`]([^」』"'\n`]{1,120})[」』"'`]/g))
      const bracketMatches = Array.from(optionSource.matchAll(/\[([^\]\n\[]{1,80})\]/g))
      const matches = [...quotedMatches, ...bracketMatches]
      const isLabelLike = (s: string) =>
        s.length >= 1 &&
        s.length <= 80 &&
        !/[\\<>{}=:/]/.test(s) &&
        !/\\n|\\t|\\r/.test(s) &&
        !/^[,;.\s]+$/.test(s)
      if (matches.length > 0) {
        for (const match of matches) {
          const option = match[1].trim()
          if (!isLabelLike(option)) continue
          if (replies.size >= 6) break
          if (option && (option.length > 1 || /[\w\u4e00-\u9fa5]/.test(option))) {
            replies.add(option)
          }
        }
      } else {
        // Fallback: if "confirm" or "确认" is present without quotes, suggest the word itself
        if (tailText.includes('确认')) replies.add('确认')
        if (tailText.toLowerCase().includes('confirm')) replies.add('Confirm')
      }
    }
    return Array.from(replies)
  }, [textContent, isUser, isLast, message.streaming])

  const inlineReply = useMemo(() => {
    if (isUser || !isLast || message.streaming) return null
    const tail = textContent.split(/(?<=[.!?。！？\n])\s+/).slice(-6).join(' ')
    const asksForInput =
      /请.*(提供|输入|回答|补充)|请直接回答|请直接输入|完整.*路径|full .*path|provide .*path|provide .*info|type .*path|enter .*path|answer .*question/i.test(tail)
    if (!asksForInput) return null
    if (/完整.*路径|full .*path|provide .*path|type .*path|enter .*path|working directory|项目路径|工作目录/i.test(tail)) {
      return 'Enter full path, e.g. D:\\Apps\\GLBViewer'
    }
    return 'Type your answer...'
  }, [isLast, isUser, message.streaming, textContent])

  // For assistant messages: render text+image parts only (tool calls are rendered by CollapsibleToolCalls).
  // For user messages: render everything via renderParts.
  const renderTextAndImageParts = isUser
    ? renderParts(message.content, { isUser, isError, onQuickReply })
    : renderParts(
        message.content.filter(p => p.type !== 'tool_call'),
        { isUser, isError, onQuickReply },
      )

  const handleCopy = async () => {
    if (!textContent.trim()) return
    await navigator.clipboard.writeText(textContent)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const handlePlayTTS = async () => {
    if (!isSpeechEnabled(state.settings) || !textContent.trim()) return
    
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
    if (!isUser && !message.error && !message.aborted && isSpeechEnabled(state.settings) && state.settings.voice?.autoRead) {
      const justFinished = prevStreaming.current && !message.streaming
      if (justFinished && !hasAutoPlayed.current && textContent.trim()) {
        hasAutoPlayed.current = true
        handlePlayTTS()
      }
    }
    prevStreaming.current = message.streaming
  }, [message.streaming, isUser, message.error, message.aborted, textContent, state.settings])

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
            {!isUser && message.taskStepTitle && (
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[11px] text-accent select-none">
                <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                <span className="truncate">Step: {message.taskStepTitle}</span>
              </div>
            )}
            {!isUser && message.workflowPreview && (
              <WorkflowPreviewCard preview={message.workflowPreview} />
            )}
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
            {quickReplies.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 pt-2 border-t border-border-subtle/50">
                {quickReplies.map((reply, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onQuickReply?.(reply)}
                    className="px-4 py-1.5 text-[12px] font-semibold text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 shadow-sm shadow-accent/5 cursor-pointer select-none"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            )}
            {inlineReply && (
              <InlineReplyBox placeholder={inlineReply} onSubmit={onQuickReply} />
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
