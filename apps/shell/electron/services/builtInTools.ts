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
  'rg',
  'python',
  'python3',
  'py',
  'dotnet',
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

const CODING_TOOLS: McpToolDescriptor[] = [
  {
    rawName: 'detect',
    name: 'project.detect',
    description: 'Detect project type, package manager, scripts, and recommended validation commands for a coding task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Project directory to inspect.' },
      },
      required: ['cwd'],
    },
  },
  {
    rawName: 'validate',
    name: 'project.validate',
    description: 'Run the safest detected validation commands for the project, such as typecheck/build/test.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Project directory to validate.' },
        level: { type: 'string', enum: ['quick', 'full'], description: 'quick runs typecheck/build; full may also run tests.' },
        timeoutMs: { type: 'number' },
      },
      required: ['cwd'],
    },
  },
  {
    rawName: 'ripgrep',
    name: 'search.ripgrep',
    description: 'Search text in project files with ripgrep. Results are scoped to the active project or allowed directories.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        query: { type: 'string' },
        glob: { type: 'string', description: 'Optional file glob, for example **/*.ts.' },
        maxMatches: { type: 'number' },
      },
      required: ['cwd', 'query'],
    },
  },
  {
    rawName: 'patch',
    name: 'file.patch',
    description: 'Patch a text file by replacing exact oldText with newText. Safer than overwriting the whole file for focused edits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        expectedReplacements: { type: 'number', description: 'Defaults to 1.' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    rawName: 'status',
    name: 'git.status',
    description: 'Read-only git status for the active project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
      },
      required: ['cwd'],
    },
  },
  {
    rawName: 'diff',
    name: 'git.diff',
    description: 'Read-only git diff for the active project. Output is truncated for context safety.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        path: { type: 'string', description: 'Optional project-relative path.' },
        staged: { type: 'boolean' },
      },
      required: ['cwd'],
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

interface DetectedProject {
  cwd: string
  types: string[]
  packageManager?: string
  scripts?: Record<string, string>
  validationCommands: Array<{ command: string; args: string[]; reason: string }>
  files: string[]
}

class BuiltInTools {
  private active = new Set<ActiveProcess>()

