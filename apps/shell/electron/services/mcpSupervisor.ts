// ─────────────────────────────────────────────────────────────
// MCP Supervisor
// -------------------------------------------------------------
// Owns the lifecycle of stdio MCP servers: spawn, connect via
// @modelcontextprotocol/sdk, list tools, execute tool calls,
// auto-restart on crash (once), clean shutdown on app quit.
//
// One supervisor instance per Electron main process. Shared by
// all conversations — a running server is a process-level resource.
// ─────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { WebContents } from 'electron'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// ── Types ─────────────────────────────────────────────────────

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  enabled: boolean
  allowedDirs?: string[]
  builtin?: boolean
  pluginId?: string
}

export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface McpToolDescriptor {
  /** Raw name as reported by the server (without namespace). */
  rawName: string
  /** Namespaced tool name Ava exposes to the LLM: `serverId.rawName`. */
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpServerRuntime {
  id: string
  name: string
  enabled: boolean
  allowedDirs?: string[]
  builtin?: boolean
  pluginId?: string
  status: McpServerStatus
  pid?: number
  tools?: McpToolDescriptor[]
  lastError?: string
  startedAt?: number
}

export interface CallToolResult {
  ok: true
  content: unknown
  isError?: boolean
}

export interface CallToolError {
  ok: false
  error: string
  aborted?: boolean
}

// ── Internal entry ────────────────────────────────────────────

interface Entry {
  config: McpServerConfig
  status: McpServerStatus
  pid?: number
  client?: Client
  transport?: StdioClientTransport
  tools?: McpToolDescriptor[]
  lastError?: string
  startedAt?: number
  /** The in-flight call's AbortController, if any — used for Abort support. */
  activeCall?: AbortController
  /** true after we have already tried one auto-restart in this run. */
  restartedOnce?: boolean
}

// ── Supervisor ────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32'
const CLIENT_NAME = 'ava-shell'
const CLIENT_VERSION = '0.1.0'
const CONNECT_TIMEOUT_MS = 30_000

/**
 * Resolve a command to an absolute/runnable form on Windows, where
 * `spawn('npx', ...)` without shell:true does not find `.cmd` shims.
 */
function resolveCommand(cmd: string): string {
  if (!IS_WIN) return cmd
  if (cmd.endsWith('.exe') || cmd.endsWith('.cmd') || cmd.endsWith('.bat')) return cmd
  // npx / npm / yarn / pnpm etc. ship as .cmd on Windows
  return `${cmd}.cmd`
}

/** Sanitize + check allowedDirs; drops missing / non-absolute-resolvable entries. */
function sanitizeAllowedDirs(dirs: string[] | undefined): string[] {
  if (!Array.isArray(dirs)) return []
  const out: string[] = []
  for (const raw of dirs) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    let abs: string
    try {
      abs = resolvePath(raw.trim())
    } catch {
      continue
    }
    if (!existsSync(abs)) continue
    out.push(abs)
  }
  return out
}

/** Build the concrete spawn args for a given config (appending whitelisted dirs for filesystem). */
function buildSpawnArgs(config: McpServerConfig): { args: string[]; missingWhitelist: boolean } {
  if (config.id === 'filesystem') {
    const dirs = sanitizeAllowedDirs(config.allowedDirs)
    return { args: [...config.args, ...dirs], missingWhitelist: dirs.length === 0 }
  }
  return { args: [...config.args], missingWhitelist: false }
}

export class McpSupervisor extends EventEmitter {
  private entries = new Map<string, Entry>()
  /** Where we broadcast `ava:mcp:status` payloads; set by wire(webContents). */
  private broadcastTarget: WebContents | null = null

  wire(webContents: WebContents): void {
    this.broadcastTarget = webContents
  }

  listServers(): McpServerRuntime[] {
    return Array.from(this.entries.values()).map(e => this.toRuntime(e))
  }

  getServer(id: string): McpServerRuntime | null {
    const e = this.entries.get(id)
    return e ? this.toRuntime(e) : null
  }

