import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Send, StopCircle, Mic, X, FileText, FileCode, TerminalSquare,
  Bug, Code2, Languages, Search, Sparkles, MessageSquareText, BookOpen,
  ShieldCheck, Wrench, FileSearch, PenLine, ListChecks,
} from 'lucide-react'
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
  editDraft?: { id: string; text: string }
  onCancelEditDraft?: () => void
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

function getCommandIcon(command: PluginCommand) {
  const text = `${command.pluginName} ${command.name} ${command.description ?? ''} ${command.sourcePath}`.toLowerCase()
  if (text.includes('debug') || text.includes('bug')) return Bug
  if (text.includes('review') || text.includes('audit')) return ShieldCheck
  if (text.includes('translate') || text.includes('language')) return Languages
  if (text.includes('search') || text.includes('find')) return Search
  if (text.includes('summar') || text.includes('compact')) return ListChecks
  if (text.includes('rewrite') || text.includes('polish') || text.includes('write')) return PenLine
  if (text.includes('explain') || text.includes('doc')) return BookOpen
  if (text.includes('code') || text.includes('develop')) return Code2
  if (text.includes('tool') || text.includes('mcp')) return Wrench
  if (text.includes('file') || text.includes('knowledge')) return FileSearch
  if (text.includes('chat') || text.includes('feedback')) return MessageSquareText
  if (text.includes('idea') || text.includes('brainstorm')) return Sparkles
  return TerminalSquare
}

function getCommandSourceLabel(command: PluginCommand) {
  return command.bundled || command.sourceKind === 'bundled' ? 'Default' : 'User'
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
  editDraft,
  onCancelEditDraft,
}: Props) {
  const { t } = useTranslation()
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
    if (!editDraft) return
    setValue(editDraft.text)
    setSelectedCommand(null)
    setCommandsOpen(false)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(editDraft.text.length, editDraft.text.length)
    })
  }, [editDraft?.id])

  useEffect(() => {
    if (sttText) {
      setValue(v => {
        const trimmed = v.trim()
        return trimmed ? `${trimmed}\n${sttText}` : sttText
      })
    }
  }, [sttText])
  const [commandsOpen, setCommandsOpen] = useState(false)
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

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [value])

  const sortedCommands = useMemo(() => {
    const query = value.startsWith('/') ? value.slice(1).trim().toLowerCase() : ''
    return commands
      .filter(command => {
        if (!query) return true
        return `${command.pluginName} ${command.name} ${command.description ?? ''} ${command.sourcePath}`.toLowerCase().includes(query)
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
  }, [commands, favoriteCommandKeys, recentCommandKeys, value])

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
      setValue('/')
      setCommandsOpen(true)
      return
    }
    if (commandsOpen && e.key === 'Escape') {
      e.preventDefault()
      setCommandsOpen(false)
      return
    }
    if (commandsOpen && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (sortedCommands[0]) selectCommand(sortedCommands[0])
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
    setValue('')
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
  }

  return (
    <form
      onSubmit={handleFormSubmit}
      className="mx-auto w-full max-w-[1400px] px-14 pt-0 pb-4 relative"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      {editDraft && (
        <div className="mb-2 flex items-center justify-between rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-accent">
          <span>{t('chat.editing_resend', 'Editing previous message. Send to regenerate from here.')}</span>
          <button
            type="button"
            onClick={() => {
              setValue('')
              onCancelEditDraft?.()
            }}
            className="rounded-md px-2 py-1 text-text-3 hover:bg-white/10 hover:text-text"
          >
            {t('chat.cancel', 'Cancel')}
          </button>
        </div>
      )}

      {commandsOpen && (
        <div className="absolute left-6 right-6 bottom-[5.25rem] z-50 max-h-80 overflow-y-auto rounded-2xl border border-white/10 bg-[#242426]/98 p-1 shadow-[0_20px_50px_rgba(0,0,0,0.75)] backdrop-blur-2xl">
          {commands.length === 0 ? (
            <div className="px-3 py-3 text-xs text-text-3">
              {commandsLoading ? t('chat.refreshing', 'Refreshing...') : t('chat.no_commands', 'No commands available. Ensure plugins are enabled.')}
            </div>
          ) : (
            <div>
              {sortedCommands.length === 0 && (
                <div className="px-3 py-3 text-xs text-text-3">{t('chat.no_matching_commands', 'No matching commands.')}</div>
              )}
              {sortedCommands.map(command => {
                const CommandIcon = getCommandIcon(command)
                const sourceLabel = getCommandSourceLabel(command)
                const isDefault = sourceLabel === 'Default'
                return (
                  <button
                    type="button"
                    key={`${command.pluginId}:${command.name}`}
                    onClick={() => selectCommand(command)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.08]"
                  >
                    <CommandIcon size={13} className="shrink-0 text-text-2" />
                    <span className="shrink-0 text-[13px] font-medium text-text">{command.name}</span>
                    <span className="min-w-0 truncate text-[12px] text-text-3">
                      {command.description || command.pluginName}
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                        isDefault
                          ? 'bg-white/[0.06] text-text-3'
                          : 'bg-accent/10 text-accent'
                      }`}
                    >
                      {sourceLabel}
                    </span>
                  </button>
                )
              })}
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
        className={`flex items-end gap-2 px-4 py-3 bg-[#252525] border border-[#333333] rounded-[24px] shadow-[rgba(10,13,18,0.1)_0px_4px_6px_-1px,rgba(10,13,18,0.06)_0px_2px_4px_-2px] transition-all duration-300 focus-within:border-accent/40 focus-within:ring-1 focus-within:ring-accent/10 focus-within:shadow-[0_0_20px_-2px_rgba(108,159,255,0.25)] ${
          disabled ? 'opacity-60' : ''
        }`}
      >
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
              <div className="text-xs text-text-3">{t('chat.no_args_declared', 'No arguments declared for this command.')}</div>
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
          onChange={e => {
            const next = e.target.value
            setValue(next)
            if (next.startsWith('/')) {
              if (!commandsOpen) onRefreshCommands?.()
              setCommandsOpen(true)
            } else {
              setCommandsOpen(false)
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? (disabledReason ?? t('chat.no_provider_error', 'Please configure LLM')) : t('chat.input_placeholder', 'Type message...')}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent resize-none outline-none text-sm text-text placeholder-text-3 py-2 px-1 max-h-[220px] overflow-hidden hide-scrollbar"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex-shrink-0 p-2 text-error rounded-xl cursor-pointer hover:bg-error/10 transition-colors"
            title={t('chat.stop_generation', 'Stop generation')}
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
                title={t('chat.send', 'Send')}
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
                title={isRecording ? t('chat.stop_recording', 'Stop recording') : t('chat.voice_input', 'Voice input')}
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
