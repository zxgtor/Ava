import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  builtInTools,
  loadConversations,
  loadSettings,
  mcpSupervisor,
  pluginManager,
  saveConversations,
  saveSettings,
  streamChat,
  toolAuditLog,
  type McpServerConfig,
  type MarketplaceCatalogOptions,
  type PluginState,
  type RuntimeStreamEvent,
  type StreamChatArgs,
} from './index'
import type {
  AvaChatStreamEvent,
  AvaChatStreamRequest,
  AvaTaskPlanClearRequest,
  AvaTaskPlanGetRequest,
  AvaTaskPlanSetRequest,
  AvaTaskPlanStateResult,
  TaskExecutionPlan,
} from '@ava/contracts'
import { runtimePaths } from './services/runtimePaths'
import { resolveStreamChatArgsFromDaemonConfig, type DaemonStreamOptions } from './services/modelRouter'
import { streamTaskExecutionPlan } from './agentTaskLoop'
import { analyzeTask, planTask } from './agentPlanner'
import { replyIntakeSession, startIntakeSession } from './agentIntakeSession'
import { classifyInputWithFallback } from './agentInputRouter'
import { dispatchInput } from './agentWorkflowDispatcher'
import { clearActiveTaskPlan, getActiveTaskPlan, setActiveTaskPlan } from './agentTaskPlanRegistry'
import { buildDaemonChatMessages, isAvaChatClientContext } from './chatContextBuilder'
import { probeModelCapabilities, probeModels } from './services/modelCapabilityProbe'
import { getProjectBrief } from './services/projectContext'
import {
  createWorkspaceDir,
  ensureProjectDocs,
  listWorkspaceDir,
  openEnvironmentPath,
  openEnvironmentTerminal,
  openEnvironmentVSCode,
  readWorkspaceText,
  writeWorkspaceText,
} from './services/workspaceEnvironment'
import { installCodeAgent, probeCodeAgents } from './services/codeAgentProbe'
import {
  dispatchCodeAgentTask,
  listCodeAgentProfiles,
  listCodeAgentSessions,
  sendCodeAgentSessionMessage,
  startCodeAgentSession,
  stopCodeAgentSession,
} from './services/codeAgentDispatcher'

const UNIT_TEST_WORKSPACE_DIR = '.ava-unit-test-workspace'
const UNIT_TEST_RESULTS_FILE = 'unit-test-results.jsonl'

type EmitDaemonEvent = (event: AvaChatStreamEvent) => void

function isBrokenPipeError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EPIPE')
}

function isPluginStates(raw: unknown): raw is Record<string, PluginState> {
  if (!raw || typeof raw !== 'object') return false
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object') return false
  }
  return true
}

async function readRuntimeMcpServers(raw: unknown): Promise<McpServerConfig[] | null> {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as { version?: unknown; mcpServers?: unknown; pluginStates?: unknown }
  if (src.version !== 2 || !Array.isArray(src.mcpServers)) return null
  const baseServers = src.mcpServers
    .filter((item): item is McpServerConfig => Boolean(item && typeof item === 'object' && typeof (item as McpServerConfig).id === 'string'))
  const pluginStates = isPluginStates(src.pluginStates) ? src.pluginStates : {}
  const pluginServers = await pluginManager.mcpServersForStates(pluginStates)
  return [...baseServers, ...pluginServers]
}

