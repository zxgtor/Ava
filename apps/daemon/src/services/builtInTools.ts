import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve as resolvePath, basename, dirname } from 'node:path'

import type { McpToolDescriptor, CallToolError, CallToolResult } from './mcpSupervisor'
import { COMMAND_ALLOWLIST, DEVSERVER_COMMAND_ALLOWLIST } from './runtimeEnvironment'
import { processRegistry, type ProcessRecordView } from './processRegistry'

// Bundled ripgrep — works regardless of whether the user has `rg` on PATH.
// Resolved lazily so a missing/corrupt install surfaces as a clear error
// instead of crashing the main process at import time.
let cachedRgPath: string | null | undefined
function resolveBundledRgPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@vscode/ripgrep') as { rgPath?: string }
    cachedRgPath = mod.rgPath && existsSync(mod.rgPath) ? mod.rgPath : null
  } catch {
    cachedRgPath = null
  }
  return cachedRgPath
}

const MAX_OUTPUT_CHARS = 24_000
const MAX_DEVSERVER_LOG_CHARS = 12_000
const MAX_FILE_READ_CHARS = 80_000
const MAX_DIR_ENTRIES = 500
const PROJECT_MAP_DEFAULT_MAX_FILES = 250
const PROJECT_MAP_DEFAULT_DEPTH = 4
const DEFAULT_PREVIEW_WAIT_MS = 1_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000
const DEVSERVER_READY_TIMEOUT_MS = 20_000

const PROJECT_MAP_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vite',
  'coverage',
  'dist',
  'build',
  'out',
  'node_modules',
  'vendor',
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
        description: 'Executable name, for example npm, npx, pnpm, yarn, node, git, python, pwsh. On Windows, simple Unix aliases like mv/cp/touch/mkdir/ls/pwd/cat are normalized to PowerShell equivalents.',
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
    rawName: 'map',
    name: 'project.map',
    description: 'Build a compact project map: file tree summary, key files, likely entry points, scripts, dependencies, and suggested files to read next.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Project directory to map.' },
        maxDepth: { type: 'number', description: 'Directory depth limit. Defaults to 4.' },
        maxFiles: { type: 'number', description: 'File count limit. Defaults to 250.' },
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

const PROCESS_TOOLS: McpToolDescriptor[] = [
  {
    rawName: 'start',
    name: 'process.start',
    description: [
      'Start a long-running or background development command and return immediately with a processId.',
      'Use this when a command may take a while and Ava should keep task progress visible.',
      'Use process.status/process.logs/process.wait to inspect completion before moving to the next step.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
      },
      required: ['command', 'args', 'cwd'],
    },
  },
  {
    rawName: 'status',
    name: 'process.status',
    description: 'Return status for one background process, or list tracked processes for a cwd.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Process id returned by process.start.' },
        cwd: { type: 'string', description: 'Optional cwd filter when id is omitted.' },
      },
    },
  },
  {
    rawName: 'logs',
    name: 'process.logs',
    description: 'Return recent stdout/stderr for a tracked process. Prefer id from process.start; if id is unavailable, pass cwd to use the latest tracked process in that directory.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Process id returned by process.start.' },
        cwd: { type: 'string', description: 'Fallback cwd filter when id is omitted.' },
      },
    },
  },
  {
    rawName: 'wait',
    name: 'process.wait',
    description: 'Wait briefly for a tracked process to exit, then return its latest status and logs. Prefer id from process.start; if id is unavailable, pass cwd to use the latest tracked process in that directory.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Process id returned by process.start.' },
        cwd: { type: 'string', description: 'Fallback cwd filter when id is omitted.' },
        timeoutMs: { type: 'number', description: 'Defaults to 30000, max 120000.' },
      },
    },
  },
  {
    rawName: 'kill',
    name: 'process.kill',
    description: 'Stop a tracked background process started by process.start. Prefer id from process.start; if id is unavailable, pass cwd to kill the latest tracked process in that directory.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Process id returned by process.start.' },
        cwd: { type: 'string', description: 'Fallback cwd filter when id is omitted.' },
      },
    },
  },
]