  /** Full list of all tools across all running servers. Namespaced names. */
  listAllTools(): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = []
    for (const e of this.entries.values()) {
      if (e.status === 'running' && e.tools) out.push(...e.tools)
    }
    return out
  }

  /** Find a tool by its namespaced name; returns the owning server id + raw name. */
  resolveTool(namespacedName: string): { serverId: string; rawName: string } | null {
    const dotIdx = namespacedName.indexOf('.')
    if (dotIdx > 0) {
      const serverId = namespacedName.slice(0, dotIdx)
      const rawName = namespacedName.slice(dotIdx + 1)
      const entry = this.entries.get(serverId)
      if (entry?.tools?.some(t => t.rawName === rawName)) {
        return { serverId, rawName }
      }
    }
    // Fallback: bare name that matches exactly one running tool.
    const matches = this.listAllTools().filter(t => t.rawName === namespacedName)
    if (matches.length === 1) {
      const [serverId] = matches[0].name.split('.')
      return { serverId, rawName: namespacedName }
    }
    return null
  }

  /**
   * Reconcile running state to match `configs`:
   *   - new/enabled/config-changed server → (re)start
   *   - disabled/removed server → stop
   *   - unchanged + running → skip
   */
  async applyConfigs(configs: McpServerConfig[]): Promise<void> {
    const nextIds = new Set(configs.map(c => c.id))

    // Stop removed servers
    for (const id of Array.from(this.entries.keys())) {
      if (!nextIds.has(id)) {
        await this.stop(id).catch(() => { /* swallow */ })
      }
    }

    // (Re)apply each config
    for (const config of configs) {
      const existing = this.entries.get(config.id)
      if (!config.enabled) {
        // Ensure stopped; keep the entry around so the UI still sees a 'stopped' row.
        if (existing && existing.status !== 'stopped') {
          await this.stop(config.id).catch(() => { /* swallow */ })
        }
        this.entries.set(config.id, {
          config,
          status: 'stopped',
        })
        this.broadcast(config.id)
        continue
      }

      const configChanged = !existing || !sameLaunchShape(existing.config, config)
      if (existing && existing.status === 'running' && !configChanged) {
        // Update in-memory config (UI fields like `name`) without restart
        existing.config = config
        this.broadcast(config.id)
        continue
      }

      // Either not started or shape changed: start / restart
      if (existing && existing.status !== 'stopped') {
        await this.stop(config.id).catch(() => { /* swallow */ })
      }
      this.entries.set(config.id, { config, status: 'stopped' })
      await this.start(config.id).catch(err => {
        console.warn(`[mcp] start ${config.id} failed:`, err)
      })
    }
  }

  async start(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId)
    if (!entry) throw new Error(`no such server: ${serverId}`)
    if (entry.status === 'running' || entry.status === 'starting') return

    const { config } = entry
    if (!config.enabled) {
      entry.status = 'stopped'
      this.broadcast(serverId)
      return
    }

    const { args, missingWhitelist } = buildSpawnArgs(config)
    if (missingWhitelist) {
      entry.status = 'error'
      entry.lastError = 'allowed directories are empty; add at least one before enabling'
      this.broadcast(serverId)
      return
    }

    entry.status = 'starting'
    entry.lastError = undefined
    this.broadcast(serverId)

    const command = resolveCommand(config.command)
    // Merge process.env so npx can resolve PATH etc. User env overrides.
    const mergedEnv = {
      ...(process.env as Record<string, string>),
      ...(config.env ?? {}),
    }

    try {
      const transport = new StdioClientTransport({
        command,
        args,
        env: mergedEnv,
        cwd: config.cwd,
      })
      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        { capabilities: {} },
      )

      // Crash handler: SDK wires process.on('exit') into transport.onclose.
      transport.onclose = () => {
        const current = this.entries.get(serverId)
        if (!current) return
        if (current.status === 'running') {
          // Unexpected exit — try one restart, then give up.
          current.status = 'error'
          current.lastError = 'server process exited unexpectedly'
          current.pid = undefined
          this.broadcast(serverId)
          if (!current.restartedOnce && current.config.enabled) {
            current.restartedOnce = true
            console.warn(`[mcp] ${serverId} crashed; attempting one restart`)
            this.start(serverId).catch(e => console.warn('[mcp] restart failed:', e))
          }
        }
      }
      transport.onerror = err => {
        console.warn(`[mcp] ${serverId} transport error:`, err)
      }

      // Connect with a hard timeout.
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `connect to ${serverId} timed out after ${CONNECT_TIMEOUT_MS}ms`,
      )

      // List tools immediately; cache for LLM integration.
      const toolList = await client.listTools()
      const tools: McpToolDescriptor[] = (toolList.tools ?? []).map(t => ({
        rawName: t.name,
        name: `${serverId}.${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
      }))

      entry.client = client
      entry.transport = transport
      entry.tools = tools
      entry.status = 'running'
      entry.startedAt = Date.now()
      entry.restartedOnce = false // reset on successful boot
      // PID is not directly exposed by StdioClientTransport; skip for now.
      this.broadcast(serverId)
      console.info(`[mcp] ${serverId} running with ${tools.length} tool(s)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      entry.status = 'error'
      entry.lastError = msg
      entry.client = undefined
      entry.transport = undefined
      this.broadcast(serverId)
      console.warn(`[mcp] ${serverId} failed to start:`, msg)
      throw err
    }
  }

  async stop(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId)
    if (!entry) return
    const { client, transport } = entry
    entry.client = undefined
    entry.transport = undefined
    entry.tools = undefined
    entry.status = 'stopped'
    entry.pid = undefined
    entry.startedAt = undefined
    // clear onclose before closing so we don't trigger the crash-restart logic
    if (transport) transport.onclose = undefined
    try {
      if (client) await client.close()
    } catch { /* noop */ }
    try {
      if (transport) await transport.close()
    } catch { /* noop */ }
    this.broadcast(serverId)
  }

  async restart(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId)
    if (!entry) throw new Error(`no such server: ${serverId}`)
    entry.restartedOnce = false
    await this.stop(serverId)
    await this.start(serverId)
  }

  async callTool(args: {
    namespacedName: string
    rawArgs: Record<string, unknown>
  }): Promise<CallToolResult | CallToolError> {
    const resolved = this.resolveTool(args.namespacedName)
    if (!resolved) {
      return { ok: false, error: `unknown tool: ${args.namespacedName}` }
    }
    const entry = this.entries.get(resolved.serverId)
    if (!entry || entry.status !== 'running' || !entry.client) {
      return { ok: false, error: `server ${resolved.serverId} is not running` }
    }

    const ac = new AbortController()
    entry.activeCall = ac

    try {
      const result = await entry.client.callTool({
        name: resolved.rawName,
        arguments: args.rawArgs,
      }, undefined, {
        signal: ac.signal,
      })
      return {
        ok: true,
        content: result.content,
        isError: Boolean(result.isError),
      }
    } catch (err) {
      if (ac.signal.aborted) {
        return { ok: false, error: 'aborted', aborted: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    } finally {
      if (entry.activeCall === ac) entry.activeCall = undefined
    }
  }

  /** Abort the most recently started tool call for this server. */
  abortActiveCall(serverId: string): void {
    const entry = this.entries.get(serverId)
    entry?.activeCall?.abort()
  }

  /** Abort all in-flight calls across all servers. Used on user-level Stop. */
  abortAllCalls(): void {
    for (const entry of this.entries.values()) {
      entry.activeCall?.abort()
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.entries.keys()).map(id => this.stop(id)),
    )
    this.entries.clear()
  }

  // ── helpers ─────────────────────────────────────────────────

  private toRuntime(e: Entry): McpServerRuntime {
    return {
      id: e.config.id,
      name: e.config.name,
      enabled: e.config.enabled,
      allowedDirs: e.config.allowedDirs,
      builtin: e.config.builtin,
      pluginId: e.config.pluginId,
      status: e.status,
      pid: e.pid,
      tools: e.tools,
      lastError: e.lastError,
      startedAt: e.startedAt,
    }
  }

  private broadcast(serverId: string): void {
    const entry = this.entries.get(serverId)
    if (!entry) return
    const target = this.broadcastTarget
    if (!target || target.isDestroyed()) return
    target.send('ava:mcp:status', this.toRuntime(entry))
  }
}

// ── helpers ─────────────────────────────────────────────────

function sameLaunchShape(a: McpServerConfig, b: McpServerConfig): boolean {
  if (a.command !== b.command) return false
  if (JSON.stringify(a.args) !== JSON.stringify(b.args)) return false
  if (JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})) return false
  if ((a.cwd ?? '') !== (b.cwd ?? '')) return false
  if (JSON.stringify(a.allowedDirs ?? []) !== JSON.stringify(b.allowedDirs ?? [])) return false
  return true
}

async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Singleton (created lazily at first import)
export const mcpSupervisor = new McpSupervisor()
