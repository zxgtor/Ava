import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent, WheelEvent } from 'react'
import { CheckCircle2, FlaskConical, MoreHorizontal, Play, RefreshCw, X, XCircle } from 'lucide-react'
import { AvaClient } from '@ava/client-sdk'
import type { AvaChatStreamEvent, AvaDaemonChatRequest } from '@ava/contracts'

type TargetKind = 'daemon' | 'built-in' | 'mcp' | 'skill' | 'dev'
type TestStatus = 'idle' | 'running' | 'passed' | 'failed'
type BackendStatus = 'checking' | 'online' | 'offline'
type CanvasView = { x: number; y: number; scale: number }
type NodePosition = { x: number; y: number }
type PinLine = {
  id: string
  featureName: string
  dependencyId: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
}

interface TestTarget {
  id: string
  kind: TargetKind
  name: string
  label: string
  description?: string
  inputSchema?: unknown
  defaultRequest: string
  meta?: string
}

interface TestState {
  request: string
  defaultRequest?: string
  status: TestStatus
  message?: string
  lastTool?: string
  durationMs?: number
  fullContent?: string
}

interface UnitTestContext {
  isDev: boolean
  cwd: string
  logPath?: string
  daemon?: {
    baseUrl: string
    chatRuntimeEnabled: boolean
    error?: string
  }
  builtInTools: ToolDescriptor[]
  mcpTools: Array<ToolDescriptor & { serverId: string; serverName: string; serverStatus: string }>
  skills: Array<{
    name: string
    pluginId: string
    pluginName: string
    sourcePath?: string
    enabled?: boolean
    valid?: boolean
  }>
}

interface ToolDescriptor {
  rawName: string
  name: string
  description?: string
  inputSchema?: unknown
}

interface ToolPart {
  type?: string
  id?: string
  name?: string
  status?: string
  error?: string
  args?: Record<string, unknown>
}

interface DaemonRequest {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
  expectEventTypes?: string[]
}

interface DevProcess {
  id: string
  label: string
  description: string
  command: string
  cwd: string
  ports: number[]
  url: string
  available: boolean
  running: boolean
  status: 'managed' | 'external' | 'stopped' | 'unavailable'
  pid?: number
  externalPids?: number[]
  startedAt?: number
  exitedAt?: number
  exitCode?: number
  signal?: string
  logLines: number
}

interface DevLogLine {
  time: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
}

interface DevDependencyNode {
  id: string
  x: number
  y: number
  metadata: DevNodeMetadata
  process?: DevProcess
  feature?: {
    label: string
    description: string
    status: string
    url: string
  }
}

interface DevNodeMetadata {
  features: string[]
  dependencies: string[]
  dependsOn: string[]
}

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:17871'
const DEFAULT_DEV_CONTROL_URL = 'http://127.0.0.1:17872'
const NODE_POSITIONS_STORAGE_KEY = 'ava-dev-control-node-positions'
const TEST_KINDS = ['daemon', 'built-in', 'mcp', 'skill'] as const
const DEFAULT_NODE_POSITIONS: Record<string, NodePosition> = {
  daemon: { x: 50, y: 50 },
  'ava-desktop': { x: 21, y: 25 },
  'web-ui': { x: 21, y: 72 },
  'daemon-test-ui': { x: 79, y: 31 },
  'unit-test': { x: 79, y: 70 },
}
const DEV_NODE_METADATA: Record<string, DevNodeMetadata> = {
  daemon: {
    features: [
      'Runtime HTTP/SSE API',
      'Config and model router',
      'Built-in tools runtime',
      'MCP and skill context',
      'Process registry',
    ],
    dependencies: ['Local config', 'Provider runtime', 'Workspace filesystem', 'MCP servers'],
    dependsOn: [],
  },
  'ava-desktop': {
    features: [
      'Chat workspace UI',
      'Settings and providers',
      'Tool blocks and preview',
      'Agent task progress',
    ],
    dependencies: ['Ava Daemon runtime API', 'Electron shell'],
    dependsOn: ['daemon'],
  },
  'web-ui': {
    features: [
      'Future browser client',
      'Shared client SDK',
      'Remote/mobile-ready UI',
    ],
    dependencies: ['Ava Daemon runtime API', 'Client SDK'],
    dependsOn: ['daemon'],
  },
  'daemon-test-ui': {
    features: [
      'Feature orchestration canvas',
      'Dev process control',
      'Daemon health monitor',
      'Unit test launcher',
    ],
    dependencies: ['Dev-control supervisor', 'Ava Daemon for tests'],
    dependsOn: ['daemon'],
  },
  'unit-test': {
    features: [
      'Daemon API smoke tests',
      'Built-in tool routing tests',
      'MCP tool routing tests',
      'Skill routing tests',
    ],
    dependencies: ['Ava Daemon runtime API', 'LLM provider when routing tests run', 'Test workspace'],
    dependsOn: ['daemon'],
  },
}
const DEPENDENCY_PIN_COLORS: Record<string, string> = {
  daemon: '#56d6ff',
  'ava-desktop': '#76e2a8',
  'web-ui': '#ff7aa7',
  'daemon-test-ui': '#ffd36a',
  'unit-test': '#a8ccff',
}

function targetKindLabel(kind: TargetKind) {
  if (kind === 'built-in') return 'Built-in Tools'
  if (kind === 'mcp') return 'MCP Tools'
  if (kind === 'skill') return 'Skills'
  if (kind === 'daemon') return 'Daemon'
  return 'Control'
}

function clampCanvasScale(scale: number) {
  return Math.min(2.4, Math.max(0.45, scale))
}

function clampNodePosition(position: NodePosition): NodePosition {
  return {
    x: Math.min(94, Math.max(6, position.x)),
    y: Math.min(92, Math.max(8, position.y)),
  }
}

function loadNodePositions(): Record<string, NodePosition> {
  try {
    const raw = localStorage.getItem(NODE_POSITIONS_STORAGE_KEY)
    if (!raw) return DEFAULT_NODE_POSITIONS
    const parsed = JSON.parse(raw) as Record<string, NodePosition>
    return Object.fromEntries(
      Object.entries(DEFAULT_NODE_POSITIONS).map(([id, fallback]) => {
        const position = parsed[id]
        return [id, position ? clampNodePosition(position) : fallback]
      }),
    )
  } catch {
    return DEFAULT_NODE_POSITIONS
  }
}

