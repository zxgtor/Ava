import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
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
  errors: string[]
}

interface LoadedPlugin extends DiscoveredPlugin {
  mcpServers: McpServerConfig[]
}

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
const BUNDLED_DIR = 'plugins'
const USER_DIR = 'user-plugins'

function findProjectRoot(): string {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, USER_DIR)) || existsSync(join(dir, BUNDLED_DIR))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return process.cwd()
    dir = parent
  }
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

async function countCommandFiles(rootPath: string, manifest?: PluginManifest): Promise<number> {
  if (Array.isArray(manifest?.commands)) return manifest.commands.length
  const commandsDir = join(rootPath, 'commands')
  if (!existsSync(commandsDir)) return 0
  const entries = await readdir(commandsDir, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).length
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
  count: number
  errors: string[]
} {
  const errors: string[] = []
  const servers: McpServerConfig[] = []
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    return { servers, count: 0, errors: ['.mcp.json missing object field: mcpServers'] }
  }

  const serverSpecs = raw.mcpServers
  for (const [name, spec] of Object.entries(serverSpecs)) {
    if (!isRecord(spec)) {
      errors.push(`MCP server "${name}" must be an object`)
      continue
    }
    if (!isStdioServer(spec)) {
      errors.push(`MCP server "${name}" is not stdio; only stdio is supported now`)
      continue
    }
    const serverId = `${pluginId}-${sanitizeId(name) || 'server'}`
    servers.push({
      id: serverId,
      name: `${manifestName}: ${name}`,
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      env: isRecord(spec.env) ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : undefined,
      cwd: typeof spec.cwd === 'string' && spec.cwd.trim() ? resolve(rootPath, spec.cwd) : rootPath,
      enabled: true,
      builtin: false,
      pluginId,
    })
  }

  return { servers, count: Object.keys(serverSpecs).length, errors }
}

export class PluginManager {
  private roots(): Array<{ path: string; bundled: boolean }> {
    const cwd = findProjectRoot()
    return [
      { path: join(cwd, BUNDLED_DIR), bundled: true },
      { path: join(cwd, USER_DIR), bundled: false },
    ]
  }

  async discover(states: Record<string, PluginState> = {}): Promise<DiscoveredPlugin[]> {
    const loaded = await this.load(states)
    return loaded.map(({ mcpServers: _mcpServers, ...view }) => view)
  }

  async mcpServersForStates(states: Record<string, PluginState> = {}): Promise<McpServerConfig[]> {
    const loaded = await this.load(states)
    return loaded.flatMap(plugin => plugin.enabled && plugin.valid ? plugin.mcpServers : [])
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
    const skillCount = await countSkillDirs(rootPath, manifestRaw).catch(() => 0)
    const commandCount = await countCommandFiles(rootPath, manifestRaw).catch(() => 0)
    let mcpServers: McpServerConfig[] = []
    let mcpServerCount = 0

    const mcpPath = join(rootPath, '.mcp.json')
    if (existsSync(mcpPath)) {
      try {
        const parsed = parseMcpServers(id, rootPath, manifest?.name ?? id, await readJsonFile(mcpPath))
        mcpServers = parsed.servers
        mcpServerCount = parsed.count
        errors.push(...parsed.errors)
      } catch (err) {
        errors.push(`failed to read .mcp.json: ${err instanceof Error ? err.message : String(err)}`)
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
      errors,
      mcpServers,
    }
  }
}

export const pluginManager = new PluginManager()
