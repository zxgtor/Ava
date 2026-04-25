import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ListPlus, Send, StopCircle } from 'lucide-react'
import type { PluginCommand } from '../types'

interface Props {
  onSend: (content: string) => void
  onStop?: () => void
  isStreaming: boolean
  disabled?: boolean
  disabledReason?: string
  commands?: PluginCommand[]
  commandsLoading?: boolean
  onRefreshCommands?: () => void
}

export function PromptInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
  disabledReason,
  commands = [],
  commandsLoading,
  onRefreshCommands,
}: Props) {
  const [value, setValue] = useState('')
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [recentCommandKeys, setRecentCommandKeys] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('ava.recentPluginCommands') ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  })
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [value])

  useEffect(() => {
    if (commandsOpen) window.setTimeout(() => searchRef.current?.focus(), 0)
  }, [commandsOpen])

  const sortedCommands = useMemo(() => {
    const query = commandQuery.trim().toLowerCase()
    return commands
      .filter(command => {
        if (!query) return true
        return `${command.pluginName} ${command.name} ${command.sourcePath}`.toLowerCase().includes(query)
      })
      .sort((a, b) => {
        const ak = `${a.pluginId}:${a.name}`
        const bk = `${b.pluginId}:${b.name}`
        const ai = recentCommandKeys.indexOf(ak)
        const bi = recentCommandKeys.indexOf(bk)
        if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999)
        return a.name.localeCompare(b.name)
      })
  }, [commandQuery, commands, recentCommandKeys])

  const submit = () => {
    const content = value.trim()
    if (!content || isStreaming || disabled) return
    onSend(content)
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === '/' && !value.trim() && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onRefreshCommands?.()
      setCommandsOpen(true)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const handleFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  const insertCommand = (command: PluginCommand) => {
    const key = `${command.pluginId}:${command.name}`
    const placeholders = Array.from(command.content.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g))
      .map(match => match[1])
    const hasArgumentsToken = command.content.includes('$ARGUMENTS')
    const block = [
      `Run plugin command: ${command.pluginName} / ${command.name}`,
      command.truncated ? '(Command file was truncated.)' : '',
      '',
      command.content.trim(),
      hasArgumentsToken || placeholders.length > 0 ? '\nCommand arguments:' : '',
      hasArgumentsToken ? '- $ARGUMENTS: ' : '',
      ...Array.from(new Set(placeholders)).map(name => `- ${name}: `),
      '',
    ].filter(Boolean).join('\n')
    setValue(current => current.trim() ? `${current.trim()}\n\n${block}` : block)
    setRecentCommandKeys(current => {
      const next = [key, ...current.filter(item => item !== key)].slice(0, 8)
      window.localStorage.setItem('ava.recentPluginCommands', JSON.stringify(next))
      return next
    })
    setCommandQuery('')
    setCommandsOpen(false)
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  return (
    <form
      onSubmit={handleFormSubmit}
      className="px-6 pt-2 pb-4 relative"
    >
      {commandsOpen && (
        <div className="absolute left-6 right-6 bottom-[5.25rem] z-10 max-h-72 overflow-y-auto rounded-xl border border-border-subtle bg-surface shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <div>
              <div className="text-xs font-medium text-text">Plugin Commands</div>
              <div className="text-[11px] text-text-3">输入 / 可打开；选择后会插入输入框，发送前可编辑。</div>
            </div>
            <button
              type="button"
              onClick={onRefreshCommands}
              disabled={commandsLoading}
              className="px-2 py-1 text-xs text-text-2 rounded cursor-pointer hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {commandsLoading ? '刷新中…' : 'Refresh'}
            </button>
          </div>
          <div className="px-3 py-2 border-b border-border-subtle">
            <input
              ref={searchRef}
              value={commandQuery}
              onChange={e => setCommandQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setCommandsOpen(false)
                  textareaRef.current?.focus()
                }
              }}
              placeholder="搜索 command…"
              className="w-full px-2.5 py-1.5 text-sm text-text bg-bg border border-border-subtle rounded-md outline-none focus:border-accent/60"
            />
          </div>
          {commands.length === 0 ? (
            <div className="px-3 py-3 text-xs text-text-3">
              没有可用命令。确认插件已启用，并包含 commands/*.md。
            </div>
          ) : (
            <div className="py-1">
              {sortedCommands.length === 0 && (
                <div className="px-3 py-3 text-xs text-text-3">没有匹配的命令。</div>
              )}
              {sortedCommands.map(command => (
                <button
                  key={`${command.pluginId}:${command.name}`}
                  type="button"
                  onClick={() => insertCommand(command)}
                  className="block w-full text-left px-3 py-2 cursor-pointer hover:bg-surface-2"
                >
                  <div className="text-sm text-text">{command.name}</div>
                  <div className="text-xs text-text-3 truncate">
                    {command.pluginName} · {command.sourcePath}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        className={`flex items-end gap-2 px-3 py-2 bg-surface border border-border-subtle rounded-2xl transition-colors focus-within:border-accent/60 ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => {
            onRefreshCommands?.()
            setCommandsOpen(v => !v)
          }}
          disabled={disabled || isStreaming}
          className="flex-shrink-0 p-2 text-text-2 rounded-xl cursor-pointer hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="插件命令"
        >
          <ListPlus size={18} />
        </button>
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
