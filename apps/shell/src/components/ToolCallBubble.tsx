import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import type { ToolCallPart } from '../types'

const STATUS_STYLES: Record<ToolCallPart['status'], string> = {
  pending: 'border-border text-text-2 bg-surface-2/60',
  running: 'border-accent/40 text-accent bg-accent/8',
  ok: 'border-success/40 text-success bg-success/8',
  error: 'border-error/40 text-error bg-error/8',
  aborted: 'border-border text-text-3 bg-surface-2/40',
}

const STATUS_LABELS: Record<ToolCallPart['status'], string> = {
  pending: '等待中',
  running: '运行中',
  ok: '完成',
  error: '失败',
  aborted: '已中断',
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function classifyError(error?: string): string | null {
  if (!error) return null
  const text = error.toLowerCase()
  if (text.includes('blocked stale filesystem tool call')) return '任务边界拦截'
  if (text.includes('allowed directories') || text.includes('not allowed') || text.includes('permission')) return '白名单/权限'
  if (text.includes('is not running') || text.includes('no such server') || text.includes('unknown tool')) return '工具服务'
  if (text.includes('aborted')) return '用户中断'
  return '工具错误'
}

function summarizeResult(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content
    if (Array.isArray(content)) return `${content.length} content part(s)`
    return `${Object.keys(value).length} field(s)`
  }
  if (value === undefined || value === null || value === '') return '(empty result)'
  return String(value).slice(0, 80)
}

export function ToolCallBubble({ part }: { part: ToolCallPart }) {
  const [open, setOpen] = useState(part.status !== 'ok')
  const argsPreview = useMemo(() => prettyJson(part.args), [part.args])
  const resultPreview = useMemo(
    () => (part.result === undefined ? '' : prettyJson(part.result)),
    [part.result],
  )
  const errorKind = classifyError(part.error)
  const shortArgs = argsPreview.length > 72 ? `${argsPreview.slice(0, 72)}…` : argsPreview
  const elapsed =
    part.startedAt && part.endedAt
      ? `${Math.max(0, part.endedAt - part.startedAt)}ms`
      : part.startedAt && part.status === 'running'
        ? 'running'
        : null

  return (
    <div className={`my-2 rounded-lg border ${STATUS_STYLES[part.status]}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left cursor-pointer"
      >
        {open ? <ChevronDown size={14} className="mt-0.5" /> : <ChevronRight size={14} className="mt-0.5" />}
        <Wrench size={14} className={`mt-0.5 flex-shrink-0 ${part.status === 'running' ? 'animate-tool-pulse' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className={`font-mono text-xs break-all ${part.status === 'aborted' ? 'line-through' : ''}`}>{part.name}</div>
          {!open && (
            <div className="mt-0.5 text-[11px] text-text-3 break-all">
              {errorKind ? `${errorKind}: ${part.error}` : shortArgs}
            </div>
          )}
        </div>
        <span className="text-[11px] whitespace-nowrap">
          {errorKind ?? STATUS_LABELS[part.status]}{elapsed ? ` · ${elapsed}` : ''}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div>
            <div className="text-[11px] text-text-3 mb-1">参数</div>
            <pre className="overflow-x-auto rounded bg-bg/70 px-2 py-2 text-[11px] leading-relaxed text-text whitespace-pre-wrap">{argsPreview}</pre>
          </div>
          {part.result !== undefined && (
            <div>
              <div className="text-[11px] text-text-3 mb-1">结果 · {summarizeResult(part.result)}</div>
              <pre className="overflow-x-auto rounded bg-bg/70 px-2 py-2 text-[11px] leading-relaxed text-text whitespace-pre-wrap">{resultPreview}</pre>
            </div>
          )}
          {part.error && (
            <div>
              <div className="text-[11px] text-text-3 mb-1">错误{errorKind ? ` · ${errorKind}` : ''}</div>
              <pre className="overflow-x-auto rounded bg-bg/70 px-2 py-2 text-[11px] leading-relaxed text-error whitespace-pre-wrap">{part.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