function previewCall(name: string, args: Record<string, unknown>) {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`
}

function defaultBuiltInRequest(toolName: string, cwd: string): string {
  const testDir = `${cwd}\\.ava-unit-test`
  const testFile = `${testDir}\\tool-write.txt`
  const patchFile = `${testDir}\\patch-target.txt`
  const screenshotPath = `${testDir}\\preview.png`
  const previewPortByTool: Record<string, number> = {
    'devserver.start': 47831,
    'devserver.stop': 47832,
    'devserver.status': 47833,
    'process.start': 47837,
    'process.status': 47838,
    'process.logs': 47839,
    'process.wait': 47840,
    'process.kill': 47841,
    'preview.open': 47834,
    'preview.console': 47835,
    'preview.screenshot': 47836,
  }
  const previewPort = previewPortByTool[toolName] ?? 47831
  const previewUrl = `http://127.0.0.1:${previewPort}/`
  const nodeServerScript = `require('http').createServer(function(q,r){r.end('ava unit test')}).listen(${previewPort},'127.0.0.1',function(){console.log('${previewUrl}')})`
  const devserverStartCall = previewCall('devserver.start', {
    cwd,
    command: 'node',
    args: ['-e', nodeServerScript],
    expectedUrl: previewUrl,
  })

  const requests: Record<string, string> = {
    'shell.run_command': `Call shell.run_command exactly once to run node with args ["-e","console.log('ava shell ok')"] in cwd "${cwd}".`,
    'file.read_text': `Call file.read_text exactly once to read "${cwd}\\package.json".`,
    'file.write_text': `Call file.write_text exactly once to write "${testFile}" with content "ava unit test write ok".`,
    'file.list_dir': `Call file.list_dir exactly once to list "${cwd}".`,
    'file.create_dir': `Respond with exactly this one tool call and no extra tool calls: ${previewCall('file.create_dir', { path: `${testDir}\\created-dir`, allowExisting: true })}`,
    'file.stat': `Call file.stat exactly once for "${cwd}\\package.json".`,
    'file.patch': `Respond with exactly these two tool calls and no extra tool calls:\n${previewCall('file.write_text', { path: patchFile, content: 'before patch' })}\n${previewCall('file.patch', { path: patchFile, oldText: 'before', newText: 'after' })}`,
    'project.detect': `Call project.detect exactly once with cwd "${cwd}".`,
    'project.map': `Respond with exactly this one tool call and no extra tool calls: ${previewCall('project.map', { cwd, maxDepth: 2 })}`,
    'project.validate': `Call project.validate exactly once with cwd "${cwd}" and level "quick".`,
    'search.ripgrep': `Call search.ripgrep exactly once in cwd "${cwd}" to search for "ava" with maxMatches 5.`,
    'git.status': `Call git.status exactly once with cwd "${cwd}".`,
    'git.diff': `Call git.diff exactly once with cwd "${cwd}".`,
    'devserver.start': `Respond with exactly this one tool call and no extra tool calls: ${devserverStartCall}`,
    'devserver.status': `Call devserver.status exactly once with cwd "${cwd}".`,
    'devserver.stop': `Respond with exactly these two tool calls and no extra tool calls:\n${devserverStartCall}\n${previewCall('devserver.stop', { cwd })}`,
    'process.start': `Call process.start exactly once to run node with args ["-e","setTimeout(function(){ console.log('ava process ok') },200)"] in cwd "${cwd}".`,
    'process.status': `Respond with exactly these two tool calls and no extra tool calls:\n${previewCall('process.start', { cwd, command: 'node', args: ['-e', "setTimeout(function(){ console.log('ava process status ok') },500)"] })}\n${previewCall('process.status', { cwd })}`,
    'process.logs': `First call process.start to run node with args ["-e","console.log('ava process logs ok')"] in cwd "${cwd}". After the tool result returns processId, call process.wait for that id with timeoutMs 2000, then call process.logs for the same id.`,
    'process.wait': `First call process.start to run node with args ["-e","setTimeout(function(){ console.log('ava process wait ok') },100)"] in cwd "${cwd}". After the tool result returns processId, call process.wait for that id with timeoutMs 2000.`,
    'process.kill': `First call process.start to run node with args ["-e","setTimeout(function(){},10000)"] in cwd "${cwd}". After the tool result returns processId, call process.kill for that id.`,
    'preview.open': `Respond with exactly these two tool calls and no extra tool calls:\n${devserverStartCall}\n${previewCall('preview.open', { url: previewUrl })}`,
    'preview.console': `Respond with exactly these two tool calls and no extra tool calls:\n${devserverStartCall}\n${previewCall('preview.console', { url: previewUrl, waitMs: 300 })}`,
    'preview.screenshot': `Respond with exactly these two tool calls and no extra tool calls:\n${devserverStartCall}\n${previewCall('preview.screenshot', { url: previewUrl, outputPath: screenshotPath, waitMs: 300 })}`,
  }

  return requests[toolName] ?? `Call ${toolName} exactly once with safe minimal arguments for cwd "${cwd}".`
}

function minimalJsonForSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return {}
  const record = schema as Record<string, unknown>
  if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum[0]
  if (Array.isArray(record.anyOf) && record.anyOf.length > 0) return minimalJsonForSchema(record.anyOf[0])
  if (Array.isArray(record.oneOf) && record.oneOf.length > 0) return minimalJsonForSchema(record.oneOf[0])

  if (record.type === 'string') return 'ava-unit-test'
  if (record.type === 'number' || record.type === 'integer') return 1
  if (record.type === 'boolean') return true
  if (record.type === 'array') return []
  if (record.type === 'object' || record.properties) {
    const required = Array.isArray(record.required) ? record.required.map(String) : []
    const properties = record.properties && typeof record.properties === 'object'
      ? record.properties as Record<string, unknown>
      : {}
    return Object.fromEntries(required.map(key => [key, minimalJsonForSchema(properties[key])]))
  }
  return {}
}

function makeMcpRequest(toolName: string, schema: unknown): string {
  const args = minimalJsonForSchema(schema)
  const call = previewCall(toolName, args as Record<string, unknown>)
  if (toolName === 'filesystem.list_allowed_directories') {
    return [
      'List allowed directories for this MCP filesystem server.',
      'Respond with exactly this one tool call and no extra tool calls:',
      call,
      'After the tool result, report the allowed directories briefly.',
    ].join('\n')
  }
  return [
    `Call MCP tool ${toolName} exactly once using this exact tool call.`,
    'Respond with exactly this one tool call and no extra tool calls:',
    call,
    'If the tool reports a safe validation or permission error, stop and summarize it.',
  ].join('\n')
}

