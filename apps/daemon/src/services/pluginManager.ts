import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { PluginManifest } from '@ava/plugin-sdk'
import type { McpServerConfig } from './mcpSupervisor'
import { packagedPluginRoots, runtimePaths, userPluginsDir } from './runtimePaths'

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

export type MarketplaceItemType = 'plugin' | 'skill'
export type MarketplaceItemSource = 'claude' | 'codex' | 'ava'

export interface MarketplaceItem {
  id: string
  type: MarketplaceItemType
  name: string
  description: string
  author: string
  category: string
  source: MarketplaceItemSource
  sourceLabel: string
  sourceUrl?: string
  repoUrl?: string
  installUrl?: string
  installKind: 'git' | 'parent-plugin' | 'unavailable'
  installNote?: string
  parentPluginName?: string
  thumbnailUrl?: string
  installedPluginId?: string
  sourceBadges: string[]
}

export interface MarketplaceCatalog {
  updatedAt: number
  items: MarketplaceItem[]
  warnings: string[]
}

export interface MarketplaceCatalogOptions {
  sources?: MarketplaceItemSource[]
}

export interface PluginSkill {
  pluginId: string
  pluginName: string
  name: string
  sourcePath: string
  content: string
  truncated: boolean
  routingScore?: number
  routingReasons?: string[]
}

export interface PluginSkillCandidate {
  pluginId: string
  pluginName: string
  name: string
  sourcePath: string
  summary: string
  tags: string[]
  contentPreview: string
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
const MAX_SKILL_METADATA_CHARS = 2_000
const MAX_COMMAND_CHARS = 8_000
const MAX_TOTAL_COMMAND_CHARS = 32_000
const SOURCE_META = '.ava-plugin-source.json'

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

const CLAUDE_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json'
const CLAUDE_MARKETPLACE_REPO = 'https://github.com/anthropics/claude-plugins-official'
const CODEX_MARKETPLACE_ORIGIN = 'https://www.codex-marketplace.com'

interface ClaudeMarketplacePlugin {
  name?: unknown
  description?: unknown
  category?: unknown
  author?: { name?: unknown } | unknown
  source?: unknown
}

function pluginToMarketplaceItems(plugin: LoadedPlugin): MarketplaceItem[] {
  const pluginName = plugin.manifest?.name ?? basename(plugin.rootPath)
  const category = plugin.bundled ? 'bundled' : 'installed'
  const pluginItem: MarketplaceItem = {
    id: `ava:plugin:${plugin.id}`,
    type: 'plugin',
    name: pluginName,
    description: plugin.manifest?.description ?? plugin.rootPath,
    author: plugin.bundled ? 'Ava' : 'Local',
    category,
    source: 'ava',
    sourceLabel: 'Ava Local',
    sourceUrl: plugin.rootPath,
    repoUrl: plugin.source.uri,
    installKind: 'unavailable',
    installNote: 'Already available locally.',
    installedPluginId: plugin.id,
    sourceBadges: ['Ava'],
  }
  const skillItems: MarketplaceItem[] = plugin.skills.map(skill => ({
    id: `ava:skill:${plugin.id}:${sanitizeId(skill.name) || 'skill'}`,
    type: 'skill',
    name: skill.name,
    description: `Skill from ${pluginName}`,
    author: pluginName,
    category,
    source: 'ava',
    sourceLabel: 'Ava Local',
    sourceUrl: skill.sourcePath,
    repoUrl: plugin.source.uri,
    installKind: 'parent-plugin',
    installNote: 'Installed through its parent plugin.',
    parentPluginName: pluginName,
    installedPluginId: plugin.id,
    sourceBadges: ['Ava'],
  }))
  return [pluginItem, ...skillItems]
}

async function loadClaudeMarketplace(): Promise<MarketplaceItem[]> {
  const response = await fetch(CLAUDE_MARKETPLACE_URL)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const catalog = await response.json() as { plugins?: ClaudeMarketplacePlugin[] }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : []
  return plugins.map(plugin => {
    const name = stringValue(plugin.name, 'unknown-plugin')
    const source = claudeSource(plugin.source)
    const author = typeof plugin.author === 'object' && plugin.author
      ? stringValue((plugin.author as { name?: unknown }).name, 'Unknown')
      : 'Unknown'
    const installUrl = source.installable ? source.repoUrl : undefined
    return {
      id: `claude:plugin:${sanitizeId(name) || 'plugin'}:${sanitizeId(source.sourceUrl ?? '') || 'source'}`,
      type: 'plugin',
      name,
      description: stringValue(plugin.description, 'Claude Code plugin'),
      author,
      category: stringValue(plugin.category, 'uncategorized'),
      source: 'claude',
      sourceLabel: 'Claude Official',
      sourceUrl: source.sourceUrl,
      repoUrl: source.repoUrl,
      installUrl,
      installKind: installUrl ? 'git' : 'unavailable',
      installNote: installUrl ? undefined : source.note,
      sourceBadges: ['Claude'],
    } satisfies MarketplaceItem
  })
}

async function loadCodexMarketplace(): Promise<MarketplaceItem[]> {
  const [plugins, skills] = await Promise.all([
    loadCodexPage('plugin', `${CODEX_MARKETPLACE_ORIGIN}/plugins`),
    loadCodexPage('skill', `${CODEX_MARKETPLACE_ORIGIN}/skills`),
  ])
  return [...plugins, ...skills]
}

async function loadCodexPage(type: MarketplaceItemType, url: string): Promise<MarketplaceItem[]> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  const cards = html.split('plugin-card-link block" href="').slice(1)
  return cards.map(card => parseCodexCard(type, card)).filter((item): item is MarketplaceItem => Boolean(item))
}