const PREVIEW_TOOLS: McpToolDescriptor[] = [
  {
    rawName: 'start',
    name: 'devserver.start',
    description: 'Start a long-running development server for the active project without blocking the agent loop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        command: { type: 'string', description: 'Executable name, for example npm, pnpm, yarn, node.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments, for example ["run", "dev", "--", "--host", "127.0.0.1"].' },
        expectedUrl: { type: 'string', description: 'Optional URL if known, for example http://127.0.0.1:5173/.' },
      },
      required: ['cwd', 'command', 'args'],
    },
  },
  {
    rawName: 'stop',
    name: 'devserver.stop',
    description: 'Stop a development server started by devserver.start.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        id: { type: 'string', description: 'Optional server id returned by devserver.start.' },
      },
    },
  },
  {
    rawName: 'status',
    name: 'devserver.status',
    description: 'Return status and recent logs for development servers started by devserver.start.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        id: { type: 'string' },
      },
    },
  },
  {
    rawName: 'open',
    name: 'preview.open',
    description: 'Open a local preview URL in the system browser.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Local http://127.0.0.1 or http://localhost URL.' },
      },
      required: ['url'],
    },
  },
  {
    rawName: 'console',
    name: 'preview.console',
    description: 'Load a local preview URL and collect browser console errors/warnings plus page errors.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Local http://127.0.0.1 or http://localhost URL.' },
        waitMs: { type: 'number', description: 'Milliseconds to wait after load before returning logs. Defaults to 1000.' },
      },
      required: ['url'],
    },
  },
  {
    rawName: 'screenshot',
    name: 'preview.screenshot',
    description: 'Capture a PNG screenshot of a local preview URL and save it to a project file path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Local http://127.0.0.1 or http://localhost URL.' },
        outputPath: { type: 'string', description: 'PNG output path inside the active project or allowed directories.' },
        waitMs: { type: 'number', description: 'Milliseconds to wait after load before capture. Defaults to 1000.' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['url', 'outputPath'],
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

interface DevServerProcess {
  id: string
  cwd: string
  command: string
  args: string[]
  child: ChildProcessWithoutNullStreams
  startedAt: number
  status: 'starting' | 'running' | 'exited'
  url?: string
  stdout: string
  stderr: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

interface PreviewLogMessage {
  level: string
  text: string
  timestamp: number
}

interface PreviewPageContent {
  url: string
  title: string
  messages: PreviewLogMessage[]
  errorCount: number
  warningCount: number
  pageStats: PreviewPageStats
}

interface PreviewPageStats {
  bodyTextLength: number
  bodyTextSample: string
  elementCount: number
  canvasCount: number
  imageCount: number
  rootHtmlLength: number
}

interface PreviewVisualStats {
  width: number
  height: number
  sampleCount: number
  uniqueColorEstimate: number
  nonWhiteRatio: number
  blankLike: boolean
}

interface DetectedProject {
  cwd: string
  types: string[]
  packageManager?: string
  scripts?: Record<string, string>
  validationCommands: Array<{ command: string; args: string[]; reason: string }>
  files: string[]
}

interface ProjectMapFile {
  path: string
  type: 'file' | 'directory'
  role?: string
  size?: number
}

interface ProjectMap {
  cwd: string
  detected: DetectedProject
  tree: ProjectMapFile[]
  keyFiles: ProjectMapFile[]
  entryCandidates: string[]
  styleCandidates: string[]
  componentCandidates: string[]
  configFiles: string[]
  ignoredDirs: string[]
  truncated: boolean
  suggestedReads: string[]
}

class BuiltInTools {
  private active = new Set<ActiveProcess>()
  private devServers = new Map<string, DevServerProcess>()

  listTools(): McpToolDescriptor[] {
    return [SHELL_TOOL, ...FILE_TOOLS, ...CODING_TOOLS, ...PROCESS_TOOLS, ...PREVIEW_TOOLS]
  }

  /**
   * Recover the canonical Ava tool name from a possibly-sanitized version.
   * The OpenAI adapter sanitizes dots to underscores when sending tools to
   * LM Studio (because the OpenAI tool-calling spec forbids dots in names).
   * Reverse-mapping is supposed to happen in the adapter, but if a model
   * emits a sanitized name for a tool not exposed to the current step, the
   * adapter's per-request inverse map misses and we get here with e.g.
   * `shell_run_command` instead of `shell.run_command`. All built-in names
   * follow `<category>.<snake_name>`, so converting the FIRST underscore to
   * a dot is unambiguous.
   */
  private canonicalizeToolName(name: string): string {
    if (!name) return name
    if (name.includes('.')) return name
    if (!name.includes('_')) return name
    const guess = name.replace('_', '.')
    return this.listTools().some(t => t.name === guess) ? guess : name
  }

  resolveTool(name: string): { serverId: string; rawName: string } | null {
    const canonical = this.canonicalizeToolName(name)
    const tool = this.listTools().find(item => item.name === canonical)
    return tool ? { serverId: 'builtin', rawName: tool.rawName } : null
  }

  async callTool(rawName: string, rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const name = this.canonicalizeToolName(rawName)
    try {
      if (name === SHELL_TOOL.name) return this.callRunCommand(rawArgs, context)
      if (name === 'file.read_text') return this.readText(rawArgs, context)
      if (name === 'file.write_text') return this.writeText(rawArgs, context)
      if (name === 'file.list_dir') return this.listDir(rawArgs, context)
      if (name === 'file.create_dir') return this.createDir(rawArgs, context)
      if (name === 'file.stat') return this.statPath(rawArgs, context)
      if (name === 'file.patch') return this.patchFile(rawArgs, context)
      if (name === 'project.detect') return this.detectProject(rawArgs, context)
      if (name === 'project.map') return this.mapProject(rawArgs, context)
      if (name === 'project.validate') return this.validateProject(rawArgs, context)
      if (name === 'search.ripgrep') return this.ripgrep(rawArgs, context)
      if (name === 'git.status') return this.gitStatus(rawArgs, context)
      if (name === 'git.diff') return this.gitDiff(rawArgs, context)
      if (name === 'devserver.start') return this.startDevServer(rawArgs, context)
      if (name === 'devserver.stop') return this.stopDevServer(rawArgs, context)
      if (name === 'devserver.status') return this.devServerStatus(rawArgs, context)
      if (name === 'process.start') return this.startProcess(rawArgs, context)
      if (name === 'process.status') return this.processStatus(rawArgs, context)
      if (name === 'process.logs') return this.processLogs(rawArgs)
      if (name === 'process.wait') return this.processWait(rawArgs)
      if (name === 'process.kill') return this.processKill(rawArgs)
      if (name === 'preview.open') return this.openPreview(rawArgs)
      if (name === 'preview.console') return this.previewConsole(rawArgs)
      if (name === 'preview.screenshot') return this.previewScreenshot(rawArgs, context)
      return { ok: false, error: `unknown built-in tool: ${name}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async callRunCommand(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseRunCommandArgs(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    const shellAliasResult = await this.runShellAliasAsTool(parsed.args, context)
    if (shellAliasResult) return shellAliasResult

    const safetyError = validateRunCommand(parsed.args, context)
    if (safetyError) return { ok: false, error: safetyError }

    if (isLikelyLongRunningCommand(parsed.args)) {
      const resolvedCommand = resolveCommand(parsed.args.command)
      const spawnTarget = spawnTargetForCommand(resolvedCommand, parsed.args.args)
      const proc = processRegistry.start({
        command: spawnTarget.command,
        args: spawnTarget.args,
        cwd: parsed.args.cwd,
        env: process.env,
      })
      return {
        ok: true,
        content: {
          event: 'backgrounded',
          reason: 'Command looks like a long-running dev/server process, so Ava started it in Process Registry instead of blocking the tool loop.',
          semantic: classifyRunCommand(parsed.args),
          processId: proc.id,
          originalCommand: parsed.args.command,
          originalArgs: parsed.args.args,
          ...proc,
        },
      }
    }

    return this.runCommand(parsed.args)
  }

  private async runShellAliasAsTool(args: RunCommandArgs, context: RunContext): Promise<CallToolResult | CallToolError | null> {
    const commandName = normalizeCommandName(args.command)
    if (commandName !== 'dir' && commandName !== 'ls') return null
    if (!isAllowedCwd(args.cwd, context)) {
      return { ok: false, error: `Working directory "${args.cwd}" is outside the active project or allowed directories.` }
    }

    const targetArg = args.args.find(arg => arg && !arg.startsWith('-') && !arg.startsWith('/'))
    const targetPath = targetArg ? resolvePath(args.cwd, targetArg) : args.cwd
    const guard = validateDirectoryAccess(targetPath, context)
    if (guard) return { ok: false, error: guard }

    const entries = await readdir(targetPath, { withFileTypes: true })
    return {
      ok: true,
      content: {
        commandAlias: args.command,
        path: resolvePath(targetPath),
        entries: entries.slice(0, MAX_DIR_ENTRIES).map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: entries.length > MAX_DIR_ENTRIES,
        count: entries.length,
      },
    }
  }

  private async readText(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const maxChars = clampNumber(rawArgs.maxChars, 1, MAX_FILE_READ_CHARS, MAX_FILE_READ_CHARS)
    let content: string
    try {
      content = await readFile(parsed.path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return {
          ok: false,
          error: `File "${resolvePath(parsed.path)}" does not exist. If you intended to create it, call file.write_text with this path and the new content. If you wanted to discover what files exist, call file.list_dir or project.map first.`,
        }
      }
      if (code === 'EISDIR') {
        return {
          ok: false,
          error: `Path "${resolvePath(parsed.path)}" is a directory, not a file. Use file.list_dir to inspect its contents.`,
        }
      }
      throw err
    }
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
    const content = normalizeWriteTextContent(rawArgs.content, parsed.path)
    if (content === null) {
      const got = rawArgs.content
      const gotType = got === null ? 'null' : Array.isArray(got) ? 'array' : typeof got
      const preview = (() => {
        try {
          const s = JSON.stringify(got)
          return s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '<empty>'
        } catch { return '<unstringifiable>' }
      })()
      return {
        ok: false,
        error: [
          `file.write_text requires args.content to be a STRING (the full file body as plain text).`,
          `Received content of type "${gotType}", value: ${preview}.`,
          `Correct call shape: { "path": "<absolute or project-relative path>", "content": "<the entire file as a single string>" }.`,
          `For source code (.ts/.tsx/.js/.css/.html etc.) pass the file text directly as a single string — do NOT wrap it in an object.`,
          `For JSON files, content may also be a JSON object and Ava will stringify it.`,
        ].join(' '),
      }
    }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const absolutePath = resolvePath(parsed.path)
    const fileExisted = existsSync(absolutePath)
    const overwriteRequested = rawArgs.overwrite === true

    // Existing-file policy: allow the overwrite (otherwise the model loops
    // when it can't figure out how to switch to file.patch), but signal
    // explicitly in the result that the file already existed. The model
    // sees a successful tool call AND a "you just overwrote an existing
    // file — for surgical edits use file.patch" hint, which is a stronger
    // teaching signal than a hard refusal that the model just retries.
    if (rawArgs.createDirs !== false) {
      await mkdir(dirname(absolutePath), { recursive: true })
    }
    await writeFile(absolutePath, content, 'utf8')
    const action = fileExisted ? 'overwritten' : 'created'
    const note = fileExisted && !overwriteRequested
      ? 'NOTE: this path already existed — you just OVERWROTE the entire file. For incremental edits prefer file.patch (oldText/newText). Do NOT call file.write_text again on this same path in this step; you already wrote it.'
      : undefined
    return {
      ok: true,
      content: {
        path: absolutePath,
        bytes: Buffer.byteLength(content, 'utf8'),
        action,
        existed: fileExisted,
        ...(note ? { note } : {}),
      },
    }
  }

  private async listDir(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePathArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validatePathAccess(parsed.path, context)
    if (guard) return { ok: false, error: guard }

    const maxEntries = clampNumber(rawArgs.maxEntries, 1, MAX_DIR_ENTRIES, MAX_DIR_ENTRIES)
    let entries
    try {
      entries = await readdir(parsed.path, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { ok: false, error: `Directory "${resolvePath(parsed.path)}" does not exist yet. Create it with file.create_dir or scaffold the project before listing it.` }
      }
      throw err
    }
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

    const absolutePath = resolvePath(parsed.path)
    const existedBefore = existsSync(absolutePath)
    const allowExisting = rawArgs.allowExisting === true

    // Hard rule (mirrors file.write_text): mkdir -p silently succeeds on
    // already-existing directories, which gives the model no signal that
    // it's repeating itself. Refuse by default so the model gets a clear
    // "stop / move on" error instead of looping on create_dir.
    if (existedBefore && !allowExisting) {
      return {
        ok: false,
        error: [
          `file.create_dir refused: "${absolutePath}" already exists.`,
          'The directory is already there — proceed to write files inside it with file.write_text, or move on to the next step.',
          'Pass allowExisting:true if you genuinely want to no-op confirm the directory exists.',
        ].join(' '),
      }
    }

    await mkdir(absolutePath, { recursive: true })
    return {
      ok: true,
      content: {
        path: absolutePath,
        action: existedBefore ? 'already_exists' : 'created',
        existed: existedBefore,
      },
    }
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
    let content: string
    try {
      content = await readFile(parsed.path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return {
          ok: false,
          error: `File "${resolvePath(parsed.path)}" does not exist, so it cannot be patched. Call file.write_text to create it with the desired content.`,
        }
      }
      throw err
    }
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

    let detected: DetectedProject
    try {
      detected = await detectProject(parsed.cwd)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { ok: false, error: `Project directory "${resolvePath(parsed.cwd)}" does not exist yet. Create it with file.create_dir before detecting project type.` }
      }
      throw err
    }
    return { ok: true, content: detected }
  }

  private async mapProject(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseCwdArg(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDirectoryAccess(parsed.cwd, context)
    if (guard) return { ok: false, error: guard }

    const maxDepth = clampNumber(rawArgs.maxDepth, 1, 8, PROJECT_MAP_DEFAULT_DEPTH)
    const maxFiles = clampNumber(rawArgs.maxFiles, 20, 1000, PROJECT_MAP_DEFAULT_MAX_FILES)
    let mapped: ProjectMap
    try {
      mapped = await mapProject(parsed.cwd, { maxDepth, maxFiles })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { ok: false, error: `Project directory "${resolvePath(parsed.cwd)}" does not exist yet. Create it with file.create_dir before mapping it.` }
      }
      throw err
    }
    return { ok: true, content: mapped }
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

    const rgCommand = resolveBundledRgPath() ?? 'rg'
    const result = await this.runCommand({
      command: rgCommand,
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

  private async startDevServer(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseRunCommandArgs(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const guard = validateDevServerCommand(parsed.args, context)
    if (guard) return { ok: false, error: guard }

    const cwd = resolvePath(parsed.args.cwd)
    const existing = this.findDevServer({ cwd })
    const expectedUrl = typeof rawArgs.expectedUrl === 'string' ? rawArgs.expectedUrl : undefined
    if (existing && existing.status !== 'exited' && (!expectedUrl || existing.url === expectedUrl)) {
      await waitForDevServerReady(existing)
      return { ok: true, content: devServerView(existing, 'already_running') }
    }

    const resolvedCommand = resolveCommand(parsed.args.command)
    const spawnTarget = spawnTargetForCommand(resolvedCommand, parsed.args.args)
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, BROWSER: 'none' },
    })
    const server: DevServerProcess = {
      id: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      cwd,
      command: parsed.args.command,
      args: parsed.args.args,
      child,
      startedAt: Date.now(),
      status: 'starting',
      url: undefined,
      stdout: '',
      stderr: '',
    }
    this.devServers.set(server.id, server)

    let openedInBrowser = false
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const detectedUrl = extractLocalUrl(text)
      if (detectedUrl) server.url = detectedUrl
      if (server.url) {
        server.status = 'running'
        // Auto-open the dev URL in the user's default browser the first time
        // we detect it. Saves the manual "click the link" step at the end of
        // every coding-design task. Errors are swallowed — failure to launch
        // a browser must not crash the dev-server tool call.
        if (!openedInBrowser) {
          openedInBrowser = true
          const url = server.url
          openExternalUrl(url).catch(() => { /* non-fatal */ })
        }
      }
      if (kind === 'stdout') server.stdout = appendRolling(server.stdout, text, MAX_DEVSERVER_LOG_CHARS)
      else server.stderr = appendRolling(server.stderr, text, MAX_DEVSERVER_LOG_CHARS)
    }

    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.stdout.on('error', err => {
      server.stderr = appendRolling(server.stderr, pipeErrorMessage('stdout', err), MAX_DEVSERVER_LOG_CHARS)
    })
    child.stderr.on('error', err => {
      server.stderr = appendRolling(server.stderr, pipeErrorMessage('stderr', err), MAX_DEVSERVER_LOG_CHARS)
    })
    child.on('error', err => {
      server.status = 'exited'
      server.stderr = appendRolling(server.stderr, err.message, MAX_DEVSERVER_LOG_CHARS)
    })
    child.on('close', (code, signal) => {
      server.status = 'exited'
      server.exitCode = code
      server.signal = signal
    })

    await waitForDevServerReady(server)
    if (server.status !== 'running' && expectedUrl) server.url = expectedUrl
    return {
      ok: true,
      isError: server.status !== 'running',
      content: devServerView(server, server.status === 'exited' ? 'exited_before_ready' : server.status === 'starting' ? 'not_ready' : 'started'),
    }
  }

  private async stopDevServer(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const server = this.findDevServerFromArgs(rawArgs, context)
    if (!server.ok) return server
    if (!server.server) return { ok: true, content: { stopped: false, message: 'No matching dev server.' } }
    try {
      server.server.child.kill()
    } catch {
      // noop
    }
    server.server.status = 'exited'
    this.devServers.delete(server.server.id)
    return { ok: true, content: { stopped: true, id: server.server.id, cwd: server.server.cwd } }
  }

  private async devServerStatus(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const server = this.findDevServerFromArgs(rawArgs, context)
    if (!server.ok) return server
    if (server.server) return { ok: true, content: devServerView(server.server, 'status') }
    const cwd = typeof rawArgs.cwd === 'string' ? resolvePath(rawArgs.cwd) : undefined
    return {
      ok: true,
      content: {
        servers: Array.from(this.devServers.values())
          .filter(item => !cwd || normalizePath(item.cwd) === normalizePath(cwd))
          .map(item => devServerView(item, 'status')),
      },
    }
  }

  private async startProcess(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parseRunCommandArgs(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    const safetyError = validateRunCommand(parsed.args, context)
    if (safetyError) return { ok: false, error: safetyError }

    const resolvedCommand = resolveCommand(parsed.args.command)
    const spawnTarget = spawnTargetForCommand(resolvedCommand, parsed.args.args)
    const proc = processRegistry.start({
      command: spawnTarget.command,
      args: spawnTarget.args,
      cwd: parsed.args.cwd,
      env: process.env,
    })
    return {
      ok: true,
      content: {
        event: 'started',
        processId: proc.id,
        originalCommand: parsed.args.command,
        originalArgs: parsed.args.args,
        ...proc,
      },
    }
  }

  private async processStatus(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : ''
    if (id) {
      const process = processRegistry.get(id)
      if (!process) return { ok: false, error: `No tracked process found for id "${id}".` }
      return { ok: true, isError: process.status === 'error', content: process }
    }

    const cwd = typeof rawArgs.cwd === 'string' ? rawArgs.cwd.trim() : ''
    if (cwd) {
      const guard = validateDirectoryAccess(cwd, context)
      if (guard) return { ok: false, error: guard }
      return { ok: true, content: { processes: processRegistry.list(cwd) } }
    }
    return { ok: true, content: { processes: processRegistry.list() } }
  }

  private async processLogs(rawArgs: Record<string, unknown>): Promise<CallToolResult | CallToolError> {
    const process = findProcessFromArgs(rawArgs)
    if (!process.ok) return { ok: false, error: process.error }
    return {
      ok: true,
      isError: process.process.status === 'error',
      content: {
        id: process.process.id,
        status: process.process.status,
        exitCode: process.process.exitCode,
        signal: process.process.signal,
        stdout: process.process.stdout,
        stderr: process.process.stderr,
        truncated: process.process.truncated,
      },
    }
  }

  private async processWait(rawArgs: Record<string, unknown>): Promise<CallToolResult | CallToolError> {
    const found = findProcessFromArgs(rawArgs)
    if (!found.ok) return { ok: false, error: found.error }
    const timeoutMs = clampNumber(rawArgs.timeoutMs, 100, 120_000, 30_000)
    const process = await processRegistry.wait(found.process.id, timeoutMs)
    if (!process) return { ok: false, error: `No tracked process found for id "${found.process.id}".` }
    return { ok: true, isError: process.status === 'error' || (process.status === 'exited' && process.exitCode !== 0), content: process }
  }

  private async processKill(rawArgs: Record<string, unknown>): Promise<CallToolResult | CallToolError> {
    const found = findProcessFromArgs(rawArgs)
    if (!found.ok) return { ok: false, error: found.error }
    const process = processRegistry.kill(found.process.id)
    if (!process) return { ok: false, error: `No tracked process found for id "${found.process.id}".` }
    return { ok: true, content: process }
  }

  private async openPreview(rawArgs: Record<string, unknown>): Promise<CallToolResult | CallToolError> {
    const url = typeof rawArgs.url === 'string' ? rawArgs.url.trim() : ''
    if (!isLocalHttpUrl(url)) {
      return { ok: false, error: 'preview.open only supports local http://127.0.0.1, http://localhost, or http://[::1] URLs.' }
    }
    const opened = await openExternalUrl(url)
    if (!opened) {
      return {
        ok: true,
        content: {
          url,
          opened: false,
          message: 'Preview URL validated. Open it manually if running outside Electron.',
        },
      }
    }
    return { ok: true, content: { url, opened: true } }
  }

  private async previewConsole(rawArgs: Record<string, unknown>): Promise<CallToolResult | CallToolError> {
    const parsed = parsePreviewUrl(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const waitMs = clampNumber(rawArgs.waitMs, 0, 10_000, DEFAULT_PREVIEW_WAIT_MS)
    const loaded = await loadPreviewPage(parsed.url, { waitMs })
    if (!loaded.ok) return loaded
    const content = loaded.content as PreviewPageContent
    return {
      ok: true,
      isError: content.messages.some(message => message.level === 'error' || message.level === 'pageerror'),
      content,
    }
  }

  private async previewScreenshot(rawArgs: Record<string, unknown>, context: RunContext): Promise<CallToolResult | CallToolError> {
    const parsed = parsePreviewUrl(rawArgs)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const outputPath = typeof rawArgs.outputPath === 'string' ? rawArgs.outputPath.trim() : ''
    if (!outputPath) return { ok: false, error: 'preview.screenshot requires "outputPath".' }
    if (!outputPath.toLowerCase().endsWith('.png')) return { ok: false, error: 'preview.screenshot outputPath must end with .png.' }
    const guard = validatePathAccess(outputPath, context)
    if (guard) return { ok: false, error: guard }

    const waitMs = clampNumber(rawArgs.waitMs, 0, 10_000, DEFAULT_PREVIEW_WAIT_MS)
    const width = clampNumber(rawArgs.width, 320, 3840, 1440)
    const height = clampNumber(rawArgs.height, 240, 2160, 900)
    const loaded = await loadPreviewPage(parsed.url, { waitMs, width, height, screenshotPath: outputPath })
    if (!loaded.ok) return loaded
    const content = loaded.content as PreviewPageContent
    return {
      ok: true,
      isError: content.messages.some(message => message.level === 'error' || message.level === 'pageerror'),
      content: {
        ...content,
        screenshotPath: resolvePath(outputPath),
        width,
        height,
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
    processRegistry.killAll()
  }

  private findDevServerFromArgs(
    rawArgs: Record<string, unknown>,
    context: RunContext,
  ): { ok: true; server: DevServerProcess | null } | CallToolError {
    const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : ''
    if (id) return { ok: true, server: this.devServers.get(id) ?? null }
    if (typeof rawArgs.cwd !== 'string' || !rawArgs.cwd.trim()) return { ok: true, server: null }
    const guard = validateDirectoryAccess(rawArgs.cwd, context)
    if (guard) return { ok: false, error: guard }
    return { ok: true, server: this.findDevServer({ cwd: resolvePath(rawArgs.cwd) }) }
  }

  private findDevServer(input: { cwd: string }): DevServerProcess | null {
    const cwd = normalizePath(input.cwd)
    return Array.from(this.devServers.values()).find(server =>
      normalizePath(server.cwd) === cwd && server.status !== 'exited',
    ) ?? null
  }

  private async runCommand(args: RunCommandArgs): Promise<CallToolResult | CallToolError> {
    const startedAt = Date.now()
    const timeoutMs = clampTimeout(args.timeoutMs)
    const controller = new AbortController()
    const outputLogPath = await commandOutputLogPath(args)
    const outputLog = createWriteStream(outputLogPath, { flags: 'a', encoding: 'utf8' })

    return new Promise(resolve => {
      let stdout = ''
      let stderr = ''
      let truncated = false
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let outputLogClosed = false

      const closeOutputLog = () => new Promise<void>(resolveLog => {
        if (outputLogClosed) {
          resolveLog()
          return
        }
        outputLogClosed = true
        outputLog.end(() => resolveLog())
      })

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
        
        // Force-settle if the process is stuck and doesn't fire 'close'
        setTimeout(() => {
          if (settled) return
          settled = true
          this.active.delete(active)
          closeOutputLog().then(() => {
            resolve({
              ok: false,
              error: 'Command timed out and failed to exit within grace period. It may be locked by another process (e.g. dev server).',
              aborted: true,
            })
          })
        }, 5000)
      }, timeoutMs)

      const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString('utf8')
        const prefix = kind === 'stdout' ? '[stdout] ' : '[stderr] '
        outputLog.write(`${prefix}${text}`)
        if (kind === 'stdout') stdoutBytes += Buffer.byteLength(text, 'utf8')
        else stderrBytes += Buffer.byteLength(text, 'utf8')
        const current = kind === 'stdout' ? stdout : stderr
        const next = current + text
        if (next.length > MAX_OUTPUT_CHARS) truncated = true
        if (kind === 'stdout') stdout = previewCommandOutput(next)
        else stderr = previewCommandOutput(next)
      }

      child.stdout.on('data', chunk => append('stdout', chunk))
      child.stderr.on('data', chunk => append('stderr', chunk))
      child.stdout.on('error', err => append('stderr', Buffer.from(pipeErrorMessage('stdout', err))))
      child.stderr.on('error', err => append('stderr', Buffer.from(pipeErrorMessage('stderr', err))))

      child.on('error', async err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.active.delete(active)
        await closeOutputLog()
        if (controller.signal.aborted) {
          resolve({ ok: false, error: 'aborted', aborted: true })
          return
        }
        resolve({ ok: false, error: err.message })
      })

      child.on('close', async (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.active.delete(active)
        await closeOutputLog()
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
          semantic: classifyRunCommand(args),
          exitCode: code,
          signal,
          durationMs: Math.max(0, Date.now() - startedAt),
          stdout,
          stderr,
          stdoutBytes,
          stderrBytes,
          outputLogPath,
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

function normalizeWriteTextContent(content: unknown, path: string): string | null {
  if (typeof content === 'string') return content
  if (
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    resolvePath(path).toLowerCase().endsWith('.json')
  ) {
    return `${JSON.stringify(content, null, 2)}\n`
  }
  return null
}

async function commandOutputLogPath(args: RunCommandArgs): Promise<string> {
  const dir = process.env.APPDATA
    ? resolvePath(process.env.APPDATA, 'Ava', 'command-logs')
    : resolvePath(tmpdir(), 'ava-command-logs')
  await mkdir(dir, { recursive: true })
  const safeCommand = normalizeCommandName(args.command).replace(/[^a-z0-9_.-]/gi, '_') || 'command'
  return resolvePath(dir, `${Date.now()}-${safeCommand}-${randomUUID()}.log`)
}

function previewCommandOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const half = Math.floor((MAX_OUTPUT_CHARS - 120) / 2)
  const head = text.slice(0, half)
  const tail = text.slice(-half)
  return `${head}\n\n... output truncated; full output is available in outputLogPath ...\n\n${tail}`
}

function parseRunCommandArgs(raw: Record<string, unknown>): { ok: true; args: RunCommandArgs } | { ok: false; error: string } {
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const args = Array.isArray(raw.args) ? raw.args.map(String) : null
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
  const timeoutMs = typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined

  if (!command) return { ok: false, error: 'shell.run_command requires "command".' }
  if (!args) return { ok: false, error: 'shell.run_command requires "args" as an array of strings.' }
  if (!cwd) return { ok: false, error: 'shell.run_command requires "cwd".' }
  return { ok: true, args: normalizeRunCommandArgs({ command, args, cwd, timeoutMs }) }
}

function normalizeRunCommandArgs(args: RunCommandArgs): RunCommandArgs {
  const commandName = normalizeCommandName(args.command)
  if (commandName === 'mv' && args.args.length === 2) {
    return powershellCommand(args, ['Move-Item', '-LiteralPath', args.args[0], '-Destination', args.args[1]])
  }
  if (commandName === 'cp' && args.args.length === 2) {
    return powershellCommand(args, ['Copy-Item', '-LiteralPath', args.args[0], '-Destination', args.args[1]])
  }
  if (commandName === 'touch' && args.args.length === 1) {
    return powershellCommand(args, ['New-Item', '-ItemType', 'File', '-Force', '-Path', args.args[0]])
  }
  if (commandName === 'mkdir') {
    const path = args.args[0] === '-p' ? args.args[1] : args.args[0]
    if (path && args.args.length <= 2) {
      return powershellCommand(args, ['New-Item', '-ItemType', 'Directory', '-Force', '-Path', path])
    }
  }
  if (commandName === 'pwd' && args.args.length === 0) {
    return powershellCommand(args, ['Get-Location'])
  }
  if (commandName === 'cat' && args.args.length === 1) {
    return powershellCommand(args, ['Get-Content', '-LiteralPath', args.args[0]])
  }
  return args
}

function classifyRunCommand(args: RunCommandArgs): string {
  const commandName = normalizeCommandName(args.command)
  const joined = args.args.join(' ').toLowerCase()
  if (isLikelyLongRunningCommand(args)) return 'long_running'
  if (/(^|\s)(install|add|i)(\s|$)/.test(joined) || ['pip', 'pip3'].includes(commandName)) return 'install'
  if (/(^|\s)(build|typecheck|test|lint|tsc)(\s|$)/.test(joined) || ['tsc', 'pytest'].includes(commandName)) return 'validate'
  if (commandName === 'git') return 'git'
  if (['rg', 'dir', 'ls', 'cat'].includes(commandName)) return 'inspect'
  if (['node', 'python', 'python3', 'py', 'dotnet'].includes(commandName)) return 'execute'
  return 'command'
}

function isLikelyLongRunningCommand(args: RunCommandArgs): boolean {
  const commandName = normalizeCommandName(args.command)
  const normalizedArgs = args.args.map(arg => arg.toLowerCase())
  if (['vite'].includes(commandName)) return !normalizedArgs.includes('build')
  if (['next', 'astro', 'remix'].includes(commandName)) return normalizedArgs.includes('dev') || normalizedArgs.length === 0

  const script = npmScriptName(commandName, normalizedArgs)
  if (!script) return false
  return ['dev', 'start', 'serve', 'preview'].includes(script)
}

function npmScriptName(commandName: string, args: string[]): string | null {
  if (!['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'bun', 'bunx'].includes(commandName)) return null
  if (commandName === 'yarn' || commandName === 'yarn.cmd') {
    if (args[0] === 'run') return args[1] ?? null
    return args[0] ?? null
  }
  if (commandName === 'bun' || commandName === 'bunx') {
    if (args[0] === 'run') return args[1] ?? null
    return null
  }
  if (args[0] === 'run') return args[1] ?? null
  return null
}

function powershellCommand(args: RunCommandArgs, commandArgs: string[]): RunCommandArgs {
  return {
    ...args,
    command: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command', ...commandArgs],
  }
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

function parsePreviewUrl(raw: Record<string, unknown>): { ok: true; url: string } | { ok: false; error: string } {
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!isLocalHttpUrl(url)) {
    return { ok: false, error: 'Preview tools only support local http://127.0.0.1, http://localhost, or http://[::1] URLs.' }
  }
  return { ok: true, url }
}

function findProcessFromArgs(raw: Record<string, unknown>): { ok: true; process: ProcessRecordView } | { ok: false; error: string } {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id) {
    const process = processRegistry.get(id)
    return process ? { ok: true, process } : { ok: false, error: `No tracked process found for id "${id}".` }
  }
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : undefined
  const process = processRegistry.latest(cwd)
  return process
    ? { ok: true, process }
    : { ok: false, error: cwd ? `No tracked process found for cwd "${cwd}".` : 'Process tool requires "id", or a cwd with at least one tracked process.' }
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
      return [
        `Blocked potentially dangerous command argument: ${arg}`,
        'Use shell.run_command only for structured build/install/test commands.',
        'For file creation or edits, use file.write_text or file.patch instead of PowerShell scripts.',
      ].join(' ')
    }
  }
  return null
}

function validateDevServerCommand(args: RunCommandArgs, context: RunContext): string | null {
  const commandName = normalizeCommandName(args.command)
  if (!DEVSERVER_COMMAND_ALLOWLIST.has(commandName)) {
    return `Command "${args.command}" is not allowed for devserver.start. Allowed commands: ${Array.from(DEVSERVER_COMMAND_ALLOWLIST).join(', ')}.`
  }
  if (!existsSync(resolvePath(args.cwd))) {
    return `Working directory does not exist: ${args.cwd}`
  }
  if (!isAllowedCwd(args.cwd, context)) {
    return `Working directory "${args.cwd}" is outside the active project or allowed directories.`
  }
  for (const arg of args.args) {
    if (DANGEROUS_ARG_RE.test(arg)) {
      return `Blocked potentially dangerous dev server argument: ${arg}`
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

async function mapProject(
  cwd: string,
  options: { maxDepth: number; maxFiles: number },
): Promise<ProjectMap> {
  const root = resolvePath(cwd)
  const detected = await detectProject(root)
  const tree: ProjectMapFile[] = []
  const ignoredDirs = new Set<string>()
  let visitedFiles = 0
  let truncated = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || visitedFiles >= options.maxFiles) {
      truncated = true
      return
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (visitedFiles >= options.maxFiles) {
        truncated = true
        return
      }
      if (entry.isDirectory() && PROJECT_MAP_IGNORED_DIRS.has(entry.name)) {
        ignoredDirs.add(relativeProjectPath(root, resolvePath(dir, entry.name)))
        continue
      }
      const abs = resolvePath(dir, entry.name)
      const rel = relativeProjectPath(root, abs)
      if (!rel) continue

      if (entry.isDirectory()) {
        tree.push({ path: rel, type: 'directory', role: classifyProjectPath(rel, true) })
        await walk(abs, depth + 1)
        continue
      }

      if (!entry.isFile()) continue
      visitedFiles += 1
      const info = await stat(abs).catch(() => null)
      tree.push({
        path: rel,
        type: 'file',
        role: classifyProjectPath(rel, false),
        ...(info ? { size: info.size } : {}),
      })
    }
  }

  await walk(root, 1)

  const files = tree.filter(item => item.type === 'file')
  const keyFiles = files.filter(item => Boolean(item.role))
  const entryCandidates = files.filter(item => item.role === 'entry').map(item => item.path)
  const styleCandidates = files.filter(item => item.role === 'style').map(item => item.path)
  const componentCandidates = files.filter(item => item.role === 'component').map(item => item.path).slice(0, 40)
  const configFiles = files.filter(item => item.role === 'config').map(item => item.path)
  const suggestedReads = Array.from(new Set([
    'package.json',
    ...configFiles,
    ...entryCandidates,
    ...styleCandidates.slice(0, 8),
    ...componentCandidates.slice(0, 12),
  ].filter(path => files.some(file => file.path === path))))

  return {
    cwd: root,
    detected,
    tree,
    keyFiles,
    entryCandidates,
    styleCandidates,
    componentCandidates,
    configFiles,
    ignoredDirs: Array.from(ignoredDirs),
    truncated,
    suggestedReads,
  }
}

function relativeProjectPath(root: string, abs: string): string {
  const normalizedRoot = normalizePath(root)
  const normalizedAbs = normalizePath(abs)
  if (normalizedAbs === normalizedRoot) return ''
  if (!normalizedAbs.startsWith(`${normalizedRoot}\\`)) return abs
  return abs.slice(resolvePath(root).length + 1).replace(/\\/g, '/')
}

function classifyProjectPath(path: string, isDirectory: boolean): string | undefined {
  const lower = path.toLowerCase()
  const name = lower.split('/').pop() ?? lower
  if (isDirectory) {
    if (['src', 'app', 'pages', 'routes'].includes(name)) return 'source-root'
    if (['components', 'ui'].includes(name)) return 'components-dir'
    if (['styles', 'css'].includes(name)) return 'styles-dir'
    if (['public', 'assets', 'static'].includes(name)) return 'assets-dir'
    return undefined
  }

  if (
    name === 'package.json' ||
    name.startsWith('vite.config.') ||
    name.startsWith('next.config.') ||
    name.startsWith('tsconfig') ||
    name.startsWith('tailwind.config.') ||
    name.startsWith('postcss.config.') ||
    name === 'index.html'
  ) return 'config'

  if (/^src\/(main|index)\.(tsx|ts|jsx|js)$/.test(lower) || /^src\/app\.(tsx|ts|jsx|js)$/.test(lower)) return 'entry'
  if (/\.(css|scss|sass|less)$/.test(lower)) return 'style'
  if (/\.(tsx|jsx)$/.test(lower) && /(^|\/)(components|pages|routes|app|src)\//.test(lower)) return 'component'
  if (/\.(glsl|vert|frag|wgsl)$/.test(lower)) return 'shader'
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico|glb|gltf|obj|fbx)$/.test(lower)) return 'asset'
  return undefined
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

function appendRolling(current: string, text: string, maxChars: number): string {
  const next = current + text
  return next.length > maxChars ? next.slice(next.length - maxChars) : next
}

function pipeErrorMessage(kind: 'stdout' | 'stderr', err: Error): string {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPIPE'
    ? `${kind} pipe closed (EPIPE)\n`
    : `${kind} pipe error: ${err.message}\n`
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function extractLocalUrl(text: string): string | undefined {
  const clean = stripAnsi(text)
  const matches = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/gi) ?? []
  return matches.find(raw => {
    try {
      const url = new URL(raw)
      // Vite can print colored URLs split by ANSI escape sequences. Do not
      // accept a partial "http://localhost" without the dev-server port.
      return Boolean(url.port)
    } catch {
      return false
    }
  })
}

async function waitForDevServerReady(server: DevServerProcess): Promise<void> {
  const deadline = Date.now() + DEVSERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (server.status === 'exited' || server.status === 'running') return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function devServerView(server: DevServerProcess, event: string): Record<string, unknown> {
  return {
    event,
    id: server.id,
    cwd: server.cwd,
    command: server.command,
    args: server.args,
    status: server.status,
    url: server.url,
    pid: server.child.pid,
    uptimeMs: Math.max(0, Date.now() - server.startedAt),
    exitCode: server.exitCode,
    signal: server.signal,
    stdout: server.stdout,
    stderr: server.stderr,
  }
}

function isLocalHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

async function loadPreviewPage(
  url: string,
  options: { waitMs: number; width?: number; height?: number; screenshotPath?: string },
): Promise<CallToolResult | CallToolError> {
  let browser: any = null
  try {
    const { chromium } = await import('@playwright/test')

    const messages: PreviewLogMessage[] = []
    const launchedBrowser = await chromium.launch({ headless: true })
    browser = launchedBrowser
    const page = await launchedBrowser.newPage({
      viewport: {
        width: options.width ?? 1280,
        height: options.height ?? 800,
      },
    })

    page.on('console', (message: { type: () => string; text: () => string }) => {
      messages.push({ level: message.type(), text: message.text(), timestamp: Date.now() })
    })
    page.on('pageerror', (error: Error) => {
      messages.push({ level: 'pageerror', text: error.message, timestamp: Date.now() })
    })
    page.on('crash', () => {
      messages.push({ level: 'error', text: 'page crashed', timestamp: Date.now() })
    })

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(5_000, options.waitMs + 5_000) })
      if (options.waitMs > 0) await page.waitForTimeout(options.waitMs)
      const pageStats = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').trim()
        return {
          bodyTextLength: bodyText.length,
          bodyTextSample: bodyText.slice(0, 300),
          elementCount: document.querySelectorAll('*').length,
          canvasCount: document.querySelectorAll('canvas').length,
          imageCount: document.querySelectorAll('img, svg').length,
          rootHtmlLength: document.documentElement?.outerHTML?.length || 0,
        }
      }) as PreviewPageStats
      let visualStats: PreviewVisualStats | undefined

      if (options.screenshotPath) {
        await mkdir(dirname(resolvePath(options.screenshotPath)), { recursive: true })
        const image = await page.screenshot({ path: options.screenshotPath, fullPage: false })
        visualStats = imageVisualStatsFromPngBuffer(image, options.width ?? 1280, options.height ?? 800)
      }

      return {
        ok: true,
        content: {
          url,
          title: await page.title(),
          messages,
          errorCount: messages.filter(message => message.level === 'error' || message.level === 'pageerror').length,
          warningCount: messages.filter(message => message.level === 'warning').length,
          pageStats,
          ...(visualStats ? { visualStats } : {}),
        },
      }
    } finally {
      await page.close().catch(() => undefined)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }
}

async function openExternalUrl(url: string): Promise<boolean> {
  const command = process.platform === 'win32'
    ? 'cmd'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open'
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url]

  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true }, error => resolve(!error))
  })
}

function consoleLevelName(level: number): string {
  if (level === 3) return 'error'
  if (level === 2) return 'warning'
  if (level === 1) return 'info'
  return 'log'
}

function imageVisualStatsFromPngBuffer(buffer: Buffer, width: number, height: number): PreviewVisualStats {
  return {
    width,
    height,
    sampleCount: 0,
    uniqueColorEstimate: buffer.length > 0 ? 1 : 0,
    nonWhiteRatio: buffer.length > 0 ? 1 : 0,
    blankLike: buffer.length === 0,
  }
}

function imageVisualStats(image: { getSize: () => { width: number; height: number }; toBitmap: () => Buffer }): PreviewVisualStats {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const stride = 4
  const maxSamples = 1200
  const totalPixels = Math.max(1, Math.floor(bitmap.length / stride))
  const step = Math.max(1, Math.floor(totalPixels / maxSamples))
  const colors = new Set<string>()
  let sampled = 0
  let nonWhite = 0
  for (let pixel = 0; pixel < totalPixels; pixel += step) {
    const offset = pixel * stride
    const blue = bitmap[offset] ?? 255
    const green = bitmap[offset + 1] ?? 255
    const red = bitmap[offset + 2] ?? 255
    colors.add(`${red >> 4},${green >> 4},${blue >> 4}`)
    if (!(red > 245 && green > 245 && blue > 245)) nonWhite += 1
    sampled += 1
  }
  const nonWhiteRatio = sampled > 0 ? nonWhite / sampled : 0
  const uniqueColorEstimate = colors.size
  return {
    width,
    height,
    sampleCount: sampled,
    uniqueColorEstimate,
    nonWhiteRatio,
    blankLike: uniqueColorEstimate <= 2 || nonWhiteRatio < 0.005,
  }
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