function makeSkillRequest(skillName: string, pluginName: string): string {
  return `Use the enabled skill "${skillName}" from plugin "${pluginName}" to answer: tell me what this skill is for and give one short test message plus the expected result.`
}

function requestJson(value: DaemonRequest): string {
  return JSON.stringify(value, null, 2)
}

function makeDaemonTargets(baseUrl: string): TestTarget[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  return [
    {
      id: 'daemon:health',
      kind: 'daemon',
      name: 'daemon.health',
      label: 'daemon.health',
      description: 'GET /health should report daemon process status.',
      defaultRequest: requestJson({ method: 'GET', url: `${normalized}/health` }),
    },
    {
      id: 'daemon:runtime-status',
      kind: 'daemon',
      name: 'daemon.runtime.status',
      label: 'daemon.runtime.status',
      description: 'GET /runtime/status should report runtime attachment.',
      defaultRequest: requestJson({ method: 'GET', url: `${normalized}/runtime/status` }),
    },
    {
      id: 'daemon:unit-test-context',
      kind: 'daemon',
      name: 'daemon.unitTestContext',
      label: 'daemon.unitTestContext',
      description: 'POST /dev/unit-test-context should return daemon-owned test context.',
      defaultRequest: requestJson({ method: 'POST', url: `${normalized}/dev/unit-test-context`, body: { states: {} } }),
    },
    {
      id: 'daemon:chat-stream',
      kind: 'daemon',
      name: 'daemon.chat.stream',
      label: 'daemon.chat.stream',
      description: 'GET /chat/stream smoke endpoint should return SSE events.',
      defaultRequest: requestJson({
        method: 'GET',
        url: `${normalized}/chat/stream?message=hello%20daemon%20unit%20test`,
        expectEventTypes: ['chat.run.started', 'chat.message.delta', 'chat.message.completed', 'chat.run.completed'],
      }),
    },
    {
      id: 'daemon:chat-runtime',
      kind: 'daemon',
      name: 'daemon.chat.runtime',
      label: 'daemon.chat.runtime',
      description: 'Run a real LLM request through daemon runtime using daemon-owned config.',
      defaultRequest: 'Reply with exactly: ava daemon runtime ok',
    },
  ]
}

function parseDaemonRequest(text: string): DaemonRequest {
  const parsed = JSON.parse(text) as DaemonRequest
  if (parsed.method !== 'GET' && parsed.method !== 'POST') throw new Error('Daemon request method must be GET or POST.')
  if (!parsed.url || typeof parsed.url !== 'string') throw new Error('Daemon request url is required.')
  return parsed
}

function parseSseEventTypes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.startsWith('event:'))
    .map(line => line.slice('event:'.length).trim())
}

function statusIcon(status: TestStatus) {
  if (status === 'passed') return <CheckCircle2 size={15} className="ok" />
  if (status === 'failed') return <XCircle size={15} className="bad" />
  if (status === 'running') return <RefreshCw size={15} className="spin accent" />
  return <FlaskConical size={15} className="muted" />
}

function requiredToolsForTarget(target: TestTarget): string[] | undefined {
  if (target.kind === 'skill') return undefined
  if (target.kind === 'mcp') return [target.name]

  const dependencies: Record<string, string[]> = {
    'file.patch': ['file.write_text', 'file.patch'],
    'process.status': ['process.start', 'process.status'],
    'process.logs': ['process.start', 'process.wait', 'process.logs'],
    'process.wait': ['process.start', 'process.wait'],
    'process.kill': ['process.start', 'process.kill'],
    'devserver.stop': ['devserver.start', 'devserver.stop'],
    'preview.open': ['devserver.start', 'preview.open'],
    'preview.console': ['devserver.start', 'preview.console'],
    'preview.screenshot': ['devserver.start', 'preview.screenshot'],
  }
  return dependencies[target.name] ?? [target.name]
}

function applyToolPartUpdate(parts: ToolPart[], payload: Record<string, unknown>): ToolPart[] {
  return parts.map((part, index) => {
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch as Record<string, unknown> : {}
    const matches = payload.partId
      ? part.id === payload.partId
      : index === payload.partIndex
    return matches ? { ...part, ...patch } : part
  })
}