  listTools(): McpToolDescriptor[] {
    return [SHELL_TOOL, ...FILE_TOOLS, ...CODING_TOOLS]
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
      if (name === 'file.patch') return this.patchFile(rawArgs, context)
      if (name === 'project.detect') return this.detectProject(rawArgs, context)
      if (name === 'project.validate') return this.validateProject(rawArgs, context)
      if (name === 'search.ripgrep') return this.ripgrep(rawArgs, context)
      if (name === 'git.status') return this.gitStatus(rawArgs, context)
      if (name === 'git.diff') return this.gitDiff(rawArgs, context)
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

  private async patchFile(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const oldText = typeof rawArgs.oldText === 'string' ? rawArgs.oldText : null
    const newText = typeof rawArgs.newText === 'string' ? rawArgs.newText : null
    if (oldText === null) return { ok: false, error: 'file.patch requires "oldText" as a string.' }
    if (newText === null) return { ok: false, error: 'file.patch requires "newText" as a string.' }
    if (!oldText) return { ok: false, error: 'file.patch oldText cannot be empty.' }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const expected = clampNumber(rawArgs.expectedReplacements, 1, 1000, 1)
    const content = await readFile(parsed.path, 'utf8')
    const count = content.split(oldText).length - 1
    if (count !== expected) {
      return {
        ok: false,
        error: `file.patch expected ${expected} replacement(s), found ${count}. Read the file and use a more precise oldText.`,
      }
    }
    const next = content.split(oldText).join(newText)
    await writeFile(parsed.path, next, 'utf8')
    return {
      ok: true,
      content: {
        path: resolvePath(parsed.path),
        replacements: count,
        bytes: Buffer.byteLength(next, 'utf8'),
      },
    }
  }

  private async detectProject(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseCwdArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDirectoryAccess(parsed.cwd, context)
    if (guard) return { ok: false, error: guard }

    const detected = await detectProject(parsed.cwd)
    return { ok: true, content: detected }
  }

  private async validateProject(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseCwdArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDirectoryAccess(parsed.cwd, context)
    if (guard) return { ok: false, error: guard }

    const level = rawArgs.level === 'full' ? 'full' : 'quick'
    const timeoutMs = clampTimeout(typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : DEFAULT_TIMEOUT_MS)
    const detected = await detectProject(parsed.cwd)
    const commands = validationCommands(detected, level, timeoutMs)
    if (commands.length === 0) {
      return {
        ok: true,
        content: {
          cwd: resolvePath(parsed.cwd),
          detected,
          commands: [],
          message: 'No safe validation command detected.',
        },
      }
    }

    const results: unknown[] = []
    let failed = false
    for (const command of commands) {
      const result = await this.runCommand(command)
      if (!result.ok) return result
      results.push(result.content)
      if (result.isError) {
        failed = true
        break
      }
    }

    return {
      ok: true,
      isError: failed,
      content: {
        cwd: resolvePath(parsed.cwd),
        detected,
        level,
        results,
      },
    }
  }

  private async ripgrep(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseCwdArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDirectoryAccess(parsed.cwd, context)
    if (guard) return { ok: false, error: guard }

    const query = typeof rawArgs.query === 'string' ? rawArgs.query : ''
    if (!query.trim()) return { ok: false, error: 'search.ripgrep requires "query".' }
    if (query.length > 500 || /[\r\n]/.test(query)) return { ok: false, error: 'search.ripgrep query is too long or contains newlines.' }
    const maxMatches = clampNumber(rawArgs.maxMatches, 1, 200, 80)
    const args = ['--line-number', '--column', '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**', '--max-count', String(maxMatches)]
    if (typeof rawArgs.glob === 'string' && rawArgs.glob.trim()) {
      args.push('--glob', rawArgs.glob.trim())
    }
    args.push(query, '.')

    const result = await this.runCommand({
      command: 'rg',
      args,
      cwd: parsed.cwd,
      timeoutMs: 30_000,
    })
    if (result.ok && result.isError && isRipgrepNoMatch(result.content)) {
      return {
        ok: true,
        content: {
          cwd: resolvePath(parsed.cwd),
          query,
          stdout: '',
          stderr: '',
          matches: 0,
        },
      }
    }
    return result
  }

  private async gitStatus(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseCwdArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDirectoryAccess(parsed.cwd, context)
    if (guard) return { ok: false, error: guard }
    return this.runCommand({
      command: 'git',
      args: ['status', '--short', '--branch'],
      cwd: parsed.cwd,
      timeoutMs: 30_000,
    })
  }

  private async gitDiff(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseCwdArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDirectoryAccess(parsed.cwd, context)
    if (guard) return { ok: false, error: guard }

    const args = ['diff', '--no-ext-diff']
    if (rawArgs.staged === true) args.push('--cached')
    if (typeof rawArgs.path === 'string' && rawArgs.path.trim()) {
      if (rawArgs.path.includes('..')) return { ok: false, error: 'git.diff path must be project-relative and cannot contain "..".' }
      args.push('--', rawArgs.path.trim())
    }
    return this.runCommand({
      command: 'git',
      args,
      cwd: parsed.cwd,
      timeoutMs: 30_000,
    })
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

      const resolvedCommand = resolveCommand(args.command)
      const spawnTarget = spawnTargetForCommand(resolvedCommand, args.args)
      const child = spawn(spawnTarget.command, spawnTarget.args, {
        cwd: resolvePath(args.cwd),
        shell: false,
        windowsHide: true,
        env: process.env,
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

function parseCwdArg(raw: Record<string, unknown>): { ok: true; cwd: string } | { ok: false; error: string } {
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
  if (!cwd) return { ok: false, error: 'Tool requires "cwd" as a string.' }
  return { ok: true, cwd }
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

function validateDirectoryAccess(path: string, context: RunContext): string | null {
  if (!existsSync(resolvePath(path))) return `Directory does not exist: ${path}`
  return validatePathAccess(path, context)
}

async function detectProject(cwd: string): Promise<DetectedProject> {
  const root = resolvePath(cwd)
  const files = await safeReaddirNames(root)
  const types: string[] = []
  let scripts: Record<string, string> | undefined
  let packageManager: string | undefined

  if (files.includes('package.json')) {
    types.push('node')
    const pkg = await readJsonFile(resolvePath(root, 'package.json'))
    if (pkg && typeof pkg === 'object' && 'scripts' in pkg && isRecord((pkg as Record<string, unknown>).scripts)) {
      scripts = Object.fromEntries(
        Object.entries((pkg as { scripts: Record<string, unknown> }).scripts)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    }
    packageManager = files.includes('pnpm-lock.yaml')
      ? 'pnpm'
      : files.includes('yarn.lock')
        ? 'yarn'
        : 'npm'
    const deps = {
      ...(isRecord((pkg as Record<string, unknown> | null)?.dependencies) ? (pkg as { dependencies: Record<string, unknown> }).dependencies : {}),
      ...(isRecord((pkg as Record<string, unknown> | null)?.devDependencies) ? (pkg as { devDependencies: Record<string, unknown> }).devDependencies : {}),
    }
    if ('vite' in deps) types.push('vite')
    if ('react' in deps) types.push('react')
    if ('next' in deps) types.push('next')
  }
  if (files.includes('pyproject.toml') || files.includes('requirements.txt') || files.some(file => file.endsWith('.py'))) {
    types.push('python')
  }
  if (files.some(file => file.endsWith('.csproj')) || files.some(file => file.endsWith('.sln'))) {
    types.push('dotnet')
  }

  const detected: DetectedProject = {
    cwd: root,
    types: Array.from(new Set(types)),
    packageManager,
    scripts,
    validationCommands: [],
    files,
  }
  detected.validationCommands = validationCommands(detected, 'quick', DEFAULT_TIMEOUT_MS).map(command => ({
    command: command.command,
    args: command.args,
    reason: validationReason(command),
  }))
  return detected
}

function validationCommands(project: DetectedProject, level: 'quick' | 'full', timeoutMs: number): RunCommandArgs[] {
  const commands: RunCommandArgs[] = []
  const pm = project.packageManager ?? 'npm'
  const runArgs = pm === 'yarn' ? ['run'] : ['run']
  const scripts = project.scripts ?? {}

  if (project.types.includes('node')) {
    if (scripts.typecheck) commands.push({ command: pm, args: [...runArgs, 'typecheck'], cwd: project.cwd, timeoutMs })
    if (scripts.lint && level === 'full') commands.push({ command: pm, args: [...runArgs, 'lint'], cwd: project.cwd, timeoutMs })
    if (scripts.build) commands.push({ command: pm, args: [...runArgs, 'build'], cwd: project.cwd, timeoutMs })
    if (scripts.test && level === 'full') commands.push({ command: pm, args: [...runArgs, 'test'], cwd: project.cwd, timeoutMs })
  }
  if (project.types.includes('python') && level === 'full') {
    commands.push({ command: 'python', args: ['-m', 'pytest'], cwd: project.cwd, timeoutMs })
  }
  if (project.types.includes('dotnet')) {
    commands.push({ command: 'dotnet', args: ['build'], cwd: project.cwd, timeoutMs })
    if (level === 'full') commands.push({ command: 'dotnet', args: ['test', '--no-build'], cwd: project.cwd, timeoutMs })
  }
  return commands
}

function validationReason(command: RunCommandArgs): string {
  return `${command.command} ${command.args.join(' ')}`
}

async function safeReaddirNames(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isRipgrepNoMatch(content: unknown): boolean {
  return isRecord(content) && content.exitCode === 1 && typeof content.stdout === 'string' && content.stdout.length === 0
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

function spawnTargetForCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const name = normalizeCommandName(command)
  if (!name.endsWith('.cmd') && !name.endsWith('.bat')) return { command, args }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args.map(quoteWindowsCmdArg)].join(' ')],
  }
}

function quoteWindowsCmdArg(value: string): string {
  if (!/\s/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
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
