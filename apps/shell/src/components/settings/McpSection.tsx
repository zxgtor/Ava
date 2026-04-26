import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import type { McpServerConfig, Settings } from '../../types'
import { Toggle } from './shared'

export function McpSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const [runtime, setRuntime] = useState<Record<string, Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]>>({})

  useEffect(() => {
    window.ava.mcp.listServers()
      .then(list => setRuntime(Object.fromEntries(list.map(item => [item.id, item]))))
      .catch(() => { /* noop */ })
    const off = window.ava.mcp.onStatus(server => {
      setRuntime(prev => ({ ...prev, [server.id]: server }))
    })
    return off
  }, [])

  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">MCP Servers</h2>
      <div className="space-y-2">
        {settings.mcpServers.map(server => (
          <McpServerRow
            key={server.id}
            server={server}
            runtime={runtime[server.id]}
            onChange={next => update(s => ({
              ...s,
              mcpServers: s.mcpServers.map(item => (item.id === server.id ? next : item)),
            }))}
          />
        ))}
      </div>
    </section>
  )
}

function McpServerRow({
  server,
  runtime,
  onChange,
}: {
  server: McpServerConfig
  runtime?: Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]
  onChange: (next: McpServerConfig) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const addDirectory = async () => {
    const dir = await window.ava.dialog.pickDirectory()
    if (!dir) return
    const current = new Set(server.allowedDirs ?? [])
    current.add(dir)
    onChange({ ...server, allowedDirs: Array.from(current) })
  }

  const removeDirectory = (dir: string) => {
    onChange({
      ...server,
      allowedDirs: (server.allowedDirs ?? []).filter(item => item !== dir),
    })
  }

  const restart = async () => {
    setRestarting(true)
    try {
      await window.ava.mcp.restart(server.id)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="bg-surface border border-border-subtle rounded-lg">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-text-3 cursor-pointer hover:text-text-2"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text">{server.name}</span>
            {runtime?.status && (
              <span className="px-1.5 py-0.5 text-[10px] text-text-3 bg-surface-2 rounded">
                {runtime.status}
              </span>
            )}
          </div>
          <div className="text-xs text-text-3 truncate">{server.command} {(server.args ?? []).join(' ')}</div>
        </div>
        <Toggle
          value={server.enabled}
          onChange={v => onChange({ ...server, enabled: v })}
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border-subtle">
          <div>
            <div className="text-xs text-text-3 mb-1">允许目录</div>
            <div className="flex flex-wrap gap-2">
              {(server.allowedDirs ?? []).map(dir => (
                <span key={dir} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-surface-2 rounded-full text-text-2">
                  <span className="max-w-[24rem] truncate" title={dir}>{dir}</span>
                  <button
                    type="button"
                    onClick={() => removeDirectory(dir)}
                    className="cursor-pointer text-text-3 hover:text-error"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {(server.allowedDirs ?? []).length === 0 && (
                <span className="text-xs text-text-3">还没有白名单目录</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addDirectory}
              className="px-2.5 py-1 text-xs text-accent bg-accent/10 rounded-full cursor-pointer hover:bg-accent/20"
            >
              + Add directory
            </button>
            <button
              type="button"
              onClick={restart}
              disabled={restarting}
              className="px-2.5 py-1 text-xs text-text bg-surface-2 rounded-full cursor-pointer hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {restarting ? '重启中…' : 'Restart'}
            </button>
            <span className="text-xs text-text-3">
              {runtime?.status === 'running'
                ? `运行中 · ${(runtime.tools ?? []).length} 个工具`
                : runtime?.lastError ?? '未运行'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