function parseCodexCard(type: MarketplaceItemType, card: string): MarketplaceItem | null {
  const path = card.slice(0, card.indexOf('"'))
  const name = htmlDecode(matchFirst(card, /<h3[^>]*>([\s\S]*?)<\/h3>/))
  if (!name) return null
  const author = htmlDecode(matchFirst(card, /<p class="mt-1[^"]*"[^>]*>([\s\S]*?)<\/p>/)) || 'Unknown'
  const description = htmlDecode(matchFirst(card, /<p class="mt-4 line-clamp-2[^"]*"[^>]*>([\s\S]*?)<\/p>/)) || 'Codex marketplace item'
  const tags = Array.from(card.matchAll(/<span class="inline-flex[^"]*"[^>]*>([\s\S]*?)<\/span>/g))
    .map(match => htmlDecode(match[1]))
    .filter(Boolean)
  const installCommand = htmlDecode(matchFirst(card, /<code[^>]*>([\s\S]*?codex-marketplace add[\s\S]*?)<\/code>/))
    .replace(/\s+/g, ' ')
    .replace(/\$ npx/g, 'npx')
    .trim()
  const sourcePath = installCommand.match(/codex-marketplace add ([^\s]+)\s/)?.[1]
  const repoUrl = sourcePath ? githubRepoFromCodexPath(sourcePath) : undefined
  const category = tags.find(tag => !/^(plugin|skill|hook)$/i.test(tag)) ?? 'uncategorized'
  return {
    id: `codex:${type}:${sanitizeId(sourcePath ?? (path || name)) || 'item'}`,
    type,
    name,
    description,
    author,
    category,
    source: 'codex',
    sourceLabel: 'Codex Community',
    sourceUrl: `${CODEX_MARKETPLACE_ORIGIN}${path}`,
    repoUrl,
    installUrl: type === 'plugin' ? repoUrl : undefined,
    installKind: type === 'plugin' && repoUrl ? 'git' : 'unavailable',
    installNote: type === 'skill'
      ? 'Standalone Codex skill install is not wired in Ava yet.'
      : repoUrl ? undefined : 'No Git install source found.',
    sourceBadges: ['Codex'],
  }
}

function mergeMarketplaceItems(items: MarketplaceItem[], localPlugins: LoadedPlugin[]): MarketplaceItem[] {
  const map = new Map<string, MarketplaceItem>()
  for (const item of items) {
    const key = marketplaceDedupeKey(item)
    const existing = map.get(key)
    if (!existing) {
      map.set(key, markInstalled(item, localPlugins))
      continue
    }
    map.set(key, {
      ...existing,
      description: longerText(existing.description, item.description),
      sourceBadges: Array.from(new Set([...existing.sourceBadges, ...item.sourceBadges])),
      installedPluginId: existing.installedPluginId ?? item.installedPluginId,
      installUrl: existing.installUrl ?? item.installUrl,
      installKind: existing.installKind === 'git' ? existing.installKind : item.installKind,
      installNote: existing.installNote ?? item.installNote,
    })
  }
  return Array.from(map.values()).sort((a, b) =>
    a.type.localeCompare(b.type) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  )
}

function normalizeMarketplaceSources(sources?: MarketplaceItemSource[]): Set<MarketplaceItemSource> {
  const allowed: MarketplaceItemSource[] = ['claude', 'codex', 'ava']
  if (!Array.isArray(sources) || sources.length === 0) return new Set(allowed)
  const selected = sources.filter((source): source is MarketplaceItemSource => allowed.includes(source))
  return new Set(selected.length > 0 ? selected : allowed)
}

function markInstalled(item: MarketplaceItem, localPlugins: LoadedPlugin[]): MarketplaceItem {
  if (item.installedPluginId) return item
  const itemRepo = normalizeRepoUrl(item.repoUrl ?? item.installUrl ?? '')
  if (!itemRepo) return item
  const installed = localPlugins.find(plugin => normalizeRepoUrl(plugin.source.uri ?? '') === itemRepo)
  return installed ? { ...item, installedPluginId: installed.id } : item
}

function marketplaceDedupeKey(item: MarketplaceItem): string {
  const repo = normalizeRepoUrl(item.repoUrl ?? item.installUrl ?? '')
  if (repo) return `${item.type}:repo:${repo}`
  return `${item.type}:name:${sanitizeId(item.name) || 'item'}`
}

function claudeSource(raw: unknown): { sourceUrl?: string; repoUrl?: string; installable: boolean; note?: string } {
  if (typeof raw === 'string') {
    if (raw.startsWith('./')) {
      return {
        sourceUrl: `${CLAUDE_MARKETPLACE_REPO}/tree/main/${raw.replace(/^\.\//, '')}`,
        installable: false,
        note: 'Claude marketplace subdirectory plugins are listed but not directly installable by Ava yet.',
      }
    }
    return { sourceUrl: raw, repoUrl: raw, installable: /^https?:|^git@/.test(raw) }
  }
  if (raw && typeof raw === 'object') {
    const src = raw as { url?: unknown; path?: unknown }
    const url = stringValue(src.url)
    const path = stringValue(src.path)
    if (url && path) {
      return {
        sourceUrl: `${url.replace(/\.git$/, '')}/tree/main/${path}`,
        repoUrl: url,
        installable: false,
        note: 'Git subdirectory plugins are listed but not directly installable by Ava yet.',
      }
    }
    if (url) return { sourceUrl: url, repoUrl: url, installable: true }
  }
  return { installable: false, note: 'Unknown marketplace source format.' }
}

function githubRepoFromCodexPath(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  return `https://github.com/${parts[0]}/${parts[1]}.git`
}

function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function longerText(a: string, b: string): string {
  return b.length > a.length ? b : a
}

function matchFirst(text: string, re: RegExp): string {
  return text.match(re)?.[1] ?? ''
}

function htmlDecode(text: string): string {
  return text
    .replace(/<!--\s*-->/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, '')
    .trim()
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

async function readSkillMetadata(path: string): Promise<{ summary: string; tags: string[]; contentPreview: string; truncated: boolean }> {
  const raw = await readFile(path, 'utf8')
  const preview = raw.slice(0, MAX_SKILL_METADATA_CHARS)
  return {
    summary: extractSkillSummary(preview),
    tags: extractSkillTags(preview),
    contentPreview: preview,
    truncated: raw.length > preview.length,
  }
}

function extractSkillSummary(content: string): string {
  const frontmatter = content.match(/^---\s*([\s\S]*?)\s*---/)
  const frontmatterDescription = frontmatter?.[1]?.match(/^description:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim()
  if (frontmatterDescription) return frontmatterDescription.slice(0, 500)
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading.slice(0, 300)
  return content
    .replace(/^---[\s\S]*?---/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 20)?.slice(0, 300) ?? ''
}

function extractSkillTags(content: string): string[] {
  const tags = new Set<string>()
  const frontmatter = content.match(/^---\s*([\s\S]*?)\s*---/)?.[1] ?? ''
  const name = frontmatter.match(/^name:\s*["']?(.+?)["']?\s*$/im)?.[1]
  if (name) tokenizeSkillText(name).forEach(tag => tags.add(tag))
  const description = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/im)?.[1]
  if (description) tokenizeSkillText(description).slice(0, 16).forEach(tag => tags.add(tag))
  tokenizeSkillText(content.slice(0, 1200)).slice(0, 24).forEach(tag => tags.add(tag))
  return [...tags].slice(0, 32)
}

function tokenizeSkillText(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/i)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && item.length <= 40)
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
    const cwd = runtimePaths().projectRoot
    return uniqueRoots([
      { path: join(cwd, BUNDLED_DIR), bundled: true },
      { path: join(cwd, USER_DIR), bundled: false },
      ...packagedPluginRoots(),
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

  async skillCandidatesForStates(states: Record<string, PluginState> = {}): Promise<PluginSkillCandidate[]> {
    const loaded = await this.load(states)
    const candidates: PluginSkillCandidate[] = []
    for (const plugin of loaded) {
      if (!plugin.enabled || !plugin.valid) continue
      const manifest = await readJsonFile<PluginManifest>(join(plugin.rootPath, PLUGIN_MANIFEST)).catch(() => undefined)
      const paths = await discoverSkillPaths(plugin.rootPath, manifest)
      for (const skill of paths) {
        if (!existsSync(skill.path)) continue
        const metadata = await readSkillMetadata(skill.path).catch(() => null)
        if (!metadata) continue
        candidates.push({
          pluginId: plugin.id,
          pluginName: plugin.manifest?.name ?? plugin.id,
          name: skill.name,
          sourcePath: skill.path,
          summary: metadata.summary,
          tags: metadata.tags,
          contentPreview: metadata.contentPreview,
          truncated: metadata.truncated,
        })
      }
    }
    return candidates
  }

  async skillsForCandidates(candidates: PluginSkillCandidate[]): Promise<PluginSkill[]> {
    const skills: PluginSkill[] = []
    let totalChars = 0
    for (const candidate of candidates) {
      if (!existsSync(candidate.sourcePath) || totalChars >= MAX_TOTAL_SKILL_CHARS) continue
      const read = await readSkill(candidate.sourcePath).catch(() => null)
      if (!read) continue
      const remaining = MAX_TOTAL_SKILL_CHARS - totalChars
      const content = read.content.length > remaining ? read.content.slice(0, remaining) : read.content
      totalChars += content.length
      skills.push({
        pluginId: candidate.pluginId,
        pluginName: candidate.pluginName,
        name: candidate.name,
        sourcePath: candidate.sourcePath,
        content,
        truncated: read.truncated || content.length < read.content.length,
      })
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

  async getMarketplaceCatalog(
    states: Record<string, PluginState> = {},
    options: MarketplaceCatalogOptions = {},
  ): Promise<MarketplaceCatalog> {
    const warnings: string[] = []
    const enabledSources = normalizeMarketplaceSources(options.sources)
    const needsLocalPlugins = enabledSources.has('ava') || enabledSources.has('claude') || enabledSources.has('codex')
    const localPlugins = needsLocalPlugins ? await this.load(states).catch(err => {
      warnings.push(`Failed to read local plugins: ${err instanceof Error ? err.message : String(err)}`)
      return [] as LoadedPlugin[]
    }) : []
    const localItems = enabledSources.has('ava') ? localPlugins.flatMap(pluginToMarketplaceItems) : []
    const [claudeItems, codexItems] = await Promise.all([
      enabledSources.has('claude')
        ? loadClaudeMarketplace().catch(err => {
            warnings.push(`Claude marketplace unavailable: ${err instanceof Error ? err.message : String(err)}`)
            return [] as MarketplaceItem[]
          })
        : Promise.resolve([]),
      enabledSources.has('codex')
        ? loadCodexMarketplace().catch(err => {
            warnings.push(`Codex marketplace unavailable: ${err instanceof Error ? err.message : String(err)}`)
            return [] as MarketplaceItem[]
          })
        : Promise.resolve([]),
    ])
    const items = mergeMarketplaceItems([...claudeItems, ...codexItems, ...localItems], localPlugins)
    return {
      updatedAt: Date.now(),
      items,
      warnings,
    }
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
