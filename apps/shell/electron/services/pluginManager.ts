import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { app } from 'electron'
import type { PluginManifest } from '@ava/plugin-sdk'
import type { McpServerConfig } from './mcpSupervisor'

export interface PluginState {
  enabled: boolean
}

export interface PluginManifestView {
  name: string
  version: string
  description?: string
}

export interface DiscoveredPlugin {
  id: string
  rootPath: string
  manifest?: PluginManifestView
  enabled: boolean
  valid: boolean
  bundled: boolean
  source: PluginSourceInfo
  mcpServerCount: number
  skillCount: number
  commandCount: number
  mcpServers: PluginMcpServerView[]
  skills: PluginCapabilityView[]
  commands: PluginCapabilityView[]
  permissions: string[]
  errors: string[]
  warnings: string[]
}

export type PluginSourceKind = 'bundled' | 'local' | 'git' | 'zip' | 'unknown'

export interface PluginSourceInfo {
  kind: PluginSourceKind
  uri?: string
  installedAt?: number
  updateable: boolean
}

export interface PluginMcpServerView {
  id?: string
  name: string
  type: 'stdio' | 'http' | 'sse' | 'unknown'
  status: 'loaded' | 'unsupported' | 'invalid'
  command?: string
  args?: string[]
  envKeys?: string[]
  cwd?: string
  cwdInsidePlugin?: boolean
  error?: string
}

export interface PluginCapabilityView {
  name: string
  sourcePath: string
  status: 'loaded' | 'missing' | 'invalid'
  error?: string
}

export interface PluginSkill {
  pluginId: string
  pluginName: string
  name: string
  sourcePath: string
  content: string
  truncated: boolean
}

export interface PluginCommand {
  pluginId: string
  pluginName: string
  bundled: boolean
  sourceKind: PluginSourceInfo['kind']
  name: string
  description?: string
  arguments: PluginCommandArgument[]
  sourcePath: string
  content: string
  truncated: boolean
}

export interface PluginCommandArgument {
  name: string
  description?: string
  required: boolean
  defaultValue?: string
}

interface LoadedPlugin extends DiscoveredPlugin {
  runtimeMcpServers: McpServerConfig[]
}

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
const BUNDLED_DIR = 'plugins'
const USER_DIR = 'user-plugins'
const MAX_SKILL_CHARS = 12_000
const MAX_TOTAL_SKILL_CHARS = 48_000
const MAX_COMMAND_CHARS = 8_000
const MAX_TOTAL_COMMAND_CHARS = 32_000
const SOURCE_META = '.ava-plugin-source.json'

function findProjectRoot(): string {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, USER_DIR)) || existsSync(join(dir, BUNDLED_DIR))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

function uniqueRoots(roots: Array<{ path: string; bundled: boolean }>): Array<{ path: string; bundled: boolean }> {
  const seen = new Set<string>()
  const out: Array<{ path: string; bundled: boolean }> = []
  for (const root of roots) {
    const key = resolve(root.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...root, path: resolve(root.path) })
  }
  return out
}

function packagedRoots(): Array<{ path: string; bundled: boolean }> {
  if (!app.isPackaged) return []
  return [
    { path: join(process.resourcesPath, BUNDLED_DIR), bundled: true },
    { path: join(app.getAppPath(), BUNDLED_DIR), bundled: true },
    { path: join(app.getPath('userData'), USER_DIR), bundled: false },
  ]
}

function sanitizeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function execFileAsync(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function isInside(parent: string, child: string): boolean {
  const root = resolve(parent)
  const target = resolve(child)
  const prefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}\\`
  return target === root || target.startsWith(prefix) || target.startsWith(prefix.replace(/\\/g, '/'))
}

function manifestView(raw: unknown): { manifest?: PluginManifestView; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { errors: ['plugin.json must be an object'] }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!name) errors.push('plugin.json missing string field: name')
  if (!version) errors.push('plugin.json missing string field: version')
  if (errors.length > 0) return { errors }
  return {
    manifest: {
      name,
      version,
      description: typeof raw.description === 'string' ? raw.description : undefined,
    },
    errors,
  }
}

function pluginIdForRoot(rootPath: string, bundled: boolean): string {
  return `${bundled ? 'bundled' : 'user'}-${sanitizeId(basename(rootPath)) || 'plugin'}`
}

function userPluginsDir(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), USER_DIR)
    : join(findProjectRoot(), USER_DIR)
}

function installFolderName(raw: string): string {
  return sanitizeId(raw) || `plugin-${Date.now()}`
}

async function readSourceInfo(rootPath: string, bundled: boolean): Promise<PluginSourceInfo> {
  if (bundled) return { kind: 'bundled', updateable: false }
  const metaPath = join(rootPath, SOURCE_META)
  if (!existsSync(metaPath)) return { kind: 'unknown', updateable: false }
  try {
    const raw = await readJsonFile<Partial<PluginSourceInfo>>(metaPath)
    const kind: PluginSourceKind =
      raw.kind === 'local' || raw.kind === 'git' || raw.kind === 'zip' || raw.kind === 'unknown'
        ? raw.kind
        : 'unknown'
    return {
      kind,
      uri: typeof raw.uri === 'string' ? raw.uri : undefined,
      installedAt: typeof raw.installedAt === 'number' ? raw.installedAt : undefined,
      updateable: kind === 'git',
    }
  } catch {
    return { kind: 'unknown', updateable: false }
  }
}

async function writeSourceInfo(rootPath: string, source: PluginSourceInfo): Promise<void> {
  await writeFile(join(rootPath, SOURCE_META), JSON.stringify(source, null, 2), 'utf8')
}

async function findPluginRoot(rootPath: string): Promise<string | null> {
  const direct = join(rootPath, PLUGIN_MANIFEST)
  if (existsSync(direct)) return rootPath
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(rootPath, entry.name)
    if (existsSync(join(candidate, PLUGIN_MANIFEST))) return candidate
  }
  return null
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function countSkillDirs(rootPath: string, manifest?: PluginManifest): Promise<number> {
  if (Array.isArray(manifest?.skills)) return manifest.skills.length
  const skillsDir = join(rootPath, 'skills')
  if (!existsSync(skillsDir)) return 0
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md'))) count += 1
  }
  return count
}

async function discoverSkillPaths(rootPath: string, manifest?: PluginManifest): Promise<Array<{ name: string; path: string }>> {
  const skillsRoot = resolve(rootPath, 'skills')
  if (Array.isArray(manifest?.skills) && manifest.skills.length > 0) {
    return manifest.skills
      .map(raw => String(raw).trim())
      .filter(Boolean)
      .flatMap(name => {
        const path = resolve(skillsRoot, name, 'SKILL.md')
        return path.startsWith(`${skillsRoot}\\`) || path.startsWith(`${skillsRoot}/`)
          ? [{ name, path }]
          : []
      })
  }

  if (!existsSync(skillsRoot)) return []
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => ({ name: entry.name, path: join(skillsRoot, entry.name, 'SKILL.md') }))
}

async function readSkill(path: string): Promise<{ content: string; truncated: boolean }> {
  const raw = await readFile(path, 'utf8')
  if (raw.length <= MAX_SKILL_CHARS) return { content: raw, truncated: false }
  return {
    content: raw.slice(0, MAX_SKILL_CHARS),
    truncated: true,
  }
}

async function countCommandFiles(rootPath: string, manifest?: PluginManifest): Promise<number> {
  if (Array.isArray(manifest?.commands)) return manifest.commands.length
  const commandsDir = join(rootPath, 'commands')
  if (!existsSync(commandsDir)) return 0
  const entries = await readdir(commandsDir, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).length
}

async function discoverCommandPaths(rootPath: string, manifest?: PluginManifest): Promise<Array<{ name: string; path: string }>> {
  const commandsRoot = resolve(rootPath, 'commands')
  if (Array.isArray(manifest?.commands) && manifest.commands.length > 0) {
    return manifest.commands
      .map(raw => String(raw).trim())
      .filter(Boolean)
      .flatMap(name => {
        const fileName = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
        const path = resolve(commandsRoot, fileName)
        return path.startsWith(`${commandsRoot}\\`) || path.startsWith(`${commandsRoot}/`)
          ? [{ name: fileName.replace(/\.md$/i, ''), path }]
          : []
      })
  }

  if (!existsSync(commandsRoot)) return []
  const entries = await readdir(commandsRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => ({ name: entry.name.replace(/\.md$/i, ''), path: join(commandsRoot, entry.name) }))
}

function parseBoolean(raw: string | undefined): boolean {
  return raw === 'true' || raw === 'yes' || raw === 'required'
}

function parseCommandFrontmatter(raw: string): {
  body: string
  description?: string
  arguments: PluginCommandArgument[]
} {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { body: raw, arguments: inferArguments(raw) }
  }
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return { body: raw, arguments: inferArguments(raw) }
  const fm = raw.slice(4, end).replace(/\r/g, '')
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1)
  let description: string | undefined
  const args: PluginCommandArgument[] = []
  let current: PluginCommandArgument | null = null

  for (const line of fm.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const top = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (top && !line.startsWith(' ')) {
      current = null
      if (top[1] === 'description') description = top[2].replace(/^["']|["']$/g, '')
      continue
    }
    const argStart = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/)
    if (argStart) {
      current = {
        name: argStart[1],
        required: false,
      }
      args.push(current)
      continue
    }
    const argProp = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*)$/)
    if (argProp && current) {
      const value = argProp[2].replace(/^["']|["']$/g, '')
      if (argProp[1] === 'description') current.description = value
      if (argProp[1] === 'required') current.required = parseBoolean(value)
      if (argProp[1] === 'default') current.defaultValue = value
    }
  }

  const merged = new Map<string, PluginCommandArgument>()
  for (const arg of [...args, ...inferArguments(body)]) {
    if (!merged.has(arg.name)) merged.set(arg.name, arg)
  }
  return { body, description, arguments: Array.from(merged.values()) }
}

function inferArguments(content: string): PluginCommandArgument[] {
  const names = new Set<string>()
  if (content.includes('$ARGUMENTS')) names.add('ARGUMENTS')
  for (const match of content.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) {
    names.add(match[1])
  }
  return Array.from(names).map(name => ({ name, required: false }))
}

async function readCommand(path: string): Promise<{ content: string; description?: string; arguments: PluginCommandArgument[]; truncated: boolean }> {
  const raw = await readFile(path, 'utf8')
  const truncated = raw.length > MAX_COMMAND_CHARS
  const parsed = parseCommandFrontmatter(truncated ? raw.slice(0, MAX_COMMAND_CHARS) : raw)
  if (!truncated) return { content: parsed.body, description: parsed.description, arguments: parsed.arguments, truncated: false }
  return {
    content: parsed.body,
    description: parsed.description,
    arguments: parsed.arguments,
    truncated: true,
  }
}

interface StdioSpecView {
  type?: unknown
  command: string
  args?: unknown
  env?: unknown
  cwd?: unknown
}

function isStdioServer(spec: unknown): spec is StdioSpecView {
  if (!isRecord(spec)) return false
  return (!('type' in spec) || spec.type === 'stdio') && typeof spec.command === 'string'
}

function parseMcpServers(pluginId: string, rootPath: string, manifestName: string, raw: unknown): {
  servers: McpServerConfig[]
  views: PluginMcpServerView[]
  count: number
  errors: string[]
  warnings: string[]
  permissions: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  const servers: McpServerConfig[] = []
  const views: PluginMcpServerView[] = []
  const permissions: string[] = []
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    return {
      servers,
      views,
      count: 0,
      errors,
      warnings: ['.mcp.json missing object field: mcpServers'],
      permissions,
    }
  }

  const serverSpecs = raw.mcpServers
  for (const [name, spec] of Object.entries(serverSpecs)) {
    if (!isRecord(spec)) {
      warnings.push(`MCP server "${name}" must be an object`)
      views.push({ name, type: 'unknown', status: 'invalid', error: 'server spec must be an object' })
      continue
    }
    if (!isStdioServer(spec)) {
      const type = spec.type === 'http' || spec.type === 'sse' ? spec.type : 'unknown'
      warnings.push(`MCP server "${name}" is ${type}; only stdio is supported now`)
      views.push({ name, type, status: 'unsupported', error: 'only stdio MCP servers are supported now' })
      continue
    }
    const serverId = `${pluginId}-${sanitizeId(name) || 'server'}`
    const cwd = typeof spec.cwd === 'string' && spec.cwd.trim() ? resolve(rootPath, spec.cwd) : rootPath
    const cwdInsidePlugin = isInside(rootPath, cwd)
    if (!cwdInsidePlugin) {
      const error = `cwd resolves outside plugin root: ${cwd}`
      warnings.push(`MCP server "${name}" ${error}`)
      views.push({
        name,
        type: 'stdio',
        status: 'invalid',
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
        envKeys: isRecord(spec.env) ? Object.keys(spec.env) : [],
        cwd,
        cwdInsidePlugin,
        error,
      })
      continue
    }
    const args = Array.isArray(spec.args) ? spec.args.map(String) : []
    const env = isRecord(spec.env) ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : undefined
    const envKeys = env ? Object.keys(env) : []
    servers.push({
      id: serverId,
      name: `${manifestName}: ${name}`,
      command: spec.command,
      args,
      env,
      cwd,
      enabled: true,
      builtin: false,
      pluginId,
    })
    views.push({ id: serverId, name, type: 'stdio', status: 'loaded', command: spec.command, args, envKeys, cwd, cwdInsidePlugin })
    permissions.push(`Starts MCP process: ${spec.command}${args.length ? ` ${args.join(' ')}` : ''}`)
    permissions.push(`MCP working directory: ${cwd}`)
    if (envKeys.length > 0) {
      permissions.push(`Sets environment variables: ${envKeys.join(', ')}`)
    }
  }

  return { servers, views, count: Object.keys(serverSpecs).length, errors, warnings, permissions }
}

export class PluginManager {
  private roots(): Array<{ path: string; bundled: boolean }> {
    const cwd = findProjectRoot()
    return uniqueRoots([
      { path: join(cwd, BUNDLED_DIR), bundled: true },
      { path: join(cwd, USER_DIR), bundled: false },
      ...packagedRoots(),
    ])
  }

  async discover(states: Record<string, PluginState> = {}): Promise<DiscoveredPlugin[]> {
    const loaded = await this.load(states)
    return loaded.map(({ runtimeMcpServers: _runtimeMcpServers, ...view }) => view)
  }

  async mcpServersForStates(states: Record<string, PluginState> = {}): Promise<McpServerConfig[]> {
    const loaded = await this.load(states)
    return loaded.flatMap(plugin => plugin.enabled && plugin.valid ? plugin.runtimeMcpServers : [])
  }

  async skillsForStates(states: Record<string, PluginState> = {}): Promise<PluginSkill[]> {
    const loaded = await this.load(states)
    const skills: PluginSkill[] = []
    let totalChars = 0
    for (const plugin of loaded) {
      if (!plugin.enabled || !plugin.valid) continue
      const manifest = await readJsonFile<PluginManifest>(join(plugin.rootPath, PLUGIN_MANIFEST)).catch(() => undefined)
      const paths = await discoverSkillPaths(plugin.rootPath, manifest)
      for (const skill of paths) {
        if (!existsSync(skill.path) || totalChars >= MAX_TOTAL_SKILL_CHARS) continue
        const read = await readSkill(skill.path).catch(() => null)
        if (!read) continue
        const remaining = MAX_TOTAL_SKILL_CHARS - totalChars
        const content = read.content.length > remaining ? read.content.slice(0, remaining) : read.content
        totalChars += content.length
        skills.push({
          pluginId: plugin.id,
          pluginName: plugin.manifest?.name ?? plugin.id,
          name: skill.name,
          sourcePath: skill.path,
          content,
          truncated: read.truncated || content.length < read.content.length,
        })
      }
    }
    return skills
  }

  async commandsForStates(states: Record<string, PluginState> = {}): Promise<PluginCommand[]> {
    const loaded = await this.load(states)
    const commands: PluginCommand[] = []
    let totalChars = 0
    for (const plugin of loaded) {
      if (!plugin.enabled || !plugin.valid) continue
      const sourceInfo = await readSourceInfo(plugin.rootPath, plugin.bundled)
      const manifest = await readJsonFile<PluginManifest>(join(plugin.rootPath, PLUGIN_MANIFEST)).catch(() => undefined)
      const paths = await discoverCommandPaths(plugin.rootPath, manifest)
      for (const command of paths) {
        if (!existsSync(command.path) || totalChars >= MAX_TOTAL_COMMAND_CHARS) continue
        const read = await readCommand(command.path).catch(() => null)
        if (!read) continue
        const remaining = MAX_TOTAL_COMMAND_CHARS - totalChars
        const content = read.content.length > remaining ? read.content.slice(0, remaining) : read.content
        totalChars += content.length
        commands.push({
          pluginId: plugin.id,
          pluginName: plugin.manifest?.name ?? plugin.id,
          bundled: plugin.bundled,
          sourceKind: sourceInfo.kind,
          name: command.name,
          description: read.description,
          arguments: read.arguments,
          sourcePath: command.path,
          content,
          truncated: read.truncated || content.length < read.content.length,
        })
      }
    }
    return commands
  }

  async installFromFolder(sourcePath: string): Promise<DiscoveredPlugin> {
    const root = await findPluginRoot(resolve(sourcePath))
    if (!root) throw new Error('Selected folder is not a plugin: missing .claude-plugin/plugin.json')
    const manifest = await readJsonFile<PluginManifest>(join(root, PLUGIN_MANIFEST))
    const name = installFolderName(manifest.name || basename(root))
    return this.installRoot(root, name, { kind: 'local', uri: root, installedAt: Date.now(), updateable: false })
  }

  async installFromZip(zipPath: string): Promise<DiscoveredPlugin> {
    const temp = await mkdtemp(join(tmpdir(), 'ava-plugin-zip-'))
    try {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        resolve(zipPath),
        temp,
      ])
      const root = await findPluginRoot(temp)
      if (!root) throw new Error('Zip does not contain a plugin: missing .claude-plugin/plugin.json')
      const manifest = await readJsonFile<PluginManifest>(join(root, PLUGIN_MANIFEST))
      const name = installFolderName(manifest.name || basename(zipPath).replace(/\.zip$/i, ''))
      return await this.installRoot(root, name, { kind: 'zip', uri: resolve(zipPath), installedAt: Date.now(), updateable: false })
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => { /* noop */ })
    }
  }

  async installFromGit(url: string): Promise<DiscoveredPlugin> {
    const trimmed = url.trim()
    if (!/^https?:\/\/|^git@|^ssh:\/\//i.test(trimmed)) throw new Error('Git URL must be http(s), ssh, or git@ format')
    const temp = await mkdtemp(join(tmpdir(), 'ava-plugin-git-'))
    try {
      await execFileAsync('git', ['clone', '--depth', '1', trimmed, temp])
      const root = await findPluginRoot(temp)
      if (!root) throw new Error('Git repo does not contain a plugin: missing .claude-plugin/plugin.json')
      const manifest = await readJsonFile<PluginManifest>(join(root, PLUGIN_MANIFEST))
      const name = installFolderName(manifest.name || basename(trimmed).replace(/\.git$/i, ''))
      const rootIsRepoRoot = resolve(root).toLowerCase() === resolve(temp).toLowerCase()
      return await this.installRoot(
        root,
        name,
        { kind: 'git', uri: trimmed, installedAt: Date.now(), updateable: rootIsRepoRoot },
        { preserveGit: rootIsRepoRoot },
      )
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => { /* noop */ })
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    const plugin = (await this.load({})).find(item => item.id === pluginId)
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`)
    if (plugin.bundled || !isInside(userPluginsDir(), plugin.rootPath)) {
      throw new Error('Only user-installed plugins can be uninstalled')
    }
    await rm(plugin.rootPath, { recursive: true, force: true })
  }

  async update(pluginId: string): Promise<DiscoveredPlugin> {
    const plugin = (await this.load({})).find(item => item.id === pluginId)
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`)
    if (plugin.source.kind !== 'git' || !plugin.source.uri) {
      throw new Error('Only git-installed plugins can be updated')
    }
    await execFileAsync('git', ['pull', '--ff-only'], plugin.rootPath)
    const updated = await this.loadOne(plugin.rootPath, false, {})
    const { runtimeMcpServers: _runtimeMcpServers, ...view } = updated
    return view
  }

  async getMarketplaceCatalog(): Promise<any[]> {
    // For now, return a static list of catalog items.
    return [
      {
        id: 'windows-mcp',
        name: 'Windows MCP',
        description: 'Control Windows system settings and applications via Model Context Protocol.',
        author: 'CyanVoxel',
        repoUrl: 'https://github.com/CyanVoxel/Windows-MCP',
        icon: 'Monitor',
      },
      {
        id: 'sqlite-mcp',
        name: 'SQLite MCP',
        description: 'Official Model Context Protocol server for SQLite databases.',
        author: 'Anthropic',
        repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
        icon: 'Database',
      }
    ]
  }

  private async load(states: Record<string, PluginState>): Promise<LoadedPlugin[]> {
    const plugins: LoadedPlugin[] = []
    for (const root of this.roots()) {
      if (!existsSync(root.path)) continue
      const entries = await readdir(root.path, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const rootPath = join(root.path, entry.name)
        const manifestPath = join(rootPath, PLUGIN_MANIFEST)
        if (!existsSync(manifestPath)) continue
        plugins.push(await this.loadOne(rootPath, root.bundled, states))
      }
    }
    return plugins.sort((a, b) => a.id.localeCompare(b.id))
  }

  private async loadOne(rootPath: string, bundled: boolean, states: Record<string, PluginState>): Promise<LoadedPlugin> {
    const errors: string[] = []
    const warnings: string[] = []
    const permissions: string[] = []
    let manifestRaw: PluginManifest | undefined
    let manifest: PluginManifestView | undefined
    try {
      manifestRaw = await readJsonFile<PluginManifest>(join(rootPath, PLUGIN_MANIFEST))
      const result = manifestView(manifestRaw)
      manifest = result.manifest
      errors.push(...result.errors)
    } catch (err) {
      errors.push(`failed to read plugin.json: ${err instanceof Error ? err.message : String(err)}`)
    }

    const id = `${bundled ? 'bundled' : 'user'}-${sanitizeId(basename(rootPath)) || 'plugin'}`
    const enabled = states[id] !== undefined ? Boolean(states[id].enabled) : bundled
    const skillPaths = await discoverSkillPaths(rootPath, manifestRaw).catch(err => {
      warnings.push(`failed to inspect skills: ${err instanceof Error ? err.message : String(err)}`)
      return []
    })
    const commandPaths = await discoverCommandPaths(rootPath, manifestRaw).catch(err => {
      warnings.push(`failed to inspect commands: ${err instanceof Error ? err.message : String(err)}`)
      return []
    })
    if (Array.isArray(manifestRaw?.skills) && skillPaths.length < manifestRaw.skills.length) {
      warnings.push('some declared skills were skipped because they are missing or outside skills/')
    }
    if (Array.isArray(manifestRaw?.commands) && commandPaths.length < manifestRaw.commands.length) {
      warnings.push('some declared commands were skipped because they are missing or outside commands/')
    }
    const skills: PluginCapabilityView[] = skillPaths.map(skill => ({
      name: skill.name,
      sourcePath: skill.path,
      status: existsSync(skill.path) && isInside(join(rootPath, 'skills'), skill.path) ? 'loaded' : 'missing',
      ...(!existsSync(skill.path) ? { error: 'SKILL.md not found' } : {}),
    }))
    const commands: PluginCapabilityView[] = commandPaths.map(command => ({
      name: command.name,
      sourcePath: command.path,
      status: existsSync(command.path) && isInside(join(rootPath, 'commands'), command.path) ? 'loaded' : 'missing',
      ...(!existsSync(command.path) ? { error: 'command markdown not found' } : {}),
    }))
    const skillCount = skills.filter(item => item.status === 'loaded').length
    const commandCount = commands.filter(item => item.status === 'loaded').length
    if (skillCount > 0) permissions.push(`Injects ${skillCount} skill file(s) into agent context`)
    if (commandCount > 0) permissions.push(`Exposes ${commandCount} command file(s) in chat input`)
    let runtimeMcpServers: McpServerConfig[] = []
    let mcpServerViews: PluginMcpServerView[] = []
    let mcpServerCount = 0

    const mcpPath = join(rootPath, '.mcp.json')
    if (existsSync(mcpPath)) {
      try {
        const parsed = parseMcpServers(id, rootPath, manifest?.name ?? id, await readJsonFile(mcpPath))
        runtimeMcpServers = parsed.servers
        mcpServerViews = parsed.views
        mcpServerCount = parsed.count
        errors.push(...parsed.errors)
        warnings.push(...parsed.warnings)
        permissions.push(...parsed.permissions)
      } catch (err) {
        warnings.push(`failed to read .mcp.json: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return {
      id,
      rootPath,
      manifest,
      enabled,
      valid: Boolean(manifest) && errors.length === 0,
      bundled,
      source: await readSourceInfo(rootPath, bundled),
      mcpServerCount,
      skillCount,
      commandCount,
      mcpServers: mcpServerViews,
      skills,
      commands,
      permissions: Array.from(new Set(permissions)),
      errors,
      warnings,
      runtimeMcpServers,
    }
  }

  private async installRoot(
    sourceRoot: string,
    requestedName: string,
    source: PluginSourceInfo,
    options: { preserveGit?: boolean } = {},
  ): Promise<DiscoveredPlugin> {
    const targetBase = userPluginsDir()
    await mkdir(targetBase, { recursive: true })
    let target = join(targetBase, requestedName)
    let suffix = 2
    while (existsSync(target)) {
      target = join(targetBase, `${requestedName}-${suffix}`)
      suffix += 1
    }
    await cp(sourceRoot, target, {
      recursive: true,
      filter: src => options.preserveGit || !src.split(/[\\/]/).includes('.git'),
    })
    await writeSourceInfo(target, source)
    const loaded = await this.loadOne(target, false, {})
    const { runtimeMcpServers: _runtimeMcpServers, ...view } = loaded
    return view
  }
}

export const pluginManager = new PluginManager()
