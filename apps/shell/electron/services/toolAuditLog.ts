import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const AUDIT_FILE = 'tool-audit-log.json'
const MAX_ENTRIES = 500
const MAX_PREVIEW_CHARS = 4000

export interface ToolAuditCommandInvocation {
  pluginId: string
  pluginName: string
  commandName: string
  sourcePath: string
  arguments: Record<string, string>
}

export interface ToolAuditEntry {
  id: string
  createdAt: number
  streamId: string
  taskId?: string
  providerId: string
  providerName: string
  model: string
  toolCallId: string
  toolName: string
  serverId?: string
  rawToolName?: string
  pluginId?: string
  commandInvocation?: ToolAuditCommandInvocation
  args: Record<string, unknown>
  status: 'ok' | 'error' | 'aborted'
  durationMs: number
  isToolError?: boolean
  error?: string
  resultPreview?: string
}

function auditPath(): string {
  return join(app.getPath('userData'), AUDIT_FILE)
}

async function ensureDir(path: string): Promise<void> {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

async function readEntries(): Promise<ToolAuditEntry[]> {
  try {
    const text = await readFile(auditPath(), 'utf-8')
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    console.warn('[tool-audit] failed to read log:', err)
    return []
  }
}

async function writeEntries(entries: ToolAuditEntry[]): Promise<void> {
  const file = auditPath()
  await ensureDir(file)
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2), 'utf-8')
  await rename(tmp, file)
}

function isEntry(raw: unknown): raw is ToolAuditEntry {
  if (!raw || typeof raw !== 'object') return false
  const item = raw as Partial<ToolAuditEntry>
  return (
    typeof item.id === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.streamId === 'string' &&
    typeof item.providerId === 'string' &&
    typeof item.providerName === 'string' &&
    typeof item.model === 'string' &&
    typeof item.toolCallId === 'string' &&
    typeof item.toolName === 'string' &&
    typeof item.durationMs === 'number' &&
    (item.status === 'ok' || item.status === 'error' || item.status === 'aborted')
  )
}

function makeAuditId(): string {
  return `ta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function previewValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}...` : text
}

export const toolAuditLog = {
  async list(limit = 100): Promise<ToolAuditEntry[]> {
    const entries = await readEntries()
    return entries.slice(0, Math.max(1, Math.min(limit, MAX_ENTRIES)))
  },

  async append(entry: Omit<ToolAuditEntry, 'id' | 'createdAt'>): Promise<void> {
    const entries = await readEntries()
    entries.unshift({
      id: makeAuditId(),
      createdAt: Date.now(),
      ...entry,
    })
    await writeEntries(entries)
  },

  async clear(): Promise<void> {
    await writeEntries([])
  },
}