async function streamChatArgsFromRequest(request: AvaChatStreamRequest): Promise<StreamChatArgs> {
  const metadata = request.metadata as { clientContext?: unknown; streamChatArgs?: unknown } | undefined
  const streamOptions = (request.metadata as { streamOptions?: unknown } | undefined)?.streamOptions as Partial<DaemonStreamOptions> | undefined
  const streamId = typeof streamOptions?.streamId === 'string'
    ? streamOptions.streamId
    : typeof request.runId === 'string' && request.runId.trim()
      ? request.runId
      : `daemon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  if (isAvaChatClientContext(metadata?.clientContext)) {
    const args = await resolveStreamChatArgsFromDaemonConfig([], {
      ...(streamOptions ?? {}),
      streamId,
      conversationId: streamOptions?.conversationId ?? request.conversationId,
    })
    const settings = (await loadSettings() ?? {}) as Record<string, unknown>
    return {
      ...args,
      messages: buildDaemonChatMessages({
        context: metadata.clientContext,
        settings,
        providers: args.providers,
        activeTaskPlan: args.activeTaskPlan,
      }),
    }
  }

  const args = metadata?.streamChatArgs as StreamChatArgs | undefined
  if (args && Array.isArray(args.messages) && Array.isArray(args.providers)) {
    return {
      ...args,
      conversationId: args.conversationId ?? request.conversationId,
    }
  }

  return resolveStreamChatArgsFromDaemonConfig(request.messages as StreamChatArgs['messages'], {
    ...(streamOptions ?? {}),
    streamId,
    conversationId: streamOptions?.conversationId ?? request.conversationId,
  })
}

function createRuntimeEventTarget(args: StreamChatArgs, emit: EmitDaemonEvent): { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } {
  let closed = false
  let started = false

  const ensureStarted = () => {
    if (started) return
    started = true
    emit({
      type: 'chat.run.started',
      runId: args.streamId,
      phase: 'running',
      timestamp: new Date().toISOString(),
      runtimeAttached: true,
    })
  }

  const sendRuntimeEvent = (event: RuntimeStreamEvent) => {
    if (event.streamId !== args.streamId) return

    if (event.type === 'text_delta' || event.type === 'run_status') {
      ensureStarted()
      return
    }

    if (event.type === 'error') {
      ensureStarted()
      closed = true
      emit({
        type: 'chat.run.failed',
        runId: args.streamId,
        phase: 'failed',
        timestamp: new Date().toISOString(),
        error: event.message,
      })
    }
  }

  return {
    isDestroyed: () => closed,
    send: (channel, payload) => {
      emit({
        type: 'chat.ipc.event',
        runId: args.streamId,
        channel,
        payload,
      })
      if (channel === 'ava:llm:event') {
        const event = payload as RuntimeStreamEvent & { type?: string; plan?: unknown }
        if (event.type === 'task_plan_update' && args.conversationId && event.plan && typeof event.plan === 'object') {
          setActiveTaskPlan(args.conversationId, event.plan as TaskExecutionPlan)
        }
        sendRuntimeEvent(payload as RuntimeStreamEvent)
      }
    },
  }
}

function getActiveTaskPlanState(request: AvaTaskPlanGetRequest): AvaTaskPlanStateResult {
  return { conversationId: request.conversationId, plan: getActiveTaskPlan(request.conversationId) }
}

function setActiveTaskPlanState(request: AvaTaskPlanSetRequest): AvaTaskPlanStateResult {
  return { conversationId: request.conversationId, plan: setActiveTaskPlan(request.conversationId, request.plan) }
}

function clearActiveTaskPlanState(request: AvaTaskPlanClearRequest): AvaTaskPlanStateResult {
  clearActiveTaskPlan(request.conversationId)
  return { conversationId: request.conversationId }
}

async function ensureUnitTestWorkspace(): Promise<string> {
  const root = join(runtimePaths().projectRoot, UNIT_TEST_WORKSPACE_DIR)
  await fs.mkdir(join(root, 'src'), { recursive: true })
  await fs.writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'ava-unit-test-workspace',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: {
        test: 'node src/index.js',
        build: 'node src/index.js',
      },
    }, null, 2),
    'utf8',
  )
  await fs.writeFile(join(root, 'src', 'index.js'), 'console.log("ava unit test workspace ok")\n', 'utf8')
  await fs.writeFile(join(root, 'README.md'), '# Ava Unit Test Workspace\n\nThis folder is generated for safe dev tool-call tests.\n', 'utf8')
  return root
}

async function unitTestContext(states: Record<string, PluginState> | undefined) {
  const testWorkspace = await ensureUnitTestWorkspace()
  const servers = mcpSupervisor.listServers()
  const plugins = await pluginManager.discover(states ?? {})
  return {
    isDev: true,
    cwd: testWorkspace,
    logPath: join(testWorkspace, UNIT_TEST_RESULTS_FILE),
    daemon: {
      baseUrl: process.env.AVA_DAEMON_URL ?? `http://${process.env.AVA_DAEMON_HOST ?? '127.0.0.1'}:${process.env.AVA_DAEMON_PORT ?? '17871'}`,
      chatRuntimeEnabled: true,
    },
    builtInTools: builtInTools.listTools(),
    mcpTools: servers.flatMap(server =>
      (server.tools ?? []).map(tool => ({
        ...tool,
        serverId: server.id,
        serverName: server.name,
        serverStatus: server.status,
      })),
    ),
    skills: plugins.flatMap(plugin =>
      plugin.skills.map(skill => ({
        ...skill,
        pluginId: plugin.id,
        pluginName: plugin.manifest?.name ?? plugin.id,
        enabled: plugin.enabled,
        valid: plugin.valid,
      })),
    ),
  }
}

