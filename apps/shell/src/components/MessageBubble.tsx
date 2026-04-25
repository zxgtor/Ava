import { memo, type ReactNode } from 'react'
import { RotateCw, Trash2 } from 'lucide-react'
import type { ContentPart, Message } from '../types'
import { MarkdownContent } from './MarkdownContent'
import { ToolCallBubble } from './ToolCallBubble'

interface Props {
  message: Message
  userInitial: string
  assistantInitial: string
  onDelete?: (id: string) => void
  onRetry?: () => void
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
    // tool_call
    return <ToolCallBubble key={idx} part={part} />
  })
}

// ── Main bubble ──────────────────────────────────────────────────────

function MessageBubbleImpl({ message, userInitial, assistantInitial, onDelete, onRetry }: Props) {
  const isUser = message.role === 'user'
  const isError = Boolean(message.error)
  const isAborted = Boolean(message.aborted)

  const textLen = message.content.reduce(
    (acc, p) => acc + (p.type === 'text' ? p.text.length : 0),
    0,
  )
  const hasAnyPart = message.content.length > 0
  const hasVisibleContent = textLen > 0 || hasAnyPart

  return (
    <div className={`group flex gap-3 px-6 py-3 animate-fade-in ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`flex items-center justify-center flex-shrink-0 w-8 h-8 text-sm font-medium rounded-full ${
          isUser ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-text-2'
        }`}
      >
        {isUser ? userInitial : assistantInitial}
      </div>
      <div className={`flex flex-col max-w-[75%] min-w-0 ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`relative px-4 py-2 rounded-2xl break-words text-sm leading-relaxed ${
            isUser
              ? 'bg-accent/15 text-text rounded-br-sm'
              : isError
                ? 'bg-error/15 text-error rounded-bl-sm'
                : 'bg-surface text-text rounded-bl-sm'
          } ${isAborted ? 'border border-dashed border-border' : ''}`}
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
        {(onDelete || onRetry) && !message.streaming && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-text-3 rounded cursor-pointer hover:text-accent hover:bg-accent/10"
                title="重新生成"
              >
                <RotateCw size={12} />
                重试
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(message.id)}
                className="p-1 text-text-3 rounded cursor-pointer hover:text-error hover:bg-error/10"
                title="删除消息"
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
