import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve as resolvePath, basename, dirname } from 'node:path'

import type { McpToolDescriptor, CallToolError, CallToolResult } from './mcpSupervisor'

const MAX_OUTPUT_CHARS = 24_000
const MAX_FILE_READ_CHARS = 80_000
const MAX_DIR_ENTRIES = 500
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000

const COMMAND_ALLOWLIST = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'git',
  'python',
  'python3',
  'py',
  'tsc',
  'vite',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
])

const DANGEROUS_ARG_RE =
  /\b(rm\s+-rf|remove-item|del\s+\/s|rmdir\s+\/s|format|diskpart|shutdown|restart-computer|stop-computer|set-executionpolicy|invoke-expression|iex)\b|[;&|`$<>]/i

const SHELL_TOOL: McpToolDescriptor = {
  rawName: 'run_command',
  name: 'shell.run_command',
  description: [
    'Run a structured development command in the active project folder.',
    'Use this for npm/pnpm/yarn/node/git/python build, install, test, and scaffold tasks.',
    'Arguments must be structured; do not pass one combined shell string.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: {
        type: 'string',
        description: 'Executable name, for example npm, npx, pnpm, yarn, node, git, python, pwsh.',
      },
      args: {
        type: 'array',
        description: 'Command arguments as separate strings. Example: ["create", "vite@latest", ".", "--", "--template", "react-ts"].',
        items: { type: 'string' },
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Must be inside the active project folder or an allowed filesystem directory.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional timeout in milliseconds. Defaults to 120000, max 600000.',
      },
    },
    required: ['command', 'args', 'cwd'],
  },
}

const FILE_TOOLS: McpToolDescriptor[] = [
  {
    rawName: 'read_text',
    name: 'file.read_text',
    description: 'Read a UTF-8 text file inside the active project or allowed directories.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        maxChars: { type: 'number', description: 'Optional max characters to return. Defaults to 80000.' },
      },
      required: ['path'],
    },
  },
  {
    rawName: 'write_text',
    name: 'file.write_text',
    description: 'Write a UTF-8 text file inside the active project or allowed directories. Creates parent directories by default.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        createDirs: { type: 'boolean' },
      },
      required: ['path', 'content'],
    },
  },
  {
    rawName: 'list_dir',
    name: 'file.list_dir',
    description: 'List direct children of a directory inside the active project or allowed directories.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        maxEntries: { type: 'number', description: 'Optional max entries. Defaults to 500.' },
      },
      required: ['path'],
    },
  },
  {
    rawName: 'create_dir',
    name: 'file.create_dir',
    description: 'Create a directory inside the active project or allowed directories.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    rawName: 'stat',
    name: 'file.stat',
    description: 'Return file or directory metadata inside the active project or allowed directories.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
]

interface RunCommandArgs {
  command: string
  args: string[]
  cwd: string
  timeoutMs?: number
}

interface RunContext {
  activeFolderPath?: string
  allowedDirs?: string[]
}

interface ActiveProcess {
  child: ChildProcessWithoutNullStreams
  controller: AbortController
}

class BuiltInTools {
  private active = new Set<ActiveProcess>()

  listTools(): McpToolDescriptor[] {
    return [SHELL_TOOL, ...FILE_TOOLS]
  }

  resolveTool(name: string): { serverId: string; rawName: string } | null {
    const tool = this.listTools().find(item => item.name === name)
    return tool ? { serverId: 'builtin', rawName: tool.rawName } : null
  }

  async callTool(name: string, rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    try {
      if (name === SHELL_TOOL.name) return this.callRunCommand(rawArgs, context)
      if (name === 'file.read_text') return this.readText(rawArgs, context)
      if (name === 'file.write_text') return this.writeText(rawArgs, context)
      if (name === 'file.list_dir') return this.listDir(rawArgs, context)
      if (name === 'file.create_dir') return this.createDir(rawArgs, context)
      if (name === 'file.stat') return this.statPath(rawArgs, context)
      return { ok: false, error: `unknown built-in tool: ${name}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async callRunCommand(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseRunCommandArgs(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    const safetyError = validateRunCommand(parsed.args, context)
    if (safetyError) return { ok: false, error: safetyError }

    return this.runCommand(parsed.args)
  }

  private async readText(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const maxChars = clampNumber(rawArgs.maxChars, 1, MAX_FILE_READ_CHARS, MAX_FILE_READ_CHARS)
    const content = await readFile(parsed.path, 'utf8')
    return {
      ok: true,
      content: {
        path: resolvePath(parsed.path),
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
        chars: content.length,
      },
    }
  }

  private async writeText(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const content = typeof rawArgs.content === 'string' ? rawArgs.content : null
    if (content === null) return { ok: false, error: 'file.write_text requires "content" as a string.' }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    if (rawArgs.createDirs !== false) {
      await mkdir(dirname(resolvePath(parsed.path)), { recursive: true })
    }
    await writeFile(parsed.path, content, 'utf8')
    return {
      ok: true,
      content: {
        path: resolvePath(parsed.path),
        bytes: Buffer.byteLength(content, 'utf8'),
      },
    }
  }

  private async listDir(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const maxEntries = clampNumber(rawArgs.maxEntries, 1, MAX_DIR_ENTRIES, MAX_DIR_ENTRIES)
    const entries = await readdir(parsed.path, { withFileTypes: true })
    return {
      ok: true,
      content: {
        path: resolvePath(parsed.path),
        entries: entries.slice(0, maxEntries).map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: entries.length > maxEntries,
        count: entries.length,
      },
    }
  }

  private async createDir(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    await mkdir(parsed.path, { recursive: true })
    return { ok: true, content: { path: resolvePath(parsed.path), created: true } }
  }

  private async statPath(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const info = await stat(parsed.path)
    return {
      ok: true,
      content: {
        path: resolvePath(parsed.path),
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      },
    }
  }

  abortAllCalls(): void {
    for (const item of this.active) {
      item.controller.abort()
      try {
        item.child.kill()
      } catch {
        // noop
      }
    }
    this.active.clear()
  }

  private runCommand(args: RunCommandArgs): Promise<CallToolResult | CallToolError> {
    const startedAt = Date.now()
    const timeoutMs = clampTimeout(args.timeoutMs)
    const controller = new AbortController()

    return new Promise(resolve => {
      let stdout = ''
      let stderr = ''
      let truncated = false
      let settled = false

      const child = spawn(resolveCommand(args.command), args.args, {
        cwd: resolvePath(args.cwd),
        shell: false,
        windowsHide: true,
        env: process.env,
        signal: controller.signal,
      })
      const active: ActiveProcess = { child, controller }
      this.active.add(active)

      const timer = setTimeout(() => {
        if (settled) return
        controller.abort()
        child.kill()
      }, timeoutMs)

      const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString('utf8')
        const current = kind === 'stdout' ? stdout : stderr
        const next = current + text
        if (next.length > MAX_OUTPUT_CHARS) truncated = true
        if (kind === 'stdout') stdout = next.slice(0, MAX_OUTPUT_CHARS)
        else stderr = next.slice(0, MAX_OUTPUT_CHARS)
      }

      child.stdout.on('data', chunk => append('stdout', chunk))
      child.stderr.on('data', chunk => append('stderr', chunk))

      child.on('error', err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.active.delete(active)
        if (controller.signal.aborted) {
          resolve({ ok: false, error: 'aborted', aborted: true })
          return
        }
        resolve({ ok: false, error: err.message })
      })

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.active.delete(active)
        if (controller.signal.aborted) {
          resolve({
            ok: false,
            error: signal ? `command aborted (${signal})` : 'command aborted or timed out',
            aborted: true,
          })
          return
        }

        const content = {
          command: args.command,
          args: args.args,
          cwd: resolvePath(args.cwd),
          exitCode: code,
          signal,
          durationMs: Math.max(0, Date.now() - startedAt),
          stdout,
          stderr,
          truncated,
        }
        resolve({
          ok: true,
          content,
          isError: code !== 0,
        })
      })
    })
  }
}

