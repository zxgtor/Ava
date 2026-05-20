import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve as resolvePath } from 'node:path'

const CONTEXT_RESULT_LIMIT_CHARS = 30_000
const FIELD_PREVIEW_CHARS = 12_000
const NESTED_FIELD_PREVIEW_CHARS = 2_000
const MAX_COMPACT_DEPTH = 8
const EMPTY_TOOL_OUTPUT = '(tool completed with no output)'

export interface PersistedToolResultRef {
  path: string
  preview: string
  originalBytes: number
  truncated: true
  mime: 'application/json' | 'text/plain'
  createdAt: number
}

export interface CompactedToolResult {
  content: unknown
  persistedOutput?: PersistedToolResultRef
  compacted: boolean
}

export interface CompactToolResultOptions {
  activeFolderPath?: string
  streamId: string
  toolCallId: string
  toolName: string
}

export async function compactToolResultForContext(
  content: unknown,
  options: CompactToolResultOptions,
): Promise<CompactedToolResult> {
  if (content === null || content === undefined || content === '') {
    return {
      content: { message: EMPTY_TOOL_OUTPUT },
      compacted: false,
    }
  }

  const serialized = serializeToolContent(content)
  if (serialized.text.length <= CONTEXT_RESULT_LIMIT_CHARS && !hasLargeTextField(content)) {
    return { content, compacted: false }
  }

  const persistedOutput = await persistToolResult(serialized, options)
  return {
    content: compactContent(content, persistedOutput),
    persistedOutput,
    compacted: true,
  }
}

function serializeToolContent(content: unknown): { text: string; mime: 'application/json' | 'text/plain' } {
  if (typeof content === 'string') return { text: content, mime: 'text/plain' }
  return { text: safeJsonStringify(content), mime: 'application/json' }
}

async function persistToolResult(
  serialized: { text: string; mime: 'application/json' | 'text/plain' },
  options: CompactToolResultOptions,
): Promise<PersistedToolResultRef> {
  const createdAt = Date.now()
  const extension = serialized.mime === 'application/json' ? 'json' : 'txt'
  const fileName = `${sanitizeSegment(options.toolName)}-${sanitizeSegment(options.toolCallId)}-${createdAt}.${extension}`
  const baseDir = await writableToolResultBaseDir(options.activeFolderPath)
  const dir = resolvePath(baseDir, sanitizeSegment(options.streamId))
  const path = resolvePath(dir, fileName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serialized.text, 'utf8')
  return {
    path,
    preview: previewText(serialized.text, FIELD_PREVIEW_CHARS),
    originalBytes: Buffer.byteLength(serialized.text, 'utf8'),
    truncated: true,
    mime: serialized.mime,
    createdAt,
  }
}

async function writableToolResultBaseDir(activeFolderPath?: string): Promise<string> {
  const candidates = [
    process.env.APPDATA ? resolvePath(process.env.APPDATA, 'Ava', 'tool-results') : '',
    resolvePath(tmpdir(), 'ava-tool-results'),
    activeFolderPath ? resolvePath(activeFolderPath, '.ava', 'tool-results') : '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true })
      return candidate
    } catch {
      // Try the next fallback.
    }
  }
  return resolvePath(tmpdir(), 'ava-tool-results')
}

function compactContent(content: unknown, persistedOutput: PersistedToolResultRef): unknown {
  if (typeof content === 'string') {
    return {
      content: persistedOutput.preview,
      truncated: true,
      persistedOutput,
    }
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return {
      preview: persistedOutput.preview,
      truncated: true,
      persistedOutput,
    }
  }

  const output = compactNestedValue(content, 0) as Record<string, unknown>
  output.persistedOutput = persistedOutput
  output.truncated = true
  return output
}

function hasLargeTextField(content: unknown): boolean {
  return hasLargeTextFieldDeep(content, 0)
}

function hasLargeTextFieldDeep(content: unknown, depth: number): boolean {
  if (typeof content === 'string') return content.length > FIELD_PREVIEW_CHARS
  if (!content || typeof content !== 'object') return false
  if (depth >= MAX_COMPACT_DEPTH) return safeJsonStringify(content).length > FIELD_PREVIEW_CHARS
  if (Array.isArray(content)) return content.some(item => hasLargeTextFieldDeep(item, depth + 1))
  return Object.values(content as Record<string, unknown>).some(value => hasLargeTextFieldDeep(value, depth + 1))
}

function compactNestedValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > NESTED_FIELD_PREVIEW_CHARS
      ? previewText(value, NESTED_FIELD_PREVIEW_CHARS)
      : value
  }
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_COMPACT_DEPTH) {
    return {
      preview: previewText(safeJsonStringify(value), NESTED_FIELD_PREVIEW_CHARS),
      truncated: true,
    }
  }
  if (Array.isArray(value)) {
    return value.map(item => compactNestedValue(item, depth + 1))
  }

  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && child.length > NESTED_FIELD_PREVIEW_CHARS) {
      output[key] = previewText(child, NESTED_FIELD_PREVIEW_CHARS)
      output[`${key}Truncated`] = true
    } else {
      output[key] = compactNestedValue(child, depth + 1)
    }
  }
  return output
}

function previewText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.65)
  const tail = Math.max(0, limit - head)
  return [
    text.slice(0, head),
    `\n\n... [tool output truncated; full output persisted] ...\n\n`,
    text.slice(text.length - tail),
  ].join('')
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]'
      seen.add(item)
    }
    return item
  }, 2)
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'tool'
}