async function appendUnitTestResult(raw: unknown): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const root = await ensureUnitTestWorkspace()
  const file = join(root, UNIT_TEST_RESULTS_FILE)
  try {
    const record = {
      time: new Date().toISOString(),
      ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : { value: raw }),
    }
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function readUnitTestResults(): Promise<{ ok: true; path: string; text: string } | { ok: false; error: string }> {
  const root = await ensureUnitTestWorkspace()
  const file = join(root, UNIT_TEST_RESULTS_FILE)
  try {
    return { ok: true, path: file, text: await fs.readFile(file, 'utf8').catch(() => '') }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function clearUnitTestResults(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const root = await ensureUnitTestWorkspace()
  const file = join(root, UNIT_TEST_RESULTS_FILE)
  try {
    await fs.writeFile(file, '', 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function unitTestToolArgs(name: string, cwd: string): Record<string, unknown> {
  const testDir = join(cwd, '.ava-unit-test')
  const previewPort = 48000 + Math.floor(Math.random() * 4000)
  const previewUrl = `http://127.0.0.1:${previewPort}/`
  const nodeServerScript = `require('http').createServer(function(q,r){r.end('ava unit test')}).listen(${previewPort},'127.0.0.1',function(){console.log('${previewUrl}')})`
  const previewStart = {
    cwd,
    command: 'node',
    args: ['-e', nodeServerScript],
    expectedUrl: previewUrl,
  }

  const args: Record<string, Record<string, unknown>> = {
    'shell.run_command': { cwd, command: 'node', args: ['-e', "console.log('ava shell ok')"] },
    'file.read_text': { path: join(cwd, 'package.json') },
    'file.write_text': { path: join(testDir, 'tool-write.txt'), content: 'ava unit test write ok' },
    'file.list_dir': { path: cwd },
    'file.create_dir': { path: join(testDir, 'created-dir'), allowExisting: true },
    'file.stat': { path: join(cwd, 'package.json') },
    'project.detect': { cwd },
    'project.map': { cwd, maxDepth: 2 },
    'project.validate': { cwd, level: 'quick' },
    'search.ripgrep': { cwd, query: 'ava', maxMatches: 5 },
    'git.status': { cwd },
    'git.diff': { cwd },
    'devserver.start': previewStart,
    'devserver.status': { cwd },
    'devserver.stop': { cwd },
    'process.start': { cwd, command: 'node', args: ['-e', "setTimeout(function(){ console.log('ava process ok') },200)"] },
    'process.status': { cwd },
    'process.logs': {},
    'process.wait': {},
    'process.kill': {},
    'preview.open': { url: previewUrl },
    'preview.console': { url: previewUrl, waitMs: 300 },
    'preview.screenshot': { url: previewUrl, outputPath: join(testDir, 'preview.png'), waitMs: 300 },
    'speech.tts_save': { text: 'Ava unit test voiceover.', outputPath: join(testDir, 'voiceover.wav'), dryRun: true },
  }
  return args[name] ?? {}
}

function unitTestPreviewStartArgs(name: string, cwd: string): Record<string, unknown> {
  const previewPort = 48000 + Math.floor(Math.random() * 4000)
  const previewUrl = `http://127.0.0.1:${previewPort}/`
  return unitTestPreviewStartArgsForUrl(cwd, previewUrl)
}

function unitTestPreviewStartArgsForUrl(cwd: string, previewUrl: string): Record<string, unknown> {
  const url = new URL(previewUrl)
  const previewPort = Number(url.port)
  const nodeServerScript = `require('http').createServer(function(q,r){r.end('ava unit test')}).listen(${previewPort},'127.0.0.1',function(){console.log('${previewUrl}')})`
  return {
    cwd,
    command: 'node',
    args: ['-e', nodeServerScript],
    expectedUrl: previewUrl,
  }
}

function extractProcessId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const content = (result as { content?: unknown }).content
  if (!content || typeof content !== 'object') return undefined
  const id = (content as { processId?: unknown; id?: unknown }).processId ?? (content as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

function isToolResultOk(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const record = result as { ok?: unknown; isError?: unknown }
  return record.ok === true && record.isError !== true
}

async function directUnitTest(raw: unknown) {
  const request = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const kind = typeof request.kind === 'string' ? request.kind : ''
  const name = typeof request.name === 'string' ? request.name : ''
  const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? request.cwd.trim() : await ensureUnitTestWorkspace()
  const rawArgs = request.args && typeof request.args === 'object' && !Array.isArray(request.args)
    ? request.args as Record<string, unknown>
    : unitTestToolArgs(name, cwd)
  const context = { activeFolderPath: cwd, allowedDirs: [cwd] }
  const startedAt = Date.now()
  const calls: Array<{ name: string; ok: boolean; result: unknown }> = []

  async function callBuiltIn(toolName: string, args: Record<string, unknown>) {
    const result = await builtInTools.callTool(toolName, args, context)
    calls.push({ name: toolName, ok: isToolResultOk(result), result })
    return result
  }

  if (kind === 'built-in') {
    if (name === 'file.patch') {
      await callBuiltIn('file.write_text', { path: join(cwd, '.ava-unit-test', 'patch-target.txt'), content: 'before patch' })
      await callBuiltIn('file.patch', { path: join(cwd, '.ava-unit-test', 'patch-target.txt'), oldText: 'before', newText: 'after' })
    } else if (name === 'devserver.stop') {
      await callBuiltIn('devserver.start', unitTestPreviewStartArgs(name, cwd))
      await callBuiltIn('devserver.stop', rawArgs)
    } else if (name === 'preview.open' || name === 'preview.console' || name === 'preview.screenshot') {
      await callBuiltIn('devserver.start', unitTestPreviewStartArgsForUrl(cwd, String(rawArgs.url ?? '')))
      await callBuiltIn(name, rawArgs)
    } else if (name === 'process.status') {
      const start = await callBuiltIn('process.start', { cwd, command: 'node', args: ['-e', "setTimeout(function(){ console.log('ava process status ok') },500)"] })
      await callBuiltIn('process.status', { id: extractProcessId(start) })
    } else if (name === 'process.logs') {
      const start = await callBuiltIn('process.start', { cwd, command: 'node', args: ['-e', "console.log('ava process logs ok')"] })
      const id = extractProcessId(start)
      await callBuiltIn('process.wait', { id, timeoutMs: 2000 })
      await callBuiltIn('process.logs', { id })
    } else if (name === 'process.wait') {
      const start = await callBuiltIn('process.start', { cwd, command: 'node', args: ['-e', "setTimeout(function(){ console.log('ava process wait ok') },100)"] })
      await callBuiltIn('process.wait', { id: extractProcessId(start), timeoutMs: 2000 })
    } else if (name === 'process.kill') {
      const start = await callBuiltIn('process.start', { cwd, command: 'node', args: ['-e', 'setTimeout(function(){},10000)'] })
      await callBuiltIn('process.kill', { id: extractProcessId(start) })
    } else {
      await callBuiltIn(name, rawArgs)
    }
  } else if (kind === 'mcp') {
    const result = await mcpSupervisor.callTool({ namespacedName: name, rawArgs })
    calls.push({ name, ok: isToolResultOk(result) || (result as { ok?: unknown }).ok === true, result })
  } else {
    throw new Error(`Unsupported direct unit test kind: ${kind}`)
  }

  const passed = calls.length > 0 && calls.every(call => call.ok)
  return {
    passed,
    durationMs: Date.now() - startedAt,
    calls,
  }
}

export function createDaemonRuntimeServices() {
  return {
    async streamChat(request: AvaChatStreamRequest, emit: EmitDaemonEvent) {
      const args = await streamChatArgsFromRequest(request)
      const storedPlan = args.activeTaskPlan ? undefined : (args.conversationId ? getActiveTaskPlan(args.conversationId) : undefined)
      const streamArgs = storedPlan ? { ...args, activeTaskPlan: storedPlan } : args
      const eventTarget = createRuntimeEventTarget(args, emit)
      const result = streamArgs.activeTaskPlan
        ? await streamTaskExecutionPlan(eventTarget, streamArgs)
        : await streamChat(eventTarget as never, streamArgs)

      emit({
        type: 'chat.message.completed',
        runId: streamArgs.streamId,
        message: {
          role: 'assistant',
          content: result.fullContent,
          createdAt: new Date().toISOString(),
        },
      })
      emit({
        type: 'chat.run.completed',
        runId: streamArgs.streamId,
        phase: 'completed',
        timestamp: new Date().toISOString(),
      })
    },

    loadSettings,

    loadConversations,

    classifyInput: classifyInputWithFallback,

    dispatchInput,

    startIntakeSession,

    replyIntakeSession,

    analyzeTask,

    probeModels,

    probeModelCapabilities,

    getProjectBrief,

    ensureProjectDocs,
    readWorkspaceText,
    writeWorkspaceText,
    createWorkspaceDir,
    listWorkspaceDir,
    probeCodeAgents,
    installCodeAgent,
    listCodeAgentProfiles,
    dispatchCodeAgentTask,
    listCodeAgentSessions,
    startCodeAgentSession,
    sendCodeAgentSessionMessage,
    stopCodeAgentSession,
    openEnvironmentPath,
    openEnvironmentTerminal,
    openEnvironmentVSCode,

    async planTask(request: Parameters<typeof planTask>[0]) {
      const result = await planTask(request)
      if (request.conversationId) setActiveTaskPlan(request.conversationId, result.plan)
      return result
    },

    getActiveTaskPlan: getActiveTaskPlanState,
    setActiveTaskPlan: setActiveTaskPlanState,
    clearActiveTaskPlan: clearActiveTaskPlanState,

    async saveSettings(data: unknown) {
      await saveSettings(data)
      const mcpServers = await readRuntimeMcpServers(data)
      if (!mcpServers) return true
      try {
        await mcpSupervisor.applyConfigs(mcpServers)
      } catch (err) {
        if (!isBrokenPipeError(err)) throw err
        console.warn('[daemon:mcp] ignored EPIPE while applying settings; server process likely closed its stdio pipe.')
      }
      return true
    },

    async saveConversations(data: unknown) {
      await saveConversations(data)
      return true
    },

    listMcpServers: () => mcpSupervisor.listServers(),
    restartMcpServer: async (serverId: string) => {
      await mcpSupervisor.restart(serverId)
      return true
    },
    applyMcpServersFromSettings: async (settings: unknown) => {
      const mcpServers = await readRuntimeMcpServers(settings)
      if (mcpServers) await mcpSupervisor.applyConfigs(mcpServers)
      return true
    },
    shutdownMcp: () => mcpSupervisor.shutdown(),

    listPlugins: (states: Record<string, PluginState> | undefined) => pluginManager.discover(states ?? {}),
    listPluginCommands: (states: Record<string, PluginState> | undefined) => pluginManager.commandsForStates(states ?? {}),
    getMarketplaceCatalog: (states: Record<string, PluginState> | undefined, options: MarketplaceCatalogOptions | undefined) => pluginManager.getMarketplaceCatalog(states ?? {}, options),
    installPluginFromFolder: (path: string) => pluginManager.installFromFolder(path),
    installPluginFromZip: (path: string) => pluginManager.installFromZip(path),
    installPluginFromGit: (url: string) => pluginManager.installFromGit(url),
    uninstallPlugin: async (pluginId: string) => {
      await pluginManager.uninstall(pluginId)
      return true
    },
    updatePlugin: (pluginId: string) => pluginManager.update(pluginId),

    listToolAudit: (limit?: number) => toolAuditLog.list(limit),
    clearToolAudit: async () => {
      await toolAuditLog.clear()
      return true
    },

    unitTestContext,
    directUnitTest,
    appendUnitTestResult,
    readUnitTestResults,
    clearUnitTestResults,
  }
}