function parseRunCommandArgs(raw: Record<string, unknown>): { ok: true; args: RunCommandArgs } | { ok: false; error: string } {
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const args = Array.isArray(raw.args) ? raw.args.map(String) : null
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
  const timeoutMs = typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined

  if (!command) return { ok: false, error: 'shell.run_command requires "command".' }
  if (!args) return { ok: false, error: 'shell.run_command requires "args" as an array of strings.' }
  if (!cwd) return { ok: false, error: 'shell.run_command requires "cwd".' }
  return { ok: true, args: { command, args, cwd, timeoutMs } }
}

function parsePathArg(raw: Record<string, unknown>): { ok: true; path: string } | { ok: false; error: string } {
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (!path) return { ok: false, error: 'Tool requires "path" as a string.' }
  return { ok: true, path }
}

function validateRunCommand(args: RunCommandArgs, context: RunContext): string | null {
  const commandName = normalizeCommandName(args.command)
  if (!COMMAND_ALLOWLIST.has(commandName)) {
    return `Command "${args.command}" is not allowed. Allowed commands: ${Array.from(COMMAND_ALLOWLIST).join(', ')}.`
  }
  if (!/^[A-Za-z0-9_.-]+(?:\.(?:cmd|exe))?$/i.test(args.command)) {
    return 'Command must be an executable name, not a path or shell expression.'
  }
  if (!existsSync(resolvePath(args.cwd))) {
    return `Working directory does not exist: ${args.cwd}`
  }
  if (!isAllowedCwd(args.cwd, context)) {
    return `Working directory "${args.cwd}" is outside the active project or allowed directories.`
  }
  for (const arg of args.args) {
    if (DANGEROUS_ARG_RE.test(arg)) {
      return `Blocked potentially dangerous command argument: ${arg}`
    }
  }
  return null
}

function validatePathAccess(path: string, context: RunContext): string | null {
  if (!isAllowedCwd(path, context)) {
    return `Path "${path}" is outside the active project or allowed directories.`
  }
  return null
}

function isAllowedCwd(cwd: string, context: RunContext): boolean {
  const allowedRoots = [
    context.activeFolderPath,
    ...(context.allowedDirs ?? []),
  ].filter((item): item is string => Boolean(item?.trim()))

  if (allowedRoots.length === 0) return false
  const resolvedCwd = normalizePath(resolvePath(cwd))
  return allowedRoots.some(root => {
    const resolvedRoot = normalizePath(resolvePath(root))
    return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}\\`)
  })
}

function normalizePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function normalizeCommandName(command: string): string {
  return basename(command).toLowerCase()
}

function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command
  const name = normalizeCommandName(command)
  if (name.endsWith('.exe') || name.endsWith('.cmd')) return command
  if (['npm', 'npx', 'pnpm', 'yarn'].includes(name)) return `${command}.cmd`
  return command
}

function clampTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs ?? DEFAULT_TIMEOUT_MS)) return DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(Math.floor(timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS))
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(Math.floor(value), max))
}

export const builtInTools = new BuiltInTools()
