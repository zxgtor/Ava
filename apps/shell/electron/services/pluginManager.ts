import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
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

export interface PluginMcpServerView {
  id?: string
  name: string
  type: 'stdio' | 'http' | 'sse' | 'unknown'
  status: 'loaded' | 'unsupported' | 'invalid'
  command?: string
  args?: string[]
  cwd?: string
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
  name: string
  sourcePath: string
  content: string
  truncated: boolean
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

async function readCommand(path: string): Promise<{ content: string; truncated: boolean }> {
  const raw = await readFile(path, 'utf8')
  if (raw.length <= MAX_COMMAND_CHARS) return { content: raw, truncated: false }
  return {
    content: raw.slice(0, MAX_COMMAND_CHARS),
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
    const args = Array.isArray(spec.args) ? spec.args.map(String) : []
    servers.push({
      id: serverId,
      name: `${manifestName}: ${name}`,
      command: spec.command,
      args,
      env: isRecord(spec.env) ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : undefined,
      cwd,
      enabled: true,
      builtin: false,
      pluginId,
    })
    views.push({ id: serverId, name, type: 'stdio', status: 'loaded', command: spec.command, args, cwd })
    permissions.push(`Starts MCP process: ${spec.command}${args.length ? ` ${args.join(' ')}` : ''}`)
    permissions.push(`MCP working directory: ${cwd}`)
    if (isRecord(spec.env) && Object.keys(spec.env).length > 0) {
      permissions.push(`Sets environment variables: ${Object.keys(spec.env).join(', ')}`)
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
          name: command.name,
          sourcePath: command.path,
          content,
          truncated: read.truncated || content.length < read.content.length,
        })
      }
    }
    return commands
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
    const enabled = Boolean(states[id]?.enabled)
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
}

export const pluginManager = new PluginManager()
