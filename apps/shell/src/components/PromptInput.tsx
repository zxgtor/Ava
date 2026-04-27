import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react'
import { ListPlus, Send, Star, StopCircle, Mic, Image as ImageIcon, X, FileText, FileCode, File as FileIcon } from 'lucide-react'
import type { CommandInvocation, PluginCommand } from '../types'

interface Props {
  onSend: (content: string, attachments?: string[], commandInvocation?: CommandInvocation) => void
  onStop?: () => void
  isStreaming: boolean
  disabled?: boolean
  disabledReason?: string
  commands?: PluginCommand[]
  commandsLoading?: boolean
  onRefreshCommands?: () => void
  voiceEnabled?: boolean
  isRecording?: boolean
  onSttToggle?: () => void
  sttText?: string
  externalDroppedFiles?: File[]
}

interface Attachment {
  id: string
  name: string
  path: string
  size: number
  type: string
  url?: string
  content?: string
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
  voiceEnabled,
  isRecording,
  onSttToggle,
  sttText,
  externalDroppedFiles,
}: Props) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])

  useEffect(() => {
    if (externalDroppedFiles && externalDroppedFiles.length > 0) {
      for (const file of externalDroppedFiles) {
        addAttachment(file)
      }
    }
  }, [externalDroppedFiles])

  useEffect(() => {
    if (sttText) {
      setValue(v => {
        const trimmed = v.trim()
        return trimmed ? `${trimmed}\n${sttText}` : sttText
      })
    }
  }, [sttText])
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [selectedCommand, setSelectedCommand] = useState<PluginCommand | null>(null)
  const [commandArgs, setCommandArgs] = useState<Record<string, string>>({})
  const [recentCommandKeys, setRecentCommandKeys] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('ava.recentPluginCommands') ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  })
  const [favoriteCommandKeys, setFavoriteCommandKeys] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('ava.favoritePluginCommands') ?? '[]') as unknown
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
        const af = favoriteCommandKeys.includes(ak)
        const bf = favoriteCommandKeys.includes(bk)
        if (af !== bf) return af ? -1 : 1
        const ai = recentCommandKeys.indexOf(ak)
        const bi = recentCommandKeys.indexOf(bk)
        if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999)
        return a.name.localeCompare(b.name)
      })
  }, [commandQuery, commands, favoriteCommandKeys, recentCommandKeys])

  const submit = () => {
    let content = value.trim()
    if ((!content && attachments.length === 0) || isStreaming || disabled) return

    const images = attachments.filter(a => a.url).map(a => a.url!)
    const files = attachments.filter(a => !a.url)

    if (files.length > 0) {
      const fileBlocks = files.map(f => {
        if (f.content) {
          return `\n\n--- Attached File: ${f.name} ---\n${f.content}\n--- End of File ---`
        }
        return `\n\n[Attached File Reference: ${f.name} (${f.path})]`
      }).join('\n')
      content += fileBlocks
    }

    onSend(content, images)
    setValue('')
    setAttachments([])
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) addAttachment(file)
      }
    }
  }

  const handleDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.type.startsWith('image/')) addAttachment(file)
    }
  }

  const addAttachment = (file: File) => {
    const id = Math.random().toString(36).slice(2, 9)
    const { name, size, type } = file
    const path = (file as any).path || name

    if (type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (e) => {
        const url = e.target?.result as string
        if (url) {
          setAttachments(prev => [...prev, { id, name, size, type, path, url }])
        }
      }
      reader.readAsDataURL(file)
    } else {
      // For text files, try to read content
      const isText = type.startsWith('text/') || 
                     /\.(txt|md|js|ts|tsx|json|css|py|go|rs|c|cpp|h|sh|yml|yaml|xml)$/i.test(name)
      
      if (isText && size < 1024 * 1024) { // Limit to 1MB
        const reader = new FileReader()
        reader.onload = (e) => {
          const content = e.target?.result as string
          setAttachments(prev => [...prev, { id, name, size, type, path, content }])
        }
        reader.readAsText(file)
      } else {
        setAttachments(prev => [...prev, { id, name, size, type, path }])
      }
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
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

  const selectCommand = (command: PluginCommand) => {
    setSelectedCommand(command)
    setCommandArgs(Object.fromEntries(command.arguments.map(arg => [arg.name, arg.defaultValue ?? ''])))
    setCommandsOpen(false)
  }

  const renderCommandContent = (command: PluginCommand, args: Record<string, string>): string => {
    let rendered = command.content
    const allArgs = args.ARGUMENTS ?? Object.entries(args)
      .filter(([key]) => key !== 'ARGUMENTS')
      .map(([key, val]) => `${key}: ${val}`)
      .join('\n')
    rendered = rendered.replace(/\$ARGUMENTS/g, allArgs)
    for (const [key, val] of Object.entries(args)) {
      rendered = rendered.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), val)
    }
    return rendered.trim()
  }

  const runSelectedCommand = () => {
    if (!selectedCommand || isStreaming || disabled) return
    const missing = selectedCommand.arguments.find(arg => arg.required && !commandArgs[arg.name]?.trim())
    if (missing) return
    const command = selectedCommand
    const key = `${command.pluginId}:${command.name}`
    const block = [
      `Run plugin command: ${command.pluginName} / ${command.name}`,
      command.truncated ? '(Command file was truncated.)' : '',
      Object.keys(commandArgs).length > 0 ? 'Command arguments:' : '',
      ...Object.entries(commandArgs).map(([name, val]) => `- ${name}: ${val}`),
      '',
      renderCommandContent(command, commandArgs),
      '',
    ].filter(Boolean).join('\n')
    const content = value.trim() ? `${value.trim()}\n\n${block}` : block
    
    setRecentCommandKeys(current => {
      const next = [key, ...current.filter(item => item !== key)].slice(0, 8)
      window.localStorage.setItem('ava.recentPluginCommands', JSON.stringify(next))
      return next
    })
    setSelectedCommand(null)
    setCommandArgs({})
    onSend(content, undefined, {
      pluginId: command.pluginId,
      pluginName: command.pluginName,
      commandName: command.name,
      sourcePath: command.sourcePath,
      arguments: commandArgs,
    })
    setValue('')
    setAttachments([])
    setCommandQuery('')
  }

  const toggleFavorite = (command: PluginCommand) => {
    const key = `${command.pluginId}:${command.name}`
    setFavoriteCommandKeys(current => {
      const next = current.includes(key)
        ? current.filter(item => item !== key)
        : [key, ...current].slice(0, 24)
      window.localStorage.setItem('ava.favoritePluginCommands', JSON.stringify(next))
      return next
    })
  }

  return (
    <form
      onSubmit={handleFormSubmit}
      className="px-6 pt-2 pb-4 relative"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      {commandsOpen && (
        <div className="absolute left-6 right-6 bottom-[5.25rem] z-50 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-[#1a1b1e]/98 shadow-[0_20px_50px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
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
                <div
                  key={`${command.pluginId}:${command.name}`}
                  className="flex w-full items-center gap-2 text-left px-3 py-2 cursor-pointer hover:bg-surface-2"
                >
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      toggleFavorite(command)
                    }}
                    className={`p-1 rounded ${favoriteCommandKeys.includes(`${command.pluginId}:${command.name}`) ? 'text-warning' : 'text-text-3'}`}
                    title="收藏命令"
                  >
                    <Star size={13} fill={favoriteCommandKeys.includes(`${command.pluginId}:${command.name}`) ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    type="button"
                    onClick={() => selectCommand(command)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="text-sm text-text">{command.name}</div>
                    <div className="text-xs text-text-3 truncate">
                      {command.description || `${command.pluginName} · ${command.sourcePath}`}
                    </div>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="relative group max-w-[200px]">
              {attachment.url ? (
                <img src={attachment.url} alt="attachment" className="w-16 h-16 object-cover rounded-md border border-border-subtle" />
              ) : (
                <div className="flex items-center gap-2 p-2 bg-surface-2 border border-border-subtle rounded-md pr-6">
                  <div className="p-1.5 bg-bg rounded text-text-3">
                    {attachment.name.match(/\.(js|ts|tsx|jsx|py|go|rs|c|cpp)$/i) ? <FileCode size={16} /> : <FileText size={16} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] text-text font-medium truncate">{attachment.name}</div>
                    <div className="text-[9px] text-text-3">{(attachment.size / 1024).toFixed(1)} KB</div>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-surface-2 border border-border-subtle rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-error/10 hover:text-error hover:border-error/20"
              >
                <X size={12} />
              </button>
            </div>
          ))}
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
        {selectedCommand && (
          <div className="absolute left-6 right-6 bottom-[5.25rem] z-50 rounded-xl border border-white/10 bg-[#1a1b1e]/98 shadow-[0_20px_50px_rgba(0,0,0,0.8)] backdrop-blur-2xl p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm text-text">Run {selectedCommand.pluginName} / {selectedCommand.name}</div>
                <div className="text-xs text-text-3">{selectedCommand.description || selectedCommand.sourcePath}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCommand(null)}
                className="text-xs text-text-3 cursor-pointer hover:text-text"
              >
                Cancel
              </button>
            </div>
            {selectedCommand.arguments.length > 0 ? (
              <div className="grid grid-cols-1 gap-2">
                {selectedCommand.arguments.map(arg => (
                  <label key={arg.name} className="block">
                    <span className="block text-xs text-text-3 mb-1">
                      {arg.name}{arg.required ? ' *' : ''}{arg.description ? ` · ${arg.description}` : ''}
                    </span>
                    <input
                      value={commandArgs[arg.name] ?? ''}
                      onChange={e => setCommandArgs(prev => ({ ...prev, [arg.name]: e.target.value }))}
                      className="w-full px-3 py-1.5 text-sm text-text bg-bg border border-border-subtle rounded-md outline-none focus:border-accent/60"
                    />
                  </label>
                ))}
              </div>
            ) : (
              <div className="text-xs text-text-3">这个命令没有声明参数。</div>
            )}
            <button
              type="button"
              onClick={runSelectedCommand}
              disabled={selectedCommand.arguments.some(arg => arg.required && !commandArgs[arg.name]?.trim())}
              className="px-3 py-1.5 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Run command
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? (disabledReason ?? '请先在设置中启用 LLM 供应商') : '输入消息…  (Enter 发送 / Shift+Enter 换行，支持拖拽粘贴图片)'}
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
          <div className="flex items-center">
            {value.trim() ? (
              <button
                type="submit"
                disabled={disabled}
                className="flex-shrink-0 p-2 rounded-xl transition-colors cursor-pointer text-accent hover:bg-accent/10"
                title="发送"
              >
                <Send size={18} />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSttToggle}
                disabled={disabled || !voiceEnabled}
                className={`flex-shrink-0 p-2 rounded-xl transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  isRecording ? 'text-error bg-error/10 animate-pulse' : 'text-text-3 hover:text-text hover:bg-surface-2'
                } ${!voiceEnabled ? 'hidden' : ''}`}
                title={isRecording ? '停止录音' : '语音输入'}
              >
                <Mic size={18} />
              </button>
            )}
          </div>
        )}
      </div>
    </form>
  )
}
