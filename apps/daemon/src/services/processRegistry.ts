import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

const DEFAULT_LOG_CHARS = 24_000
const DEFAULT_FINISHED_TTL_MS = 30 * 60_000

export type ProcessRunStatus = 'running' | 'exited' | 'killed' | 'error'

export interface ProcessStartArgs {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  maxLogChars?: number
}

export interface ProcessRecordView {
  id: string
  command: string
  args: string[]
  cwd: string
  pid?: number
  status: ProcessRunStatus
  startedAt: number
  endedAt?: number
  uptimeMs: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated: boolean
  error?: string
}

interface ProcessRecord {
  id: string
  command: string
  args: string[]
  cwd: string
  child: ChildProcessWithoutNullStreams
  status: ProcessRunStatus
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated: boolean
  error?: string
  maxLogChars: number
}

export class ProcessRegistry {
  private processes = new Map<string, ProcessRecord>()

  constructor(private readonly finishedTtlMs = DEFAULT_FINISHED_TTL_MS) {}

  start(input: ProcessStartArgs): ProcessRecordView {
    this.pruneFinished()
    const startedAt = Date.now()
    const child = spawn(input.command, input.args, {
      cwd: resolvePath(input.cwd),
      shell: false,
      windowsHide: true,
      env: input.env ?? process.env,
    })
    const record: ProcessRecord = {
      id: `proc_${startedAt}_${Math.random().toString(36).slice(2, 8)}`,
      command: input.command,
      args: input.args,
      cwd: resolvePath(input.cwd),
      child,
      status: 'running',
      startedAt,
      stdout: '',
      stderr: '',
      truncated: false,
      maxLogChars: input.maxLogChars ?? DEFAULT_LOG_CHARS,
    }
    this.processes.set(record.id, record)

    child.stdout.on('data', chunk => this.append(record, 'stdout', chunk))
    child.stderr.on('data', chunk => this.append(record, 'stderr', chunk))
    child.stdout.on('error', err => this.markPipeError(record, 'stdout', err))
    child.stderr.on('error', err => this.markPipeError(record, 'stderr', err))
    child.on('error', err => {
      record.status = 'error'
      record.error = err.message
      record.endedAt = Date.now()
    })
    child.on('close', (code, signal) => {
      if (record.status === 'error') {
        record.exitCode = code
        record.signal = signal
        record.endedAt = record.endedAt ?? Date.now()
        return
      }
      if (record.status === 'killed') {
        record.exitCode = code
        record.signal = signal
        record.endedAt = record.endedAt ?? Date.now()
        return
      }
      record.status = 'exited'
      record.exitCode = code
      record.signal = signal
      record.endedAt = Date.now()
    })

    return this.view(record)
  }

  get(id: string): ProcessRecordView | null {
    const record = this.processes.get(id)
    return record ? this.view(record) : null
  }

  list(cwd?: string): ProcessRecordView[] {
    this.pruneFinished()
    const normalizedCwd = cwd ? normalizePath(resolvePath(cwd)) : null
    return Array.from(this.processes.values())
      .filter(record => !normalizedCwd || normalizePath(record.cwd) === normalizedCwd)
      .map(record => this.view(record))
  }

  latest(cwd?: string): ProcessRecordView | null {
    const items = this.list(cwd)
    return items.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  }

  kill(id: string): ProcessRecordView | null {
    const record = this.processes.get(id)
    if (!record) return null
    if (record.status === 'running') {
      record.status = 'killed'
      record.endedAt = Date.now()
      try {
        record.child.kill()
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err)
      }
    }
    return this.view(record)
  }

  async wait(id: string, timeoutMs: number): Promise<ProcessRecordView | null> {
    const record = this.processes.get(id)
    if (!record) return null
    if (record.status !== 'running') return this.view(record)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (record.status !== 'running') return this.view(record)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return this.view(record)
  }

  killAll(): void {
    for (const record of this.processes.values()) {
      if (record.status === 'running') {
        record.status = 'killed'
        record.endedAt = Date.now()
        try {
          record.child.kill()
        } catch {
          // best-effort shutdown during app teardown
        }
      }
    }
  }

  private append(record: ProcessRecord, kind: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = chunk.toString('utf8')
    const next = record[kind] + text
    if (next.length > record.maxLogChars) record.truncated = true
    record[kind] = next.length > record.maxLogChars
      ? next.slice(next.length - record.maxLogChars)
      : next
  }

  private markPipeError(record: ProcessRecord, kind: 'stdout' | 'stderr', err: Error): void {
    const code = (err as NodeJS.ErrnoException).code
    const message = code === 'EPIPE'
      ? `${kind} pipe closed (EPIPE)`
      : `${kind} pipe error: ${err.message}`
    record.stderr = appendRolling(record.stderr, message, record.maxLogChars)
    if (record.status === 'running' && code !== 'EPIPE') {
      record.status = 'error'
      record.error = message
      record.endedAt = Date.now()
    }
  }

  private pruneFinished(): void {
    const cutoff = Date.now() - this.finishedTtlMs
    for (const [id, record] of this.processes.entries()) {
      if (record.status !== 'running' && (record.endedAt ?? 0) < cutoff) {
        this.processes.delete(id)
      }
    }
  }

  private view(record: ProcessRecord): ProcessRecordView {
    return {
      id: record.id,
      command: record.command,
      args: record.args,
      cwd: record.cwd,
      pid: record.child.pid,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      uptimeMs: Math.max(0, (record.endedAt ?? Date.now()) - record.startedAt),
      exitCode: record.exitCode,
      signal: record.signal,
      stdout: record.stdout,
      stderr: record.stderr,
      truncated: record.truncated,
      error: record.error,
    }
  }
}

function normalizePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export const processRegistry = new ProcessRegistry()

function appendRolling(current: string, text: string, maxChars: number): string {
  const next = current ? `${current}\n${text}` : text
  return next.length > maxChars ? next.slice(next.length - maxChars) : next
}
