import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Send, StopCircle } from 'lucide-react'

interface Props {
  onSend: (content: string) => void
  onStop?: () => void
  isStreaming: boolean
  disabled?: boolean
  disabledReason?: string
}

export function PromptInput({ onSend, onStop, isStreaming, disabled, disabledReason }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [value])

  const submit = () => {
    const content = value.trim()
    if (!content || isStreaming || disabled) return
    onSend(content)
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const handleFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form
      onSubmit={handleFormSubmit}
      className="px-6 pt-2 pb-4"
    >
      <div
        className={`flex items-end gap-2 px-3 py-2 bg-surface border border-border-subtle rounded-2xl transition-colors focus-within:border-accent/60 ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? (disabledReason ?? '请先在设置中启用 LLM 供应商') : '输入消息…  (Enter 发送 / Shift+Enter 换行)'}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent resize-none outline-none text-sm text-text placeholder-text-3 py-2 px-1 max-h-[220px]"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex-shrink-0 p-2 text-error rounded-xl cursor-pointer hover:bg-error/10 transition-colors"
            title="停止生成"
          >
            <StopCircle size={18} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim() || disabled}
            className="flex-shrink-0 p-2 rounded-xl transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-text-3 disabled:hover:bg-transparent text-accent hover:bg-accent/10"
            title="发送"
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </form>
  )
}
