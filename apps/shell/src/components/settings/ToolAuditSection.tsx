import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react'

type ToolAuditEntry = Awaited<ReturnType<typeof window.ava.toolAudit.list>>[number]

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ToolAuditSection() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<ToolAuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.ava.toolAudit.list(50)
      setEntries(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const clear = async () => {
    const ok = window.confirm(t('settings.audit_clear_confirm', 'Clear Tool Audit Log? This only deletes records, not conversations.'))
    if (!ok) return
    await window.ava.toolAudit.clear()
    setEntries([])
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">{t('settings.audit_title', 'Tool Audit Log')}</h2>
          <p className="text-xs text-text-3 mt-1">{t('settings.audit_desc', 'Recent 50 tool calls; used to debug why a model called a tool.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-text bg-surface border border-border-subtle rounded-full cursor-pointer hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            {t('chat.refresh', 'Refresh')}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={entries.length === 0}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-error bg-error/10 rounded-full cursor-pointer hover:bg-error/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={13} />
            {t('sidebar.delete', 'Delete')}
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="px-3 py-3 text-xs text-text-3 bg-surface border border-border-subtle rounded-lg">
          {t('settings.audit_empty', 'No tool call records yet.')}
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map(entry => {
            const open = expanded === entry.id
            return (
              <div key={entry.id} className="bg-surface border border-border-subtle rounded-lg">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : entry.id)}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left cursor-pointer"
                >
                  {open ? <ChevronDown size={14} className="mt-0.5 text-text-3" /> : <ChevronRight size={14} className="mt-0.5 text-text-3" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-text break-all">{entry.toolName}</span>
                      <span className={`px-1.5 py-0.5 text-[10px] rounded ${
                        entry.status === 'ok'
                          ? 'text-success bg-success/10'
                          : entry.status === 'aborted'
                            ? 'text-text-3 bg-surface-2'
                            : 'text-error bg-error/10'
                      }`}>
                        {entry.status}
                      </span>
                      {entry.commandInvocation && (
                        <span className="px-1.5 py-0.5 text-[10px] text-accent bg-accent/10 rounded">
                          {entry.commandInvocation.pluginName}/{entry.commandInvocation.commandName}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-3 truncate">
                      {formatTime(entry.createdAt)} · {entry.providerName} / {entry.model} · {entry.durationMs}ms
                      {entry.serverId ? ` · server ${entry.serverId}` : ''}
                      {entry.pluginId ? ` · plugin ${entry.pluginId}` : ''}
                    </div>
                  </div>
                </button>
                {open && (
                  <div className="px-3 pb-3 space-y-2">
                    <AuditField label="Task" value={entry.taskId ?? '(none)'} />
                    <AuditField label="Stream" value={entry.streamId} />
                    <AuditField label="Tool call" value={entry.toolCallId} />
                    <AuditField label="Args" value={prettyJson(entry.args)} code />
                    {entry.error && <AuditField label="Error" value={entry.error} code tone="error" />}
                    {entry.resultPreview && <AuditField label="Result preview" value={entry.resultPreview} code />}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function AuditField({
  label,
  value,
  code,
  tone,
}: {
  label: string
  value: string
  code?: boolean
  tone?: 'error'
}) {
  return (
    <div>
      <div className="text-[11px] text-text-3 mb-1">{label}</div>
      {code ? (
        <pre className={`overflow-x-auto rounded bg-bg/70 px-2 py-2 text-[11px] leading-relaxed whitespace-pre-wrap ${
          tone === 'error' ? 'text-error' : 'text-text'
        }`}>{value}</pre>
      ) : (
        <div className="text-xs text-text-2 break-all">{value}</div>
      )}
    </div>
  )
}