export function App() {
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('ava-daemon-test-url') || DEFAULT_DAEMON_URL)
  const [devControlUrl, setDevControlUrl] = useState(() => localStorage.getItem('ava-dev-control-url') || DEFAULT_DEV_CONTROL_URL)
  const [kind, setKind] = useState<TargetKind>('dev')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devError, setDevError] = useState<string | null>(null)
  const [devControlStatus, setDevControlStatus] = useState<BackendStatus>('checking')
  const [devBusyId, setDevBusyId] = useState<string | null>(null)
  const [cwd, setCwd] = useState('')
  const [logPath, setLogPath] = useState('')
  const [targets, setTargets] = useState<TestTarget[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [devProcesses, setDevProcesses] = useState<DevProcess[]>([])
  const [devLogs, setDevLogs] = useState<Record<string, DevLogLine[]>>({})
  const [selectedDevNodeId, setSelectedDevNodeId] = useState<string | null>(null)
  const [canvasView, setCanvasView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 })
  const [isCanvasPanning, setIsCanvasPanning] = useState(false)
  const [nodePositions, setNodePositions] = useState<Record<string, NodePosition>>(loadNodePositions)
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null)
  const [openNodeMenuId, setOpenNodeMenuId] = useState<string | null>(null)
  const [pinLines, setPinLines] = useState<PinLine[]>([])
  const targetRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const devControlStatusRef = useRef<BackendStatus>('checking')
  const canvasPanRef = useRef({ pointerId: -1, startX: 0, startY: 0, originX: 0, originY: 0 })
  const canvasWorldRef = useRef<HTMLDivElement | null>(null)
  const pinRefs = useRef<Record<string, HTMLElement | null>>({})
  const nodeDragRef = useRef({
    pointerId: -1,
    nodeId: '',
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    canvasWidth: 1,
    canvasHeight: 1,
  })

  const client = useMemo(() => new AvaClient({ baseUrl }), [baseUrl])
  const visibleTargets = useMemo(() => targets.filter(target => target.kind === kind), [kind, targets])
  const selected = targets.find(target => target.id === selectedId) ?? visibleTargets[0] ?? targets[0]
  const selectedState = selected ? tests[selected.id] : undefined

  const devFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${devControlUrl.replace(/\/+$/, '')}${path}`, init)
    const payload = await response.json() as { ok: boolean; result?: T; error?: string }
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
    return payload.result as T
  }, [devControlUrl])

  const checkDevControlHealth = useCallback(async (): Promise<boolean> => {
    localStorage.setItem('ava-dev-control-url', devControlUrl)
    try {
      const response = await fetch(`${devControlUrl.replace(/\/+$/, '')}/health`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setDevControlStatus('online')
      setDevError(null)
      return true
    } catch {
      setDevControlStatus('offline')
      return false
    }
  }, [devControlUrl])

  const loadDevProcesses = useCallback(async () => {
    setDevError(null)
    localStorage.setItem('ava-dev-control-url', devControlUrl)
    try {
      const processes = await devFetch<DevProcess[]>('/processes')
      setDevProcesses(processes)
      await Promise.all(processes.map(async process => {
        try {
          const logs = await devFetch<DevLogLine[]>(`/processes/${encodeURIComponent(process.id)}/logs?limit=120`)
          setDevLogs(prev => ({ ...prev, [process.id]: logs }))
        } catch {
          setDevLogs(prev => ({ ...prev, [process.id]: [] }))
        }
      }))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    }
  }, [devControlUrl, devFetch])

  const controlDevProcess = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setDevBusyId(id)
    setDevError(null)
    try {
      await devFetch<DevProcess>(`/processes/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
      await loadDevProcesses()
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevBusyId(null)
    }
  }

  const writeLog = useCallback((entry: Record<string, unknown>) => {
    void client.appendUnitTestResult(entry).catch(err => {
      console.warn('[daemon-test-ui] failed to write test log:', err)
    })
  }, [client])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    localStorage.setItem('ava-daemon-test-url', baseUrl)
    try {
      const context = await client.unitTestContext<UnitTestContext>({})
      const nextCwd = context.cwd
      setCwd(nextCwd)
      setLogPath(context.logPath ?? '')

      const builtIns: TestTarget[] = context.builtInTools.map(tool => ({
        id: `built-in:${tool.name}`,
        kind: 'built-in',
        name: tool.name,
        label: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        defaultRequest: defaultBuiltInRequest(tool.name, nextCwd),
      }))
      const mcp: TestTarget[] = context.mcpTools.map(tool => ({
        id: `mcp:${tool.serverId}:${tool.name}`,
        kind: 'mcp',
        name: tool.name,
        label: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        meta: `${tool.serverName} · ${tool.serverStatus}`,
        defaultRequest: makeMcpRequest(tool.name, tool.inputSchema),
      }))
      const skills: TestTarget[] = context.skills.map(skill => ({
        id: `skill:${skill.pluginId}:${skill.name}`,
        kind: 'skill',
        name: skill.name,
        label: skill.name,
        meta: `${skill.pluginName} · ${skill.enabled && skill.valid ? 'enabled' : 'disabled'}`,
        description: skill.sourcePath,
        defaultRequest: makeSkillRequest(skill.name, skill.pluginName),
      }))
      const nextTargets = [...makeDaemonTargets(baseUrl), ...builtIns, ...mcp, ...skills]
      setTargets(nextTargets)
      setTests(prev => {
        const next = { ...prev }
        for (const target of nextTargets) {
          const existing = next[target.id]
          if (!existing) {
            next[target.id] = { request: target.defaultRequest, defaultRequest: target.defaultRequest, status: 'idle' }
            continue
          }
          const wasUsingGeneratedRequest =
            existing.defaultRequest === undefined || existing.request === existing.defaultRequest
          next[target.id] = {
            ...existing,
            request: wasUsingGeneratedRequest ? target.defaultRequest : existing.request,
            defaultRequest: target.defaultRequest,
          }
        }
        return next
      })
      setSelectedId(current => current || nextTargets.find(target => target.kind === kind)?.id || nextTargets[0]?.id || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [baseUrl, client, kind])

  useEffect(() => {
    if (kind === 'dev') return
    void refresh()
  }, [kind, refresh])

  useEffect(() => {
    devControlStatusRef.current = devControlStatus
  }, [devControlStatus])

  useEffect(() => {
    const firstForKind = targets.find(target => target.kind === kind)
    if (firstForKind && selected?.kind !== kind) setSelectedId(firstForKind.id)
  }, [kind, selected?.kind, targets])

  useEffect(() => {
    if (!selectedId) return
    targetRefs.current[selectedId]?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  useEffect(() => {
    if (kind !== 'dev') return
    void loadDevProcesses()
  }, [kind, loadDevProcesses])

  useEffect(() => {
    localStorage.setItem(NODE_POSITIONS_STORAGE_KEY, JSON.stringify(nodePositions))
  }, [nodePositions])

  useEffect(() => {
    let disposed = false

    const tick = async () => {
      const wasOnline = devControlStatusRef.current === 'online'
      const isOnline = await checkDevControlHealth()
      if (disposed) return
      if (isOnline && (!wasOnline || devProcesses.length === 0)) void loadDevProcesses()
    }

    void tick()
    const id = window.setInterval(() => void tick(), 2500)
    return () => {
      disposed = true
      window.clearInterval(id)
    }
  }, [checkDevControlHealth, devProcesses.length, loadDevProcesses])

  const updateRequest = (id: string, request: string) => {
    setTests(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? { status: 'idle' as const, request }), request, status: 'idle' },
    }))
  }

  const runDaemonRuntimeTarget = async (target: TestTarget) => {
    const requestText = tests[target.id]?.request || target.defaultRequest
    const startedAt = Date.now()
    const streamId = `daemon_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    let fullContent = ''

    setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'running', message: 'Running real daemon runtime chat...' } }))

    try {
      await client.streamChatEvents({
        request: {
          runId: streamId,
          messages: [
            { role: 'system', content: 'You are running Ava Daemon Runtime Unit Test. Follow the user request exactly. Do not call tools.' },
            { role: 'user', content: requestText },
          ],
          metadata: { streamOptions: { streamId, temperature: 0 } },
        },
        onEvent: event => {
          if (event.type === 'chat.message.delta') fullContent += event.delta
          if (event.type === 'chat.ipc.event' && event.channel === 'ava:llm:chunk') {
            const payload = event.payload as { streamId?: string; text?: unknown }
            if (payload.streamId === streamId && typeof payload.text === 'string') fullContent += payload.text
          }
          if (event.type === 'chat.run.failed') throw new Error(event.error)
        },
      })

      const durationMs = Date.now() - startedAt
      const passed = /ava daemon runtime ok/i.test(fullContent)
      const message = passed ? `Passed in ${durationMs}ms` : `Unexpected response: ${fullContent.slice(0, 300) || '(empty)'}`
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: passed ? 'passed' : 'failed', message, durationMs, fullContent } }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: passed ? 'passed' : 'failed', message, durationMs, request: requestText, fullContent })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'failed', message, durationMs, fullContent } }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: 'failed', message, durationMs, request: requestText, fullContent })
    }
  }

  const runDaemonTarget = async (target: TestTarget) => {
    if (target.name === 'daemon.chat.runtime') {
      await runDaemonRuntimeTarget(target)
      return
    }

    const requestText = tests[target.id]?.request || target.defaultRequest
    const startedAt = Date.now()
    setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'running', message: 'Calling daemon API...' } }))

    try {
      const request = parseDaemonRequest(requestText)
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
      })
      const fullContent = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${fullContent.slice(0, 300)}`)

      const eventTypes = parseSseEventTypes(fullContent)
      const missing = (request.expectEventTypes ?? []).filter(type => !eventTypes.includes(type))
      if (missing.length > 0) throw new Error(`Missing expected SSE events: ${missing.join(', ')}`)

      const durationMs = Date.now() - startedAt
      const message = `Passed in ${durationMs}ms${eventTypes.length ? `; events: ${eventTypes.join(', ')}` : ''}`
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'passed', message, durationMs, fullContent } }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: 'passed', message, durationMs, request: requestText, fullContent })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'failed', message, durationMs } }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: 'failed', message, durationMs, request: requestText })
    }
  }

  const runLlmRoutingTarget = async (target: TestTarget) => {
    const requestText = tests[target.id]?.request || target.defaultRequest
    const startedAt = Date.now()
    const streamId = `ut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    let parts: ToolPart[] = []
    let fullContent = ''
    let failedError: string | null = null

    setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'running', message: 'Waiting for daemon LLM/tool result...' } }))

    const daemonRequest: AvaDaemonChatRequest = {
      runId: streamId,
      messages: [
        {
          role: 'system',
          content: [
            'You are running Ava Unit Test.',
            'Follow the user request literally.',
            target.kind === 'skill'
              ? 'For skill tests, answer using the requested enabled skill context.'
              : `For this test, the required target tool is ${target.name}. You must call that tool. Do not only describe the command.`,
            'After tool execution, give a short final status.',
          ].join(' '),
        },
        { role: 'user', content: requestText },
      ],
      metadata: {
        streamOptions: {
          streamId,
          activeFolderPath: cwd,
          temperature: 0,
          activeStepRequiredTools: requiredToolsForTarget(target),
          activeStepToolLoopBudget: target.kind === 'skill' ? 2 : 8,
        },
      },
    }

    try {
      await client.streamChatEvents({
        request: daemonRequest,
        onEvent: (event: AvaChatStreamEvent) => {
          if (event.type === 'chat.message.delta') {
            fullContent += event.delta
            return
          }
          if (event.type === 'chat.message.completed' && typeof event.message.content === 'string') {
            fullContent = event.message.content
            return
          }
          if (event.type === 'chat.run.failed') {
            failedError = event.error
            return
          }
          if (event.type !== 'chat.ipc.event') return
          const payload = event.payload as Record<string, unknown>
          if (event.channel === 'ava:llm:chunk') {
            if (payload.streamId === streamId && typeof payload.text === 'string') fullContent += payload.text
            return
          }
          if (event.channel === 'ava:llm:part') {
            if (payload.streamId !== streamId) return
            const part = payload.part as ToolPart
            const partIndex = typeof payload.partIndex === 'number' ? payload.partIndex : parts.length
            parts = [...parts]
            parts[partIndex] = part
            return
          }
          if (event.channel === 'ava:llm:partUpdate') {
            if (payload.streamId !== streamId) return
            parts = applyToolPartUpdate(parts, payload)
          }
        },
      })

      if (failedError) throw new Error(failedError)

      const toolParts = parts.filter(part => part?.type === 'tool_call')
      const targetCalls = toolParts.filter(part => part.name === target.name)
      const targetFailedCall = targetCalls.find(part => part.status === 'error' || part.status === 'aborted')
      const targetOkCall = targetCalls.find(part => part.status === 'ok')
      const targetReachedCall = targetCalls.find(part => part.status === 'ok' || part.status === 'error')
      const passed = target.kind === 'skill'
        ? Boolean(fullContent.trim())
        : target.kind === 'mcp'
          ? Boolean(targetReachedCall)
          : Boolean(targetOkCall)
      const durationMs = Date.now() - startedAt
      const message = passed
        ? target.kind === 'mcp' && targetFailedCall
          ? `Reached MCP tool in ${durationMs}ms; tool returned error: ${targetFailedCall.error ?? 'tool error'}`
          : `Passed in ${durationMs}ms`
        : targetFailedCall?.error || `Target tool was not called successfully. Calls: ${toolParts.map(part => `${part.name}:${part.status}`).join(', ') || 'none'}`
      const lastTool = toolParts.map(part => `${part.name}:${part.status}`).join(', ')

      setTests(prev => ({
        ...prev,
        [target.id]: { request: requestText, status: passed ? 'passed' : 'failed', message, lastTool, durationMs, fullContent },
      }))
      writeLog({
        id: target.id,
        kind: target.kind,
        name: target.name,
        status: passed ? 'passed' : 'failed',
        message,
        durationMs,
        request: requestText,
        toolCalls: toolParts.map(part => ({ name: part.name, status: part.status, error: part.error, args: part.args })),
        fullContent,
      })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({
        ...prev,
        [target.id]: { request: requestText, status: 'failed', message, durationMs, fullContent },
      }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: 'failed', message, durationMs, request: requestText, fullContent })
    }
  }

  const runTarget = async (target: TestTarget) => {
    if (target.kind === 'daemon') await runDaemonTarget(target)
    else await runLlmRoutingTarget(target)
  }

  const runVisibleTargets = async () => {
    if (kind === 'dev') {
      await loadDevProcesses()
      return
    }
    for (const target of visibleTargets) {
      setSelectedId(target.id)
      await runTarget(target)
    }
  }

  const processById = useMemo(() => new Map(devProcesses.map(process => [process.id, process])), [devProcesses])

  const dependencyNodes = useMemo<DevDependencyNode[]>(() => {
    const get = (id: string) => processById.get(id)
    const position = (id: string) => nodePositions[id] ?? DEFAULT_NODE_POSITIONS[id]
    return [
      {
        id: 'daemon',
        ...position('daemon'),
        metadata: DEV_NODE_METADATA.daemon,
        process: get('daemon'),
      },
      {
        id: 'ava-desktop',
        ...position('ava-desktop'),
        metadata: DEV_NODE_METADATA['ava-desktop'],
        process: get('ava-desktop'),
      },
      {
        id: 'web-ui',
        ...position('web-ui'),
        metadata: DEV_NODE_METADATA['web-ui'],
        process: get('web-ui'),
      },
      {
        id: 'daemon-test-ui',
        ...position('daemon-test-ui'),
        metadata: DEV_NODE_METADATA['daemon-test-ui'],
        process: get('daemon-test-ui'),
      },
      {
        id: 'unit-test',
        ...position('unit-test'),
        metadata: DEV_NODE_METADATA['unit-test'],
        feature: {
          label: 'Unit Test',
          description: 'Open daemon, built-in tool, MCP, and skill routing tests.',
          status: 'feature',
          url: baseUrl,
        },
      },
    ]
  }, [baseUrl, nodePositions, processById])

  const featureDependencyEdges = useMemo(() => dependencyNodes.flatMap(node => (
    node.metadata.features.slice(0, 3).flatMap((featureName, featureIndex) => (
      node.metadata.dependsOn.map(dependencyId => ({
        id: `${node.id}:${featureIndex}:${dependencyId}`,
        from: node.id,
        to: dependencyId,
        featureName,
        featureIndex,
      }))
    ))
  )), [dependencyNodes])
  const dependencyColorFor = (dependencyId: string) => DEPENDENCY_PIN_COLORS[dependencyId] ?? '#6bdcff'

  useLayoutEffect(() => {
    const updatePinLines = () => {
      const world = canvasWorldRef.current
      if (!world) return
      const worldRect = world.getBoundingClientRect()
      if (worldRect.width === 0 || worldRect.height === 0) return

      const nextLines: PinLine[] = []
      for (const edge of featureDependencyEdges) {
        const sourceNode = dependencyNodes.find(node => node.id === edge.from)
        const targetNode = dependencyNodes.find(node => node.id === edge.to)
        if (!sourceNode || !targetNode) continue
        const sourceSide = sourceNode.x <= targetNode.x ? 'output' : 'input'
        const targetSide = sourceNode.x <= targetNode.x ? 'input' : 'output'
        const sourcePin = pinRefs.current[`${edge.from}:${edge.featureIndex}:${sourceSide}`]
        const targetPin = pinRefs.current[`${edge.to}:${edge.featureIndex}:${targetSide}`]
        if (!sourcePin || !targetPin) continue
        const sourceRect = sourcePin.getBoundingClientRect()
        const targetRect = targetPin.getBoundingClientRect()
        nextLines.push({
          id: edge.id,
          featureName: edge.featureName,
          dependencyId: edge.to,
          sourceX: ((sourceRect.left + sourceRect.width / 2 - worldRect.left) / worldRect.width) * 100,
          sourceY: ((sourceRect.top + sourceRect.height / 2 - worldRect.top) / worldRect.height) * 100,
          targetX: ((targetRect.left + targetRect.width / 2 - worldRect.left) / worldRect.width) * 100,
          targetY: ((targetRect.top + targetRect.height / 2 - worldRect.top) / worldRect.height) * 100,
        })
      }
      setPinLines(nextLines)
    }

    const frame = window.requestAnimationFrame(updatePinLines)
    window.addEventListener('resize', updatePinLines)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePinLines)
    }
  }, [canvasView, featureDependencyEdges, nodePositions])
  const selectedDevNode = selectedDevNodeId ? dependencyNodes.find(node => node.id === selectedDevNodeId) : undefined
  const selectedDevProcess = selectedDevNode?.process

  const handleCanvasWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const zoomFactor = Math.exp(-event.deltaY * 0.0015)
    setCanvasView(prev => {
      const nextScale = clampCanvasScale(prev.scale * zoomFactor)
      const worldX = (pointerX - prev.x) / prev.scale
      const worldY = (pointerY - prev.y) / prev.scale
      return {
        scale: nextScale,
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale,
      }
    })
  }

  const handleCanvasPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    setOpenNodeMenuId(null)
    const target = event.target
    if (target instanceof Element && target.closest('.canvas-node, .canvas-controls, .modal-backdrop')) return
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: canvasView.x,
      originY: canvasView.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsCanvasPanning(true)
  }

  const handleCanvasPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isCanvasPanning || canvasPanRef.current.pointerId !== event.pointerId) return
    const deltaX = event.clientX - canvasPanRef.current.startX
    const deltaY = event.clientY - canvasPanRef.current.startY
    setCanvasView(prev => ({
      ...prev,
      x: canvasPanRef.current.originX + deltaX,
      y: canvasPanRef.current.originY + deltaY,
    }))
  }

  const stopCanvasPan = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasPanRef.current.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    canvasPanRef.current.pointerId = -1
    setIsCanvasPanning(false)
  }

  const zoomCanvas = (factor: number) => {
    setCanvasView(prev => ({ ...prev, scale: clampCanvasScale(prev.scale * factor) }))
  }

  const handleNodePointerDown = (event: PointerEvent<HTMLElement>, nodeId: string) => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button, a, input, textarea, select')) return
    setOpenNodeMenuId(null)
    const canvas = event.currentTarget.closest('.dev-canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const origin = nodePositions[nodeId] ?? DEFAULT_NODE_POSITIONS[nodeId]
    nodeDragRef.current = {
      pointerId: event.pointerId,
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      canvasWidth: Math.max(1, rect.width),
      canvasHeight: Math.max(1, rect.height),
    }
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggedNodeId(nodeId)
  }

  const handleNodePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (nodeDragRef.current.pointerId !== event.pointerId) return
    const deltaX = ((event.clientX - nodeDragRef.current.startX) / canvasView.scale / nodeDragRef.current.canvasWidth) * 100
    const deltaY = ((event.clientY - nodeDragRef.current.startY) / canvasView.scale / nodeDragRef.current.canvasHeight) * 100
    const nextPosition = clampNodePosition({
      x: nodeDragRef.current.originX + deltaX,
      y: nodeDragRef.current.originY + deltaY,
    })
    setNodePositions(prev => ({ ...prev, [nodeDragRef.current.nodeId]: nextPosition }))
  }

  const stopNodeDrag = (event: PointerEvent<HTMLElement>) => {
    if (nodeDragRef.current.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    nodeDragRef.current.pointerId = -1
    setDraggedNodeId(null)
  }

  const openNodeInfo = (nodeId: string) => {
    setOpenNodeMenuId(null)
    setSelectedDevNodeId(nodeId)
  }

  return (
    <div className="app-shell">
      <main className="main">
        <header className="top">
          <div className="top-brand">
            <div className={`brand-mark ${devControlStatus}`} title={`Dev Control backend: ${devControlStatus}`}>
              <span className="brand-brace">{'{'}</span>
              <span className="brand-status-dot" />
              <span className="brand-brace">{'}'}</span>
            </div>
            <div className="top-copy">
              <h1>{kind === 'dev' ? 'Ava Dev Control Panel' : 'Unit Test'}</h1>
              <p>
                {kind === 'dev'
                  ? <>Full-page feature orchestration for local Ava development.</>
                  : <>{targetKindLabel(kind)} · CWD: <code>{cwd || '(not loaded)'}</code></>}
              </p>
              {kind !== 'dev' && logPath && <p>Log: <code>{logPath}</code></p>}
            </div>
          </div>
          {kind !== 'dev' && (
            <div className="actions">
              <button className="ghost" onClick={() => setKind('dev')}>Back</button>
              <div className="section-tabs">
                {TEST_KINDS.map(item => (
                  <button key={item} className={kind === item ? 'active' : ''} onClick={() => setKind(item)}>
                    {targetKindLabel(item)}
                    <span>{targets.filter(target => target.kind === item).length}</span>
                  </button>
                ))}
              </div>
              <button className="ghost" onClick={refresh} disabled={loading}>
                <RefreshCw size={14} className={loading ? 'spin' : ''} />
                Refresh
              </button>
              <button className="primary" onClick={runVisibleTargets} disabled={loading || visibleTargets.length === 0}>
                Run {targetKindLabel(kind)}
              </button>
            </div>
          )}
        </header>

        {kind !== 'dev' && error && <div className="error-banner">{error}</div>}
        {kind !== 'dev' && devError && <div className="error-banner">{devError}</div>}

        {kind === 'dev' ? (
          <section className="dev-panel">
            <div
              className={`dev-canvas ${isCanvasPanning ? 'panning' : ''}`}
              onWheel={handleCanvasWheel}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={stopCanvasPan}
              onPointerCancel={stopCanvasPan}
            >
              <div className="canvas-controls" onPointerDown={event => event.stopPropagation()}>
                <button onClick={() => zoomCanvas(0.85)}>-</button>
                <button onClick={() => setCanvasView({ x: 0, y: 0, scale: 1 })}>{Math.round(canvasView.scale * 100)}%</button>
                <button onClick={() => zoomCanvas(1.18)}>+</button>
              </div>
              <div
                className="canvas-world"
                ref={canvasWorldRef}
                style={{ transform: `translate(${canvasView.x}px, ${canvasView.y}px) scale(${canvasView.scale})` }}
              >
                <svg className="dependency-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="blueprintDependencyLine" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#1da7ff" />
                      <stop offset="50%" stopColor="#6bdcff" />
                      <stop offset="100%" stopColor="#2f8cff" />
                    </linearGradient>
                  </defs>
                  {pinLines.map(line => {
                    const leftToRight = line.sourceX <= line.targetX
                    const tension = Math.max(8, Math.abs(line.targetX - line.sourceX) * 0.42)
                    const controlSourceX = line.sourceX + (leftToRight ? tension : -tension)
                    const controlTargetX = line.targetX - (leftToRight ? tension : -tension)
                    const path = `M ${line.sourceX} ${line.sourceY} C ${controlSourceX} ${line.sourceY}, ${controlTargetX} ${line.targetY}, ${line.targetX} ${line.targetY}`
                    return (
                      <g className="dependency-link feature-dependency-link" key={line.id}>
                        <title>{line.featureName}</title>
                        <path className="dependency-path-glow" d={path} />
                        <path className="dependency-path" d={path} />
                      </g>
                    )
                  })}
                </svg>
                {dependencyNodes.map(node => {
                  const process = node.process
                  const feature = node.feature
                  const status = feature?.status ?? process?.status ?? 'unavailable'
                  const dependencyId = node.metadata.dependsOn[0] ?? 'internal'
                  const dependencyPinColor = dependencyColorFor(dependencyId)
                  return (
                    <article
                      key={node.id}
                      className={`canvas-node ${status} ${draggedNodeId === node.id ? 'dragging' : ''}`}
                      style={{ left: `${node.x}%`, top: `${node.y}%` }}
                      onPointerDown={event => handleNodePointerDown(event, node.id)}
                      onPointerMove={handleNodePointerMove}
                      onPointerUp={stopNodeDrag}
                      onPointerCancel={stopNodeDrag}
                    >
                      <div className="canvas-node-top">
                        <strong>{feature?.label ?? process?.label ?? node.id}</strong>
                        <div className="canvas-node-badges">
                          <button
                            className="icon-button"
                            title="Actions"
                            onClick={() => setOpenNodeMenuId(current => current === node.id ? null : node.id)}
                          >
                            <MoreHorizontal size={13} />
                          </button>
                          {openNodeMenuId === node.id && (
                            <div className="node-action-menu" onPointerDown={event => event.stopPropagation()}>
                              {feature ? (
                                <>
                                  <button onClick={() => { setOpenNodeMenuId(null); setKind('daemon') }}>Open Unit Test</button>
                                  <button onClick={() => openNodeInfo(node.id)}>Information</button>
                                </>
                              ) : (
                                <>
                                  <button disabled={!process?.available || process.running} onClick={() => { setOpenNodeMenuId(null); void controlDevProcess(node.id, 'start') }}>Start</button>
                                  <button disabled={!process?.available || !process.running} onClick={() => { setOpenNodeMenuId(null); void controlDevProcess(node.id, 'stop') }}>Stop</button>
                                  <button disabled={!process?.available} onClick={() => { setOpenNodeMenuId(null); void controlDevProcess(node.id, 'restart') }}>Restart</button>
                                  <button onClick={() => openNodeInfo(node.id)}>Information</button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                    </div>
                    <p>{feature?.description ?? process?.description ?? 'Not registered.'}</p>
                      <div className="node-feature-list">
                        {node.metadata.features.slice(0, 3).map((item, featureIndex) => (
                          <div className="node-feature-row" key={item}>
                            <i
                              className="dependency-row-pin input"
                              ref={element => { pinRefs.current[`${node.id}:${featureIndex}:input`] = element }}
                              style={{ '--pin-color': DEPENDENCY_PIN_COLORS[node.id] ?? '#6bdcff' } as CSSProperties}
                              title="Dependency input"
                            />
                            <span>{item}</span>
                            <i
                              className={node.metadata.dependsOn.length > 0 ? 'dependency-row-pin output' : 'dependency-row-pin output internal'}
                              ref={element => { pinRefs.current[`${node.id}:${featureIndex}:output`] = element }}
                              style={{ '--pin-color': dependencyPinColor } as CSSProperties}
                              title={node.metadata.dependsOn.length > 0 ? 'Connected dependency' : 'Internal feature'}
                            />
                          </div>
                        ))}
                      </div>
                      <div className="canvas-node-footer">
                        <span className={`pill ${status}`}>{status === 'feature' ? 'open' : process?.status ?? 'missing'}</span>
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>

            {selectedDevNode && (
              <div className="modal-backdrop" onClick={() => setSelectedDevNodeId(null)}>
                <article className="dev-modal" onClick={event => event.stopPropagation()}>
                  <div className="dev-card-head">
                    <div>
                      <h2>{selectedDevNode.feature?.label ?? selectedDevProcess?.label ?? selectedDevNode.id}</h2>
                      <p>{selectedDevNode.feature?.description ?? selectedDevProcess?.description ?? 'Not registered.'}</p>
                    </div>
                    <div className="modal-head-actions">
                      <span className={`pill ${selectedDevNode.feature?.status ?? selectedDevProcess?.status ?? 'unavailable'}`}>
                        {selectedDevNode.feature?.status ?? selectedDevProcess?.status ?? 'missing'}
                      </span>
                      <button className="icon-button" title="Close" onClick={() => setSelectedDevNodeId(null)}>
                        <X size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="dev-detail-grid">
                    <section className="dev-detail-section">
                      <h3>Main features</h3>
                      <ul>
                        {selectedDevNode.metadata.features.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </section>
                    <section className="dev-detail-section">
                      <h3>Dependencies</h3>
                      <ul>
                        {selectedDevNode.metadata.dependencies.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </section>
                  </div>

                  {selectedDevProcess ? (
                    <>
                      <div className="dev-meta">
                        <div><strong>Command</strong><code>{selectedDevProcess.command}</code></div>
                        <div><strong>CWD</strong><code>{selectedDevProcess.cwd}</code></div>
                        <div><strong>Ports</strong><code>{selectedDevProcess.ports.join(', ') || '-'}</code></div>
                        <div><strong>PID</strong><code>{selectedDevProcess.pid ?? selectedDevProcess.externalPids?.join(', ') ?? '-'}</code></div>
                        <div><strong>URL</strong><code>{selectedDevProcess.url}</code></div>
                      </div>

                      <div className="dev-actions">
                        <button className="primary" disabled={devBusyId === selectedDevProcess.id || !selectedDevProcess.available || selectedDevProcess.running} onClick={() => void controlDevProcess(selectedDevProcess.id, 'start')}>Start</button>
                        <button className="ghost" disabled={devBusyId === selectedDevProcess.id || !selectedDevProcess.available || !selectedDevProcess.running} onClick={() => void controlDevProcess(selectedDevProcess.id, 'stop')}>Stop</button>
                        <button className="ghost" disabled={devBusyId === selectedDevProcess.id || !selectedDevProcess.available} onClick={() => void controlDevProcess(selectedDevProcess.id, 'restart')}>Restart</button>
                      </div>

                      <pre className="dev-log">
                        {(devLogs[selectedDevProcess.id] ?? []).slice(-120).map(line => `[${line.stream}] ${line.line}`).join('\n') || 'No managed logs yet.'}
                      </pre>
                    </>
                  ) : (
                    <div className="dev-meta">
                      <div><strong>Type</strong><code>Feature</code></div>
                      <div><strong>URL</strong><code>{selectedDevNode.feature?.url ?? '-'}</code></div>
                    </div>
                  )}

                  {selectedDevNode.feature && (
                    <div className="dev-actions">
                      <button className="primary" onClick={() => { setSelectedDevNodeId(null); setKind('daemon') }}>Open Unit Test</button>
                    </div>
                  )}
                </article>
              </div>
            )}
          </section>
        ) : (
          <section className="content">
          <div className="target-list">
            {loading ? (
              <div className="empty">Loading daemon context...</div>
            ) : visibleTargets.length === 0 ? (
              <div className="empty">No {kind} targets found.</div>
            ) : (
              visibleTargets.map(target => {
                const row = tests[target.id]
                return (
                  <button
                    key={target.id}
                    ref={node => { targetRefs.current[target.id] = node }}
                    className={`target-row ${selected?.id === target.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(target.id)}
                  >
                    {statusIcon(row?.status ?? 'idle')}
                    <span className="target-copy">
                      <strong>{target.label}</strong>
                      {target.meta && <small>{target.meta}</small>}
                    </span>
                  </button>
                )
              })
            )}
          </div>

          <div className="detail">
            {selected ? (
              <>
                <section className="card">
                  <div className="card-head">
                    <div>
                      <div className="selected-title">
                        {statusIcon(selectedState?.status ?? 'idle')}
                        <span>{selected.label}</span>
                      </div>
                      {selected.description && <p>{selected.description}</p>}
                    </div>
                    <button className="primary" onClick={() => runTarget(selected)} disabled={selectedState?.status === 'running'}>
                      <Play size={14} />
                      Run
                    </button>
                  </div>
                  {selectedState?.message && (
                    <div className={`result ${selectedState.status}`}>
                      {selectedState.message}
                    </div>
                  )}
                  {selectedState?.lastTool && <div className="tool-line">Tool calls: {selectedState.lastTool}</div>}
                  {selectedState?.durationMs !== undefined && <div className="tool-line">Duration: {selectedState.durationMs}ms</div>}
                </section>

                <section className="field">
                  <div className="field-label">Request</div>
                  <textarea
                    value={selectedState?.request ?? selected.defaultRequest}
                    onChange={event => updateRequest(selected.id, event.target.value)}
                  />
                </section>

                {selectedState?.fullContent && (
                  <section className="field">
                    <div className="field-label">Response</div>
                    <pre>{selectedState.fullContent}</pre>
                  </section>
                )}

                {selected.inputSchema !== undefined && (
                  <section className="field">
                    <div className="field-label">Input Schema</div>
                    <pre>{JSON.stringify(selected.inputSchema, null, 2)}</pre>
                  </section>
                )}
              </>
            ) : (
              <div className="empty">No target selected.</div>
            )}
          </div>
          </section>
        )}
      </main>
    </div>
  )
}
