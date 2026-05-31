import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent, WheelEvent } from 'react'
import { CheckCircle2, ClipboardList, FlaskConical, HelpCircle, Play, RefreshCw, Trash2, X, XCircle } from 'lucide-react'
import { AvaClient } from '@ava/client-sdk'
import type { AvaChatStreamEvent, AvaCodeAgentSession, AvaDaemonChatRequest } from '@ava/contracts'

type TargetKind = 'daemon' | 'intent' | 'workflow' | 'code-agent' | 'built-in' | 'mcp' | 'skill' | 'dev' | 'audit' | 'brain'
type TestStatus = 'idle' | 'running' | 'passed' | 'failed'
type BackendStatus = 'checking' | 'online' | 'offline'
type CanvasView = { x: number; y: number; scale: number }
type CanvasSize = { width: number; height: number }
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
  completedAt?: number
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

interface TestSummary {
  total: number
  tested: number
  passed: number
  failed: number
  running: number
  status: TestStatus
  label: string
  lastCompletedAt?: number
}

interface DaemonRequest {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
  expectEventTypes?: string[]
  expectJson?: Record<string, unknown>
  expectJsonOneOf?: Record<string, unknown[]>
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

interface ToolAuditEntry {
  id: string
  createdAt: number
  providerName: string
  model: string
  toolName: string
  toolCallId: string
  streamId: string
  taskId?: string
  status: 'ok' | 'error' | 'aborted'
  durationMs: number
  serverId?: string
  pluginId?: string
  args: unknown
  error?: string
  resultPreview?: string
  commandInvocation?: {
    pluginName: string
    commandName: string
  }
}

interface DevEnvironment {
  nodeRuntime?: {
    kind: string
    version: string
    execPath: string
    platform: string
    arch: string
    npmCommand: string
  }
  localhostPorts?: {
    kind: string
    host: string
    devControlPort: number
    knownPorts: number[]
  }
}

interface DevLayout {
  nodePositions?: Record<string, NodePosition>
  updatedAt?: string | null
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
    url?: string
  }
}

interface DevNodeMetadata {
  type: 'runtime-core' | 'desktop-client' | 'web-client' | 'dev-infra' | 'test-surface' | 'environment' | 'service'
  features: string[]
  dependencies: string[]
  dependsOn: string[]
}

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:17871'
const DEFAULT_DEV_CONTROL_URL = 'http://127.0.0.1:17872'
const NODE_POSITIONS_STORAGE_KEY = 'ava-dev-control-node-positions'
const TEST_KINDS = ['daemon', 'intent', 'workflow', 'code-agent', 'built-in', 'mcp', 'skill'] as const
const DEFAULT_NODE_POSITIONS: Record<string, NodePosition> = {
  daemon: { x: 50, y: 50 },
  'node-runtime': { x: 50, y: 8 },
  'localhost-ports': { x: 84, y: 8 },
  'local-llm': { x: 21, y: 5 },
  'speech-services': { x: 21, y: 102 },
  'ava-desktop': { x: 21, y: 25 },
  'web-ui': { x: 21, y: 72 },
  'dev-control-backend': { x: 79, y: 28 },
  'daemon-test-ui': { x: 79, y: 47 },
}
const CANVAS_NODE_POSITION_MIN = -500
const CANVAS_NODE_POSITION_MAX = 600
const DEV_NODE_METADATA: Record<string, DevNodeMetadata> = {
  daemon: {
    type: 'runtime-core',
    features: [
      'Runtime HTTP/SSE API',
      'Config and model router',
      'Built-in tools runtime',
      'MCP and skill context',
      'Process registry',
      'Code agent sessions',
    ],
    dependencies: ['Node runtime', 'Localhost ports', 'Local config', 'Local LLM runtime', 'Ava Speech plugin', 'Workspace filesystem', 'MCP servers'],
    dependsOn: ['node-runtime', 'localhost-ports', 'local-llm', 'speech-services'],
  },
  'ava-desktop': {
    type: 'desktop-client',
    features: [
      'Chat workspace UI',
      'Settings and providers',
      'Tool blocks and preview',
      'Agent task progress',
    ],
    dependencies: ['Ava Daemon runtime API', 'Node runtime', 'Localhost ports', 'Electron shell'],
    dependsOn: ['daemon', 'node-runtime', 'localhost-ports'],
  },
  'web-ui': {
    type: 'web-client',
    features: [
      'Browser chat workspace',
      'Shared client SDK',
      'Daemon stream client',
      'Tool activity preview',
    ],
    dependencies: ['Ava Daemon runtime API', 'Node runtime', 'Localhost ports', 'Client SDK'],
    dependsOn: ['daemon', 'node-runtime', 'localhost-ports'],
  },
  'daemon-test-ui': {
    type: 'dev-infra',
    features: [
      'Feature orchestration canvas',
      'Daemon health monitor',
      'Unit test launcher',
      'Ava Brain map',
      'Tool audit log',
      'Browser test surface',
      'Code agent routing tests',
    ],
    dependencies: ['Ava Dev Supervisor', 'Ava Daemon for tests', 'Node runtime', 'Localhost ports'],
    dependsOn: ['dev-control-backend', 'daemon', 'node-runtime', 'localhost-ports'],
  },
  'dev-control-backend': {
    type: 'dev-infra',
    features: [
      'Process registry API',
      'Start/stop/restart services',
      'Managed process logs',
      'Workspace script orchestration',
      'Dev service health',
    ],
    dependencies: ['Node runtime', 'Localhost ports', 'Root package scripts'],
    dependsOn: ['node-runtime', 'localhost-ports'],
  },
  'node-runtime': {
    type: 'environment',
    features: [
      'HTTP/SSE daemon host',
      'npm workspace scripts',
      'Child process runtime',
      'Build/toolchain runtime',
      'MCP/tool helper runtime',
    ],
    dependencies: [],
    dependsOn: [],
  },
  'localhost-ports': {
    type: 'environment',
    features: [
      'Listening port PID scan',
      'Local service URL registry',
      'External process detection',
    ],
    dependencies: [],
    dependsOn: [],
  },
  'local-llm': {
    type: 'service',
    features: [
      'OpenAI-compatible chat API',
      'Model launch / warmup',
      'Tool-capable provider profile',
      'Reasoning mode profile',
    ],
    dependencies: ['Local LLM app', 'Model files', 'Localhost ports'],
    dependsOn: ['localhost-ports'],
  },
  'speech-services': {
    type: 'service',
    features: [
      'speech.stt capability',
      'speech.tts capability',
      'Audio device bridge',
      'Voice session pipeline',
    ],
    dependencies: ['Speech model/runtime', 'Audio input/output devices', 'Localhost ports', 'Ava plugin runtime'],
    dependsOn: ['localhost-ports'],
  },
}
const DEPENDENCY_PIN_COLORS: Record<string, string> = {
  daemon: '#56d6ff',
  'node-runtime': '#d7b36a',
  'localhost-ports': '#d7b36a',
  'local-llm': '#c792ff',
  'speech-services': '#ff9f7a',
  'ava-desktop': '#76e2a8',
  'web-ui': '#ff7aa7',
  'dev-control-backend': '#f4c95d',
  'daemon-test-ui': '#ffd36a',
}
const SVG_NODE_WIDTH = 285
const SVG_NODE_BASE_HEIGHT = 148
const SVG_NODE_BOTTOM_PADDING = 40
const SVG_FEATURE_HEIGHT = 23
const SVG_FEATURE_GAP = 7

function targetKindLabel(kind: TargetKind) {
  if (kind === 'intent') return 'Intent Gate'
  if (kind === 'workflow') return 'Workflow Dispatcher'
  if (kind === 'code-agent') return 'Code Agent Dispatcher'
  if (kind === 'built-in') return 'Built-in Tools'
  if (kind === 'mcp') return 'MCP Tools'
  if (kind === 'skill') return 'Skills'
  if (kind === 'daemon') return 'Daemon'
  if (kind === 'audit') return 'Tool Audit'
  if (kind === 'brain') return 'Ava Brain'
  return 'Control'
}

function clampCanvasScale(scale: number) {
  return Math.min(2.4, Math.max(0.45, scale))
}

function clampNodePosition(position: NodePosition): NodePosition {
  return {
    x: Math.min(CANVAS_NODE_POSITION_MAX, Math.max(CANVAS_NODE_POSITION_MIN, position.x)),
    y: Math.min(CANVAS_NODE_POSITION_MAX, Math.max(CANVAS_NODE_POSITION_MIN, position.y)),
  }
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function wrapTextLines(text: string, maxLineLength: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxLineLength) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length >= maxLines) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === 0) lines.push('')
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = truncateText(lines[maxLines - 1], maxLineLength)
  }
  return lines
}

function nodeCenter(node: NodePosition, canvasSize: CanvasSize) {
  return {
    x: (node.x / 100) * canvasSize.width,
    y: (node.y / 100) * canvasSize.height,
  }
}

function nodeLeft(node: NodePosition, canvasSize: CanvasSize) {
  return nodeCenter(node, canvasSize).x - SVG_NODE_WIDTH / 2
}

function nodeHeight(node: Pick<DevDependencyNode, 'metadata'>) {
  const featureCount = Math.max(1, node.metadata.features.length)
  return SVG_NODE_BASE_HEIGHT + featureCount * (SVG_FEATURE_HEIGHT + SVG_FEATURE_GAP) + SVG_NODE_BOTTOM_PADDING
}

function nodeTop(node: DevDependencyNode, canvasSize: CanvasSize) {
  return nodeCenter(node, canvasSize).y - nodeHeight(node) / 2
}

function cardDependencyPinPosition(node: DevDependencyNode, canvasSize: CanvasSize, side: 'input' | 'output') {
  const x = side === 'input'
    ? nodeLeft(node, canvasSize)
    : nodeLeft(node, canvasSize) + SVG_NODE_WIDTH
  const y = nodeTop(node, canvasSize) + nodeHeight(node) / 2
  return { x, y }
}

function nodeScreenStyle(node: DevDependencyNode, canvasSize: CanvasSize, canvasView: CanvasView): CSSProperties {
  const center = nodeCenter(node, canvasSize)
  const scale = canvasView.scale
  return {
    left: center.x * scale + canvasView.x,
    top: center.y * scale + canvasView.y,
    width: SVG_NODE_WIDTH * scale,
    minHeight: nodeHeight(node) * scale,
    '--node-scale': scale,
  } as CSSProperties
}

function openExternalTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function embeddedAvaBrainUrl(_devControlUrl: string) {
  return '/ava-brain/input-flow?embed=1'
}

function isAvaBrainFeature(nodeId: string, featureName: string) {
  return nodeId === 'daemon-test-ui' && /ava brain/i.test(featureName)
}

function isUnitTestFeature(nodeId: string, featureName: string) {
  return nodeId === 'daemon-test-ui' && /unit test/i.test(featureName)
}

function isToolAuditFeature(nodeId: string, featureName: string) {
  return nodeId === 'daemon-test-ui' && /tool audit/i.test(featureName)
}

function displayDevStatus(node: DevDependencyNode, status: string, process?: DevProcess) {
  if (node.id === 'daemon-test-ui' && process?.status === 'external') return 'active'
  return status
}

function normalizeNodePositions(value: unknown): Record<string, NodePosition> {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Partial<NodePosition>>
    : {}
  return Object.fromEntries(
    Object.entries(DEFAULT_NODE_POSITIONS).map(([id, fallback]) => {
      const position = input[id]
      return [
        id,
        typeof position?.x === 'number' && typeof position?.y === 'number'
          ? clampNodePosition({ x: position.x, y: position.y })
          : fallback,
      ]
    }),
  )
}

function hasSavedNodePositions(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0)
}

function loadLocalNodePositions(): Record<string, NodePosition> {
  try {
    const raw = localStorage.getItem(NODE_POSITIONS_STORAGE_KEY)
    if (!raw) return DEFAULT_NODE_POSITIONS
    return normalizeNodePositions(JSON.parse(raw))
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

function makeIntentGateTargets(baseUrl: string): TestTarget[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  const url = `${normalized}/input/classify`
  return [
    {
      id: 'intent:meta-question',
      kind: 'intent',
      name: 'intent.meta_question',
      label: 'meta_question',
      description: 'Classify an Ava capability question as a meta chat question.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'What can Ava do?' },
        expectJson: {
          'result.route': 'meta_question',
          'result.workflow': 'chat',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:normal-chat',
      kind: 'intent',
      name: 'intent.normal_chat',
      label: 'normal_chat',
      description: 'Classify a regular conversational input as normal chat.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Tell me a short joke about debugging.' },
        expectJson: {
          'result.route': 'normal_chat',
          'result.workflow': 'chat',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:task-intake',
      kind: 'intent',
      name: 'intent.task_intake',
      label: 'task_intake',
      description: 'Classify a large coding/design request as task intake.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Create a professional 3D animation site that can load a GLB model and let the user control the camera.' },
        expectJson: {
          'result.route': 'task_intake',
          'result.workflow': 'intake',
          'result.requiresTaskIntake': true,
        },
      }),
    },
    {
      id: 'intent:intake-correction',
      kind: 'intent',
      name: 'intent.requirement_correction',
      label: 'requirement_correction',
      description: 'When intake is active, detect that the user corrected the goal instead of answering the old question.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'No, I want to check what Ava can do first.',
          pendingIntake: true,
          pendingIntakeStage: 'clarifying',
        },
        expectJson: {
          'result.route': 'meta_question',
          'result.workflow': 'chat',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:continue-intake',
      kind: 'intent',
      name: 'intent.continue_intake',
      label: 'continue_intake',
      description: 'When intake is active, classify a normal answer as continuing intake.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'Use React and create it in D:\\Apps\\Scene.',
          pendingIntake: true,
          pendingIntakeStage: 'clarifying',
        },
        expectJson: {
          'result.route': 'continue_intake',
          'result.workflow': 'intake_reply',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:task-confirmation',
      kind: 'intent',
      name: 'intent.task_confirmation',
      label: 'task_confirmation',
      description: 'When summary confirmation is pending, classify confirmation as task confirmation.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'confirm',
          pendingIntake: true,
          pendingIntakeStage: 'awaiting_summary_confirm',
        },
        expectJson: {
          'result.route': 'task_confirmation',
          'result.workflow': 'intake',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:requirement-correction',
      kind: 'intent',
      name: 'intent.requirement_correction',
      label: 'requirement_correction',
      description: 'When intake is active, classify a requirement correction as intake reanalysis.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'Actually change it to a desktop app first.',
          pendingIntake: true,
          pendingIntakeStage: 'clarifying',
        },
        expectJson: {
          'result.route': 'requirement_correction',
          'result.workflow': 'intake_reanalysis',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:cancel-or-pause',
      kind: 'intent',
      name: 'intent.cancel_or_pause',
      label: 'cancel_or_pause',
      description: 'Classify explicit cancel/stop input as cancel_or_pause.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'stop' },
        expectJson: {
          'result.route': 'cancel_or_pause',
          'result.workflow': 'cancel',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:permission-response',
      kind: 'intent',
      name: 'intent.permission_response',
      label: 'permission_response',
      description: 'Classify allow/deny style replies as permission handling.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'allow this workspace access' },
        expectJson: {
          'result.route': 'permission_response',
          'result.workflow': 'permission',
        },
      }),
    },
    {
      id: 'intent:retry-or-continue',
      kind: 'intent',
      name: 'intent.retry_or_continue',
      label: 'retry_or_continue',
      description: 'Classify continue/retry replies as task recovery.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'continue' },
        expectJson: {
          'result.route': 'retry_or_continue',
          'result.workflow': 'recovery',
        },
      }),
    },
    {
      id: 'intent:small-task',
      kind: 'intent',
      name: 'intent.small_task',
      label: 'small_task',
      description: 'Classify a small file lookup as direct tool work.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Read package.json and tell me name and version.' },
        expectJson: {
          'result.route': 'small_task',
          'result.workflow': 'direct_tool',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:file-or-attachment-input',
      kind: 'intent',
      name: 'intent.file_or_attachment_input',
      label: 'file_or_attachment_input',
      description: 'Classify file attachment input as file/media workflow.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'Please inspect this file.',
          attachments: [{ kind: 'document', path: 'D:\\Apps\\Ava\\package.json', name: 'package.json' }],
        },
        expectJson: {
          'result.route': 'file_or_attachment_input',
          'result.workflow': 'file_media',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:url-input',
      kind: 'intent',
      name: 'intent.url_input',
      label: 'url_input',
      description: 'Classify URL input as browser workflow.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Check http://127.0.0.1:5179/' },
        expectJson: {
          'result.route': 'url_input',
          'result.workflow': 'browser',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:agent-delegation',
      kind: 'intent',
      name: 'intent.agent_delegation',
      label: 'agent_delegation',
      description: 'Classify explicit code-agent delegation requests.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Assign this task to Claude Code.' },
        expectJson: {
          'result.route': 'agent_delegation',
          'result.workflow': 'delegation',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:preference-or-setting',
      kind: 'intent',
      name: 'intent.preference_or_setting',
      label: 'preference_or_setting',
      description: 'Classify user preference or settings input.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Always answer me in Chinese by default.' },
        expectJson: {
          'result.route': 'preference_or_setting',
          'result.workflow': 'settings',
          'result.requiresTaskIntake': false,
        },
      }),
    },
    {
      id: 'intent:unknown-or-ambiguous',
      kind: 'intent',
      name: 'intent.unknown_or_ambiguous',
      label: 'unknown_or_ambiguous',
      description: 'Classify a context-dependent short input as ambiguous.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'this' },
        expectJson: {
          'result.route': 'unknown_or_ambiguous',
          'result.workflow': 'clarify',
          'result.requiresTaskIntake': false,
          'result.needsClarification': true,
        },
      }),
    },
  ]
}

function makeWorkflowDispatcherTargets(baseUrl: string): TestTarget[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  const url = `${normalized}/input/dispatch`
  return [
    {
      id: 'workflow:chat',
      kind: 'workflow',
      name: 'workflow.run_chat',
      label: 'run_chat',
      description: 'Dispatch a regular chat/meta question to chat.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'What can Ava do?' },
        expectJson: {
          'result.classification.route': 'meta_question',
          'result.action': 'run_chat',
          'result.workflow': 'chat',
          'result.status': 'implemented',
        },
      }),
    },
    {
      id: 'workflow:task-intake',
      kind: 'workflow',
      name: 'workflow.start_task_intake',
      label: 'start_task_intake',
      description: 'Dispatch a big coding/design request to task intake.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Create a professional 3D animation site that can load a GLB model and let the user control the camera.' },
        expectJson: {
          'result.classification.route': 'task_intake',
          'result.action': 'start_task_intake',
          'result.workflow': 'intake',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:continue-intake',
      kind: 'workflow',
      name: 'workflow.continue_intake',
      label: 'continue_intake',
      description: 'Dispatch an answer during active intake to continue intake.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'Use React and create it in D:\\Apps\\Scene.',
          pendingIntake: true,
          pendingIntakeStage: 'clarifying',
        },
        expectJson: {
          'result.classification.route': 'continue_intake',
          'result.action': 'continue_intake',
          'result.workflow': 'intake_reply',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:confirm-task',
      kind: 'workflow',
      name: 'workflow.confirm_task',
      label: 'confirm_task',
      description: 'Dispatch summary confirmation to confirmed task start.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'confirm',
          pendingIntake: true,
          pendingIntakeStage: 'awaiting_summary_confirm',
        },
        expectJson: {
          'result.classification.route': 'task_confirmation',
          'result.action': 'confirm_task',
          'result.workflow': 'intake',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:reanalyze-intake',
      kind: 'workflow',
      name: 'workflow.reanalyze_intake',
      label: 'reanalyze_intake',
      description: 'Dispatch requirement corrections to intake reanalysis.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'Actually change it to a desktop app first.',
          pendingIntake: true,
          pendingIntakeStage: 'clarifying',
        },
        expectJson: {
          'result.classification.route': 'requirement_correction',
          'result.action': 'reanalyze_intake',
          'result.workflow': 'intake_reanalysis',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:cancel-intake',
      kind: 'workflow',
      name: 'workflow.cancel_intake',
      label: 'cancel_intake',
      description: 'Dispatch explicit cancel/stop input to cancel intake.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'stop' },
        expectJson: {
          'result.classification.route': 'cancel_or_pause',
          'result.action': 'cancel_intake',
          'result.workflow': 'cancel',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:recovery',
      kind: 'workflow',
      name: 'workflow.recover_task',
      label: 'recover_task',
      description: 'Dispatch retry/continue replies to task recovery.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'retry' },
        expectJson: {
          'result.classification.route': 'retry_or_continue',
          'result.action': 'recover_task',
          'result.workflow': 'recovery',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:permission',
      kind: 'workflow',
      name: 'workflow.handle_permission',
      label: 'handle_permission',
      description: 'Dispatch permission replies to permission handling.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'approve file access' },
        expectJson: {
          'result.classification.route': 'permission_response',
          'result.action': 'handle_permission',
          'result.workflow': 'permission',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:direct-tool',
      kind: 'workflow',
      name: 'workflow.run_direct_tool',
      label: 'run_direct_tool',
      description: 'Dispatch a small file-info request to direct tool execution.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Read package.json and tell me name and version.' },
        expectJson: {
          'result.classification.route': 'small_task',
          'result.action': 'run_direct_tool',
          'result.workflow': 'direct_tool',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:file-media',
      kind: 'workflow',
      name: 'workflow.handle_file_media',
      label: 'handle_file_media',
      description: 'Dispatch file or media attachments to file/media handling.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: {
          content: 'Please inspect this file.',
          attachments: [{ kind: 'document', path: 'D:\\Apps\\Ava\\package.json', name: 'package.json' }],
        },
        expectJson: {
          'result.classification.route': 'file_or_attachment_input',
          'result.action': 'handle_file_media',
          'result.workflow': 'file_media',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:url',
      kind: 'workflow',
      name: 'workflow.handle_url',
      label: 'handle_url',
      description: 'Dispatch URL inputs to browser handling.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Check http://127.0.0.1:5179/' },
        expectJson: {
          'result.classification.route': 'url_input',
          'result.action': 'handle_url',
          'result.workflow': 'browser',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:delegate-agent',
      kind: 'workflow',
      name: 'workflow.delegate_to_code_agent',
      label: 'delegate_to_code_agent',
      description: 'Dispatch explicit code-agent delegation to the delegation workflow.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Assign this task to Claude Code.' },
        expectJson: {
          'result.classification.route': 'agent_delegation',
          'result.action': 'delegate_to_code_agent',
          'result.workflow': 'delegation',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:update-preference',
      kind: 'workflow',
      name: 'workflow.update_preference',
      label: 'update_preference',
      description: 'Dispatch user preference or settings input to preference handling.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'Always answer me in Chinese by default.' },
        expectJson: {
          'result.classification.route': 'preference_or_setting',
          'result.action': 'update_preference',
          'result.workflow': 'settings',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
    {
      id: 'workflow:ask-clarifying-question',
      kind: 'workflow',
      name: 'workflow.ask_clarifying_question',
      label: 'ask_clarifying_question',
      description: 'Dispatch ambiguous input to a clarification workflow.',
      defaultRequest: requestJson({
        method: 'POST',
        url,
        body: { content: 'this' },
        expectJson: {
          'result.classification.route': 'unknown_or_ambiguous',
          'result.action': 'ask_clarifying_question',
          'result.workflow': 'clarify',
          'result.status': 'implemented',
          'result.actionPreview.requiresConfirmation': false,
        },
      }),
    },
  ]
}

function makeCodeAgentDispatcherTargets(baseUrl: string): TestTarget[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  return [
    {
      id: 'code-agent:profiles',
      kind: 'code-agent',
      name: 'code_agent.profiles',
      label: 'profiles',
      description: 'GET /code-agents/profiles should return Ava code-agent capability profiles.',
      defaultRequest: requestJson({
        method: 'GET',
        url: `${normalized}/code-agents/profiles`,
      }),
    },
    {
      id: 'code-agent:dispatch',
      kind: 'code-agent',
      name: 'code_agent.dispatch',
      label: 'dispatch',
      description: 'POST /code-agents/dispatch should score available agents and create a session when one is ready.',
      defaultRequest: requestJson({
        method: 'POST',
        url: `${normalized}/code-agents/dispatch`,
        body: {
          goal: 'Fix a TypeScript build error in D:\\Apps\\Ava and report changed files plus validation.',
          workingDirectory: 'D:\\Apps\\Ava',
          taskKind: 'debug',
          constraints: ['Do not modify unrelated files.', 'Run typecheck after edits.'],
          validationCommands: ['npm run typecheck --workspace=@ava/shell'],
          startImmediately: false,
        },
        expectJsonOneOf: {
          'result.status': ['assigned', 'blocked'],
        },
      }),
    },
    {
      id: 'code-agent:sessions',
      kind: 'code-agent',
      name: 'code_agent.sessions',
      label: 'sessions',
      description: 'GET /code-agents/sessions should return the daemon-owned code-agent session registry.',
      defaultRequest: requestJson({
        method: 'GET',
        url: `${normalized}/code-agents/sessions`,
      }),
    },
  ]
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

function getJsonPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

function assertExpectedJson(
  fullContent: string,
  expected?: Record<string, unknown>,
  expectedOneOf?: Record<string, unknown[]>,
): string[] {
  if ((!expected || Object.keys(expected).length === 0) && (!expectedOneOf || Object.keys(expectedOneOf).length === 0)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(fullContent)
  } catch (err) {
    throw new Error(`Expected JSON response but parse failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const matched: string[] = []
  const missing: string[] = []
  for (const [path, expectedValue] of Object.entries(expected ?? {})) {
    const actual = getJsonPath(parsed, path)
    if (actual === expectedValue) {
      matched.push(`${path}=${String(expectedValue)}`)
    } else {
      missing.push(`${path}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`)
    }
  }
  for (const [path, expectedValues] of Object.entries(expectedOneOf ?? {})) {
    const actual = getJsonPath(parsed, path)
    if (expectedValues.some(value => value === actual)) {
      matched.push(`${path}=${String(actual)}`)
    } else {
      missing.push(`${path}: expected one of ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actual)}`)
    }
  }
  if (missing.length > 0) throw new Error(`JSON expectation failed: ${missing.join('; ')}`)
  return matched
}

function statusIcon(status: TestStatus) {
  if (status === 'passed') return <CheckCircle2 size={15} className="ok" />
  if (status === 'failed') return <XCircle size={15} className="bad" />
  if (status === 'running') return <RefreshCw size={15} className="spin accent" />
  return <FlaskConical size={15} className="muted" />
}

function summarizeTestTargets(items: TestTarget[], tests: Record<string, TestState>): TestSummary {
  const states = items.map(target => tests[target.id]).filter(Boolean)
  const running = states.filter(state => state.status === 'running').length
  const passed = states.filter(state => state.status === 'passed').length
  const failed = states.filter(state => state.status === 'failed').length
  const tested = passed + failed
  const total = items.length
  const lastCompletedAt = states.reduce<number | undefined>((latest, state) => (
    state.completedAt && (!latest || state.completedAt > latest) ? state.completedAt : latest
  ), undefined)
  const status: TestStatus = running > 0
    ? 'running'
    : failed > 0
      ? 'failed'
      : tested > 0 && tested === total
        ? 'passed'
        : 'idle'
  const label = total === 0
    ? 'no tests'
    : running > 0
      ? `${running} running`
      : tested === 0
        ? 'not run'
        : failed > 0
          ? `${passed}/${total} passed, ${failed} failed`
          : `${passed}/${total} passed`
  return { total, tested, passed, failed, running, status, label, lastCompletedAt }
}

function formatTestTime(timestamp?: number) {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString()
}

function latestCodeAgentEvent(session: AvaCodeAgentSession) {
  return session.events[session.events.length - 1]
}

function latestCodeAgentInputRequest(session: AvaCodeAgentSession) {
  return [...session.events].reverse().find(event => event.type === 'needs_input')?.message
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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
  const [autoTestRunning, setAutoTestRunning] = useState(false)
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
  const [devEnvironment, setDevEnvironment] = useState<DevEnvironment>({})
  const [devEnvironmentError, setDevEnvironmentError] = useState<string | null>(null)
  const [codeAgentSessions, setCodeAgentSessions] = useState<AvaCodeAgentSession[]>([])
  const [codeAgentError, setCodeAgentError] = useState<string | null>(null)
  const [codeAgentBusyId, setCodeAgentBusyId] = useState<string | null>(null)
  const [codeAgentInputById, setCodeAgentInputById] = useState<Record<string, string>>({})
  const [selectedDevNodeId, setSelectedDevNodeId] = useState<string | null>(null)
  const [auditEntries, setAuditEntries] = useState<ToolAuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null)
  const [canvasView, setCanvasView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 })
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 1, height: 1 })
  const [isCanvasPanning, setIsCanvasPanning] = useState(false)
  const [nodePositions, setNodePositions] = useState<Record<string, NodePosition>>(loadLocalNodePositions)
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null)
  const [openNodeMenuId, setOpenNodeMenuId] = useState<string | null>(null)
  const targetRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const devControlStatusRef = useRef<BackendStatus>('checking')
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const brainFrameRef = useRef<HTMLIFrameElement | null>(null)
  const canvasPanRef = useRef({ pointerId: -1, startX: 0, startY: 0, originX: 0, originY: 0 })
  const layoutLoadedRef = useRef(false)
  const layoutSaveTimerRef = useRef<number | null>(null)
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
  const loadToolAudit = useCallback(async () => {
    setAuditLoading(true)
    setAuditError(null)
    try {
      const entries = await client.listToolAudit<ToolAuditEntry[]>(100)
      setAuditEntries(entries)
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuditLoading(false)
    }
  }, [client])

  const clearToolAudit = useCallback(async () => {
    if (!window.confirm('Clear Tool Audit Log? This only deletes audit records.')) return
    setAuditLoading(true)
    setAuditError(null)
    try {
      await client.clearToolAudit()
      setAuditEntries([])
      setExpandedAuditId(null)
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuditLoading(false)
    }
  }, [client])

  const openToolAuditPage = useCallback(() => {
    setKind('audit')
    void loadToolAudit()
  }, [loadToolAudit])

  const openAvaBrainPage = useCallback(() => {
    setOpenNodeMenuId(null)
    setSelectedDevNodeId(null)
    setKind('brain')
  }, [])

  const loadCodeAgentSessions = useCallback(async () => {
    try {
      const result = await client.listCodeAgentSessions()
      setCodeAgentSessions(result.sessions)
      setCodeAgentError(null)
    } catch (err) {
      setCodeAgentError(err instanceof Error ? err.message : String(err))
    }
  }, [client])

  const startCodeAgentSession = useCallback(async (sessionId: string) => {
    setCodeAgentBusyId(sessionId)
    setCodeAgentError(null)
    try {
      await client.startCodeAgentSession(sessionId)
      await loadCodeAgentSessions()
    } catch (err) {
      setCodeAgentError(err instanceof Error ? err.message : String(err))
    } finally {
      setCodeAgentBusyId(null)
    }
  }, [client, loadCodeAgentSessions])

  const stopCodeAgentSession = useCallback(async (sessionId: string) => {
    setCodeAgentBusyId(sessionId)
    setCodeAgentError(null)
    try {
      await client.stopCodeAgentSession(sessionId)
      await loadCodeAgentSessions()
    } catch (err) {
      setCodeAgentError(err instanceof Error ? err.message : String(err))
    } finally {
      setCodeAgentBusyId(null)
    }
  }, [client, loadCodeAgentSessions])

  const sendCodeAgentInput = useCallback(async (sessionId: string) => {
    const message = codeAgentInputById[sessionId]?.trim()
    if (!message) return
    setCodeAgentBusyId(sessionId)
    setCodeAgentError(null)
    try {
      await client.sendCodeAgentSessionMessage({ sessionId, message })
      setCodeAgentInputById(prev => ({ ...prev, [sessionId]: '' }))
      await loadCodeAgentSessions()
    } catch (err) {
      setCodeAgentError(err instanceof Error ? err.message : String(err))
    } finally {
      setCodeAgentBusyId(null)
    }
  }, [client, codeAgentInputById, loadCodeAgentSessions])

  const openCodeAgentCwd = useCallback(async (path?: string) => {
    if (!path) return
    setCodeAgentError(null)
    try {
      await client.openPath({ path })
    } catch (err) {
      setCodeAgentError(err instanceof Error ? err.message : String(err))
    }
  }, [client])

  const autoOrganizeAvaBrain = useCallback(() => {
    const api = brainFrameRef.current?.contentWindow as Window & { avaBrain?: { autoOrganize?: () => void } }
    api.avaBrain?.autoOrganize?.()
  }, [])

  const visibleTargets = useMemo(() => targets.filter(target => target.kind === kind), [kind, targets])
  const selected = visibleTargets.find(target => target.id === selectedId) ?? visibleTargets[0] ?? targets[0]
  const selectedState = selected ? tests[selected.id] : undefined

  const changeTestKind = (nextKind: typeof TEST_KINDS[number]) => {
    setKind(nextKind)
    const nextTarget = targets.find(target => target.kind === nextKind)
    if (nextTarget) setSelectedId(nextTarget.id)
  }

  useEffect(() => {
    const element = canvasRef.current
    if (!element) return

    const updateCanvasSize = () => {
      const rect = element.getBoundingClientRect()
      setCanvasSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      })
    }

    updateCanvasSize()
    const observer = new ResizeObserver(updateCanvasSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [kind])

  useEffect(() => {
    if (kind === 'audit') void loadToolAudit()
  }, [kind, loadToolAudit])

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
      try {
        const environment = await devFetch<DevEnvironment>('/environment')
        setDevEnvironment(environment)
        setDevEnvironmentError(null)
      } catch {
        setDevEnvironment({})
        setDevEnvironmentError('Dev Supervisor needs restart. Current backend does not expose /environment.')
      }
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

  const saveDevLayout = useCallback(async (positions: Record<string, NodePosition>) => {
    await devFetch<DevLayout>('/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodePositions: positions }),
    })
  }, [devFetch])

  const loadDevLayout = useCallback(async () => {
    try {
      const layout = await devFetch<DevLayout>('/layout')
      const backendHasLayout = hasSavedNodePositions(layout?.nodePositions)
      const nextPositions = backendHasLayout
        ? normalizeNodePositions(layout.nodePositions)
        : loadLocalNodePositions()
      setNodePositions(nextPositions)
      localStorage.setItem(NODE_POSITIONS_STORAGE_KEY, JSON.stringify(nextPositions))
      layoutLoadedRef.current = true
      if (!backendHasLayout) {
        await saveDevLayout(nextPositions)
      }
    } catch {
      layoutLoadedRef.current = true
    }
  }, [devFetch, saveDevLayout])

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

  const waitForDaemonReady = useCallback(async () => {
    const url = baseUrl.replace(/\/+$/, '')
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${url}/runtime/status`)
        if (response.ok) return true
      } catch {
        // Keep polling while the daemon build/start script is still coming up.
      }
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    return false
  }, [baseUrl])

  const openUnitTestPage = useCallback(async () => {
    setOpenNodeMenuId(null)
    setDevError(null)
    const daemonProcess = devProcesses.find(process => process.id === 'daemon')
    try {
      if (!daemonProcess?.running) {
        setDevBusyId('daemon')
        await devFetch<DevProcess>('/processes/daemon/start', { method: 'POST' })
        await loadDevProcesses()
      }
      const ready = await waitForDaemonReady()
      if (!ready) {
        setDevError('Ava Daemon did not become ready within 30s. Check the daemon logs from the Ava Daemon card.')
        return
      }
      setKind('daemon')
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevBusyId(null)
    }
  }, [devFetch, devProcesses, loadDevProcesses, waitForDaemonReady])

  const writeLog = useCallback((entry: Record<string, unknown>) => {
    void client.appendUnitTestResult(entry).catch(err => {
      console.warn('[daemon-test-ui] failed to write test log:', err)
    })
  }, [client])

  const loadUnitTestTargets = useCallback(async (preferredKind: TargetKind = kind) => {
    localStorage.setItem('ava-daemon-test-url', baseUrl)
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
    const nextTargets = [
      ...makeDaemonTargets(baseUrl),
      ...makeIntentGateTargets(baseUrl),
      ...makeWorkflowDispatcherTargets(baseUrl),
      ...makeCodeAgentDispatcherTargets(baseUrl),
      ...builtIns,
      ...mcp,
      ...skills,
    ]
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
    setSelectedId(current => current || nextTargets.find(target => target.kind === preferredKind)?.id || nextTargets[0]?.id || '')
    return nextTargets
  }, [baseUrl, client, kind])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await loadUnitTestTargets(kind)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [kind, loadUnitTestTargets])

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
    if (kind !== 'dev') return
    void loadCodeAgentSessions()
    const id = window.setInterval(() => void loadCodeAgentSessions(), 5000)
    return () => window.clearInterval(id)
  }, [kind, loadCodeAgentSessions])

  useEffect(() => {
    if (devControlStatus !== 'online') return
    layoutLoadedRef.current = false
    void loadDevLayout()
  }, [devControlStatus, loadDevLayout])

  useEffect(() => {
    if (!layoutLoadedRef.current) return
    localStorage.setItem(NODE_POSITIONS_STORAGE_KEY, JSON.stringify(nodePositions))
    if (devControlStatus !== 'online') return
    if (layoutSaveTimerRef.current !== null) {
      window.clearTimeout(layoutSaveTimerRef.current)
    }
    layoutSaveTimerRef.current = window.setTimeout(() => {
      layoutSaveTimerRef.current = null
      void saveDevLayout(nodePositions)
    }, 350)
    return () => {
      if (layoutSaveTimerRef.current !== null) {
        window.clearTimeout(layoutSaveTimerRef.current)
        layoutSaveTimerRef.current = null
      }
    }
  }, [devControlStatus, nodePositions, saveDevLayout])

  useEffect(() => {
    let disposed = false

    const tick = async () => {
      const wasOnline = devControlStatusRef.current === 'online'
      const isOnline = await checkDevControlHealth()
      if (disposed) return
      if (isOnline && kind === 'dev') void loadDevProcesses()
      if (isOnline && kind !== 'dev' && !wasOnline && devProcesses.length === 0) void loadDevProcesses()
    }

    void tick()
    const id = window.setInterval(() => void tick(), 2500)
    return () => {
      disposed = true
      window.clearInterval(id)
    }
  }, [checkDevControlHealth, devProcesses.length, kind, loadDevProcesses])

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
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: passed ? 'passed' : 'failed', message, durationMs, completedAt: Date.now(), fullContent } }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: passed ? 'passed' : 'failed', message, durationMs, request: requestText, fullContent })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'failed', message, durationMs, completedAt: Date.now(), fullContent } }))
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
      const matchedJson = assertExpectedJson(fullContent, request.expectJson, request.expectJsonOneOf)

      const durationMs = Date.now() - startedAt
      const details = [
        eventTypes.length ? `events: ${eventTypes.join(', ')}` : '',
        matchedJson.length ? `json: ${matchedJson.join(', ')}` : '',
      ].filter(Boolean).join('; ')
      const message = `Passed in ${durationMs}ms${details ? `; ${details}` : ''}`
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'passed', message, durationMs, completedAt: Date.now(), fullContent } }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: 'passed', message, durationMs, request: requestText, fullContent })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'failed', message, durationMs, completedAt: Date.now() } }))
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
        [target.id]: { request: requestText, status: passed ? 'passed' : 'failed', message, lastTool, durationMs, completedAt: Date.now(), fullContent },
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
        [target.id]: { request: requestText, status: 'failed', message, durationMs, completedAt: Date.now(), fullContent },
      }))
      writeLog({ id: target.id, kind: target.kind, name: target.name, status: 'failed', message, durationMs, request: requestText, fullContent })
    }
  }

  const runTarget = async (target: TestTarget) => {
    if (target.kind === 'daemon' || target.kind === 'intent' || target.kind === 'workflow' || target.kind === 'code-agent') await runDaemonTarget(target)
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

  const runAllTestTargets = async () => {
    setAutoTestRunning(true)
    setError(null)
    try {
      await openUnitTestPage()
      const ready = await waitForDaemonReady()
      if (!ready) {
        setError('Ava Daemon did not become ready within 30s. Auto Test stopped.')
        return
      }
      const nextTargets = await loadUnitTestTargets('daemon')
      const allTargets = TEST_KINDS.flatMap(testKind => nextTargets.filter(target => target.kind === testKind))
      setKind('daemon')
      for (const target of allTargets) {
        setSelectedId(target.id)
        await runTarget(target)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAutoTestRunning(false)
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
        id: 'node-runtime',
        ...position('node-runtime'),
        metadata: DEV_NODE_METADATA['node-runtime'],
        feature: {
          label: 'Node Runtime',
          description: 'Local Node.js and npm runtime used by the dev supervisor.',
          status: 'environment',
        },
      },
      {
        id: 'localhost-ports',
        ...position('localhost-ports'),
        metadata: DEV_NODE_METADATA['localhost-ports'],
        feature: {
          label: 'Localhost Ports',
          description: 'Local port availability and service URL detection.',
          status: 'environment',
        },
      },
      {
        id: 'local-llm',
        ...position('local-llm'),
        metadata: DEV_NODE_METADATA['local-llm'],
        feature: {
          label: 'Local LLM Runtime',
          description: 'Local model server used by Ava Daemon for chat, tool routing, and reasoning profiles.',
          status: 'active',
          url: 'http://127.0.0.1:1234/v1',
        },
      },
      {
        id: 'speech-services',
        ...position('speech-services'),
        metadata: DEV_NODE_METADATA['speech-services'],
        feature: {
          label: 'Ava Speech Plugin',
          description: 'One plugin that exposes speech.stt for voice input and speech.tts for spoken responses.',
          status: 'external',
        },
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
        id: 'dev-control-backend',
        ...position('dev-control-backend'),
        metadata: DEV_NODE_METADATA['dev-control-backend'],
        feature: {
          label: 'Ava Dev Supervisor',
          description: 'Local supervisor API for starting and observing Ava dev services.',
          status: devControlStatus === 'online' ? 'managed' : 'unavailable',
          url: devControlUrl,
        },
      },
      {
        id: 'daemon-test-ui',
        ...position('daemon-test-ui'),
        metadata: DEV_NODE_METADATA['daemon-test-ui'],
        process: get('daemon-test-ui'),
      },
    ]
  }, [baseUrl, devControlStatus, devControlUrl, nodePositions, processById])

  const featureDependencyEdges = useMemo(() => dependencyNodes.flatMap(node => (
    node.metadata.dependsOn.map(dependencyId => ({
      id: `${node.id}:${dependencyId}`,
      from: node.id,
      to: dependencyId,
      featureName: `${node.id} depends on ${dependencyId}`,
    }))
  )), [dependencyNodes])
  const pinLines = useMemo<PinLine[]>(() => {
    const nodeById = new Map(dependencyNodes.map(node => [node.id, node]))
    return featureDependencyEdges.flatMap(edge => {
      const sourceNode = nodeById.get(edge.from)
      const targetNode = nodeById.get(edge.to)
      if (!sourceNode || !targetNode) return []
      const sourceSide = sourceNode.x <= targetNode.x ? 'output' : 'input'
      const targetSide = sourceNode.x <= targetNode.x ? 'input' : 'output'
      const source = cardDependencyPinPosition(sourceNode, canvasSize, sourceSide)
      const target = cardDependencyPinPosition(targetNode, canvasSize, targetSide)
      return [{
        id: edge.id,
        featureName: edge.featureName,
        dependencyId: edge.to,
        sourceX: source.x,
        sourceY: source.y,
        targetX: target.x,
        targetY: target.y,
      }]
    })
  }, [canvasSize, dependencyNodes, featureDependencyEdges])
  const visibleCardPins = useMemo(() => {
    const pins = new Set<string>()
    const nodeById = new Map(dependencyNodes.map(node => [node.id, node]))
    for (const edge of featureDependencyEdges) {
      const sourceNode = nodeById.get(edge.from)
      const targetNode = nodeById.get(edge.to)
      if (!sourceNode || !targetNode) continue
      const sourceSide = sourceNode.x <= targetNode.x ? 'output' : 'input'
      const targetSide = sourceNode.x <= targetNode.x ? 'input' : 'output'
      pins.add(`${edge.from}:${sourceSide}`)
      pins.add(`${edge.to}:${targetSide}`)
    }
    return pins
  }, [dependencyNodes, featureDependencyEdges])
  const selectedDevNode = selectedDevNodeId ? dependencyNodes.find(node => node.id === selectedDevNodeId) : undefined
  const selectedDevProcess = selectedDevNode?.process
  const selectedDevStatus = selectedDevNode
    ? displayDevStatus(
      selectedDevNode,
      selectedDevNode.feature?.status ?? selectedDevProcess?.status ?? 'unavailable',
      selectedDevProcess,
    )
    : 'unavailable'
  const testSummariesByKind = useMemo(() => ({
    daemon: summarizeTestTargets(targets.filter(target => target.kind === 'daemon'), tests),
    intent: summarizeTestTargets(targets.filter(target => target.kind === 'intent'), tests),
    workflow: summarizeTestTargets(targets.filter(target => target.kind === 'workflow'), tests),
    'code-agent': summarizeTestTargets(targets.filter(target => target.kind === 'code-agent'), tests),
    'built-in': summarizeTestTargets(targets.filter(target => target.kind === 'built-in'), tests),
    mcp: summarizeTestTargets(targets.filter(target => target.kind === 'mcp'), tests),
    skill: summarizeTestTargets(targets.filter(target => target.kind === 'skill'), tests),
  }), [targets, tests])
  const allTestSummary = useMemo(
    () => summarizeTestTargets(targets.filter(target => target.kind !== 'dev'), tests),
    [targets, tests],
  )

  const testSummaryForFeature = (nodeId: string, featureName: string): TestSummary | null => {
    if (isUnitTestFeature(nodeId, featureName)) return allTestSummary
    return null
  }

  const renderNodeActions = (node: DevDependencyNode, process?: DevProcess) => (
    node.feature
      ? []
      : [
        { label: 'Start', disabled: !process?.available || Boolean(process.running), run: () => { setOpenNodeMenuId(null); void controlDevProcess(node.id, 'start') } },
        { label: 'Stop', disabled: !process?.available || !process.running, run: () => { setOpenNodeMenuId(null); void controlDevProcess(node.id, 'stop') } },
        { label: 'Restart', disabled: !process?.available, run: () => { setOpenNodeMenuId(null); void controlDevProcess(node.id, 'restart') } },
      ]
  )

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

  const handleNodePointerDown = (event: PointerEvent<Element>, nodeId: string) => {
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

  const handleNodePointerMove = (event: PointerEvent<Element>) => {
    if (nodeDragRef.current.pointerId !== event.pointerId) return
    const deltaX = ((event.clientX - nodeDragRef.current.startX) / canvasView.scale / nodeDragRef.current.canvasWidth) * 100
    const deltaY = ((event.clientY - nodeDragRef.current.startY) / canvasView.scale / nodeDragRef.current.canvasHeight) * 100
    const nextPosition = clampNodePosition({
      x: nodeDragRef.current.originX + deltaX,
      y: nodeDragRef.current.originY + deltaY,
    })
    setNodePositions(prev => ({ ...prev, [nodeDragRef.current.nodeId]: nextPosition }))
  }

  const stopNodeDrag = (event: PointerEvent<Element>) => {
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
              <h1>{kind === 'dev' ? 'Ava Dev Control Panel' : kind === 'audit' ? 'Tool Audit Log' : kind === 'brain' ? 'Ava Brain' : 'Unit Test'}</h1>
              <p>
                {kind === 'dev'
                  ? <>Full-page feature orchestration for local Ava development.</>
                  : kind === 'audit'
                    ? <>Recent daemon tool calls for debugging model/tool behavior.</>
                    : kind === 'brain'
                      ? <>User input routing, planning, and daemon workflow map.</>
                      : <>{targetKindLabel(kind)} · CWD: <code>{cwd || '(not loaded)'}</code></>}
              </p>
              {kind !== 'dev' && kind !== 'audit' && kind !== 'brain' && logPath && <p>Log: <code>{logPath}</code></p>}
            </div>
          </div>
          {kind === 'dev' ? (
            <div className="actions">
              <button
                className="top-icon-action"
                title="Auto test all Unit Test items"
                onClick={() => { void runAllTestTargets() }}
                disabled={autoTestRunning || loading}
                aria-label="Auto test all Unit Test items"
              >
                {autoTestRunning ? <RefreshCw size={16} className="spin" /> : <FlaskConical size={16} />}
                <span>Auto Test</span>
              </button>
            </div>
          ) : kind === 'audit' ? (
            <div className="actions">
              <button className="ghost" onClick={() => setKind('dev')}>Back</button>
              <button className="ghost" onClick={loadToolAudit} disabled={auditLoading}>
                <RefreshCw size={14} className={auditLoading ? 'spin' : ''} />
                Refresh
              </button>
              <button className="ghost danger" onClick={clearToolAudit} disabled={auditLoading || auditEntries.length === 0}>
                <Trash2 size={14} />
                Clear
              </button>
            </div>
          ) : kind === 'brain' ? (
            <div className="actions">
              <button className="ghost" onClick={() => setKind('dev')}>Back</button>
              <button className="top-icon-action" onClick={autoOrganizeAvaBrain}>
                Auto organize
              </button>
              <div className="brain-legend-menu">
                <button className="top-icon-action icon-only" title="Color legend" aria-label="Color legend">
                  <HelpCircle size={15} />
                </button>
                <div className="brain-legend-popover">
                  <h2>Color meaning</h2>
                  <div className="brain-legend-list">
                    <div><span className="legend-dot desktop" />Yellow card/tag: Desktop shell or UI-owned state.</div>
                    <div><span className="legend-dot daemon" />Cyan card/tag: Daemon runtime, planner, or intake logic.</div>
                    <div><span className="legend-dot shared" />Violet card/tag: planning or shared execution structure.</div>
                    <div><span className="legend-dot green" />Green label: entry, chat, runtime, or successful gate path.</div>
                    <div><span className="legend-dot red" />Red: cancel, blocked, retry, or stopped path.</div>
                    <div><span className="legend-line-dot blue" />Blue solid line: normal workflow transition.</div>
                    <div><span className="legend-line-dot yellow" />Yellow line: correction, uncertain, or branch path.</div>
                    <div><span className="legend-line-dot pink dashed" />Pink dashed line: prompt sent to selected LLM provider.</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button className="ghost" onClick={() => setKind('dev')}>Back</button>
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
        {kind === 'audit' && auditError && <div className="error-banner">{auditError}</div>}

        {kind === 'dev' ? (
          <section className="dev-panel">
            <div
              className={`dev-canvas ${isCanvasPanning ? 'panning' : ''}`}
              ref={canvasRef}
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
              >
                <svg
                  className="canvas-svg"
                  viewBox={`${-canvasView.x / canvasView.scale} ${-canvasView.y / canvasView.scale} ${canvasSize.width / canvasView.scale} ${canvasSize.height / canvasView.scale}`}
                  preserveAspectRatio="none"
                  aria-label="Ava development feature dependency canvas"
                >
                  <defs>
                    <linearGradient id="blueprintDependencyLine" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#6f7788" />
                      <stop offset="50%" stopColor="#a9b1c1" />
                      <stop offset="100%" stopColor="#687284" />
                    </linearGradient>
                  </defs>
                  <g className="dependency-lines">
                    {pinLines.map(line => {
                    const leftToRight = line.sourceX <= line.targetX
                    const tension = Math.max(90, Math.abs(line.targetX - line.sourceX) * 0.42)
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
                  </g>
                </svg>
                {dependencyNodes.map(node => {
                  const process = node.process
                  const feature = node.feature
                  const status = feature?.status ?? process?.status ?? 'unavailable'
                  const displayStatus = displayDevStatus(node, status, process)
                  const label = feature?.label ?? process?.label ?? node.id
                  const description = feature?.description ?? process?.description ?? 'Not registered.'
                  const url = feature?.url ?? process?.url ?? ''
                  const hasInputDependency = visibleCardPins.has(`${node.id}:input`)
                  const hasOutputDependents = visibleCardPins.has(`${node.id}:output`)
                  const statusText = displayStatus === 'environment'
                      ? 'environment'
                      : displayStatus
                  const actions = renderNodeActions(node, process)

                  return (
                    <article
                      key={node.id}
                      className={`canvas-node type-${node.metadata.type} ${displayStatus} ${draggedNodeId === node.id ? 'dragging' : ''}`}
                      style={nodeScreenStyle(node, canvasSize, canvasView)}
                      onPointerDown={event => handleNodePointerDown(event, node.id)}
                      onPointerMove={handleNodePointerMove}
                      onPointerUp={stopNodeDrag}
                      onPointerCancel={stopNodeDrag}
                    >
                      {hasInputDependency && (
                        <i
                          className="canvas-card-dependency-pin input"
                          style={{ '--pin-color': DEPENDENCY_PIN_COLORS[node.id] ?? '#6bdcff' } as CSSProperties}
                        />
                      )}
                      {hasOutputDependents && (
                        <i
                          className="canvas-card-dependency-pin output"
                          style={{ '--pin-color': DEPENDENCY_PIN_COLORS[node.id] ?? '#6bdcff' } as CSSProperties}
                        />
                      )}
                      <div className="canvas-node-top">
                        <strong>{truncateText(label, 24)}</strong>
                        <div className="canvas-node-badges">
                          <button
                            className="icon-button"
                            title="Information"
                            onPointerDown={event => event.stopPropagation()}
                            onClick={event => {
                              event.stopPropagation()
                              openNodeInfo(node.id)
                            }}
                          >
                            i
                          </button>
                          {actions.length > 0 && (
                            <button
                              className="icon-button"
                              title="Actions"
                              onPointerDown={event => event.stopPropagation()}
                              onClick={event => {
                                event.stopPropagation()
                                setOpenNodeMenuId(current => current === node.id ? null : node.id)
                              }}
                            >
                              •••
                            </button>
                          )}
                          {openNodeMenuId === node.id && actions.length > 0 && (
                            <div className="node-action-menu" onPointerDown={event => event.stopPropagation()}>
                              {actions.map(action => (
                                <button
                                  key={action.label}
                                  disabled={action.disabled}
                                  onClick={event => {
                                    event.stopPropagation()
                                    action.run()
                                  }}
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <p>{description}</p>
                      {url && (
                        <a
                          className="canvas-node-url-link"
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          onPointerDown={event => event.stopPropagation()}
                          onClick={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            openExternalTab(url)
                          }}
                        >
                          {truncateText(url, 36)}
                        </a>
                      )}
                      <div className="node-feature-list">
                        {node.metadata.features.map(item => {
                          const featureSummary = testSummaryForFeature(node.id, item)
                          const isBrainFeature = isAvaBrainFeature(node.id, item)
                          const isTestFeature = isUnitTestFeature(node.id, item)
                          const isAuditFeature = isToolAuditFeature(node.id, item)
                          const isActionFeature = isBrainFeature || isTestFeature || isAuditFeature
                          return (
                            <div className={`node-feature-row ${isActionFeature ? 'actionable' : ''}`} key={item}>
                              {isActionFeature ? (
                                <button
                                  type="button"
                                  className="node-feature-button"
                                  title={isBrainFeature ? 'Open Ava Brain' : isAuditFeature ? 'Open Tool Audit Log' : 'Open Unit Test'}
                                  disabled={isTestFeature && devBusyId === 'daemon'}
                                  onPointerDown={event => event.stopPropagation()}
                                  onClick={event => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    if (isBrainFeature) {
                                      openAvaBrainPage()
                                    } else if (isAuditFeature) {
                                      openToolAuditPage()
                                    } else {
                                      void openUnitTestPage()
                                    }
                                  }}
                                >
                                  {truncateText(item, featureSummary ? 25 : 34)}
                                </button>
                              ) : (
                                <span>{truncateText(item, featureSummary ? 25 : 34)}</span>
                              )}
                              {featureSummary && (
                                <em className={`feature-test-chip ${featureSummary.status}`}>
                                  {featureSummary.label}
                                </em>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <div className="canvas-node-footer">
                        <span className={`pill ${displayStatus}`}>{truncateText(statusText, 13)}</span>
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
                      <span className={`pill ${selectedDevStatus}`}>
                        {selectedDevStatus}
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
                      {selectedDevNode.metadata.dependencies.length > 0 ? (
                        <ul>
                          {selectedDevNode.metadata.dependencies.map(item => <li key={item}>{item}</li>)}
                        </ul>
                      ) : (
                        <p className="empty-dependency-note">None. This is an environment dependency in the Ava dev graph.</p>
                      )}
                    </section>
                  </div>

                  {selectedDevNode.id === 'daemon-test-ui' && (
                    <section className="dev-detail-section dev-test-summary">
                      <h3>Test result</h3>
                      <div className="test-summary-grid">
                        <div><strong>Total</strong><code>{allTestSummary.label}</code></div>
                        <div><strong>Last test time</strong><code>{formatTestTime(allTestSummary.lastCompletedAt)}</code></div>
                      </div>
                      <ul>
                        <li><strong>Daemon</strong><span>{testSummariesByKind.daemon.label}</span></li>
                        <li><strong>Intent Gate</strong><span>{testSummariesByKind.intent.label}</span></li>
                        <li><strong>Workflow</strong><span>{testSummariesByKind.workflow.label}</span></li>
                        <li><strong>Code Agent</strong><span>{testSummariesByKind['code-agent'].label}</span></li>
                        <li><strong>Built-in</strong><span>{testSummariesByKind['built-in'].label}</span></li>
                        <li><strong>MCP</strong><span>{testSummariesByKind.mcp.label}</span></li>
                        <li><strong>Skill</strong><span>{testSummariesByKind.skill.label}</span></li>
                      </ul>
                    </section>
                  )}

                  {selectedDevNode.id === 'daemon' && (
                    <section className="dev-detail-section code-agent-session-panel">
                      <div className="section-title-row">
                        <h3>Code Agent Sessions</h3>
                        <button className="ghost compact" onClick={loadCodeAgentSessions}>Refresh</button>
                      </div>
                      {codeAgentError && <p className="inline-error">{codeAgentError}</p>}
                      {codeAgentSessions.length === 0 ? (
                        <p className="empty-dependency-note">No delegated code-agent sessions yet.</p>
                      ) : (
                        <div className="code-agent-session-list">
                          {codeAgentSessions.slice(0, 8).map(session => {
                            const lastEvent = latestCodeAgentEvent(session)
                            const needsInput = latestCodeAgentInputRequest(session)
                            const busy = codeAgentBusyId === session.sessionId
                            return (
                              <article className={`code-agent-session ${session.status}`} key={session.sessionId}>
                                <div className="code-agent-session-head">
                                  <div>
                                    <strong>{session.selected.agent.name}</strong>
                                    <span>{session.task.taskKind ?? 'unknown'} · {formatTestTime(session.updatedAt)}</span>
                                  </div>
                                  <span className={`pill ${session.status}`}>{session.status}</span>
                                </div>
                                <p>{truncateText(session.task.goal, 160)}</p>
                                {session.task.workingDirectory && <code>{session.task.workingDirectory}</code>}
                                {needsInput && <pre className="code-agent-input-request">{needsInput}</pre>}
                                {lastEvent && <pre className="code-agent-last-event">[{lastEvent.type}] {lastEvent.message}</pre>}
                                <div className="code-agent-session-actions">
                                  <button className="ghost compact" disabled={busy || session.status === 'completed' || session.status === 'running' || session.status === 'starting'} onClick={() => void startCodeAgentSession(session.sessionId)}>Retry</button>
                                  <button className="ghost compact" disabled={busy || session.status === 'completed' || session.status === 'failed' || session.status === 'stopped'} onClick={() => void stopCodeAgentSession(session.sessionId)}>Stop</button>
                                  <button className="ghost compact" disabled={!session.task.workingDirectory} onClick={() => void openCodeAgentCwd(session.task.workingDirectory)}>Open CWD</button>
                                </div>
                                <div className="code-agent-input-row">
                                  <input
                                    value={codeAgentInputById[session.sessionId] ?? ''}
                                    placeholder="Reply to permission/input prompt..."
                                    onChange={event => setCodeAgentInputById(prev => ({ ...prev, [session.sessionId]: event.target.value }))}
                                  />
                                  <button className="primary compact" disabled={busy || !(codeAgentInputById[session.sessionId] ?? '').trim()} onClick={() => void sendCodeAgentInput(session.sessionId)}>Send</button>
                                </div>
                              </article>
                            )
                          })}
                        </div>
                      )}
                    </section>
                  )}

                  {selectedDevProcess ? (
                    <>
                      <div className="dev-meta">
                        <div><strong>Command</strong><code>{selectedDevProcess.command}</code></div>
                        <div><strong>CWD</strong><code>{selectedDevProcess.cwd}</code></div>
                        <div><strong>Ports</strong><code>{selectedDevProcess.ports.join(', ') || '-'}</code></div>
                        <div><strong>PID</strong><code>{selectedDevProcess.pid ?? selectedDevProcess.externalPids?.join(', ') ?? '-'}</code></div>
                        <div><strong>URL</strong><a href={selectedDevProcess.url} target="_blank" rel="noreferrer" onClick={event => { event.preventDefault(); openExternalTab(selectedDevProcess.url) }}>{selectedDevProcess.url}</a></div>
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
                    selectedDevNode.metadata.type === 'environment' ? (
                      <div className="dev-meta">
                        {selectedDevNode.id === 'node-runtime' ? (
                          <>
                            <div><strong>Type</strong><code>Environment / Node runtime</code></div>
                            {devEnvironmentError && <div><strong>Status</strong><code>{devEnvironmentError}</code></div>}
                            <div><strong>Node version</strong><code>{devEnvironment.nodeRuntime?.version ?? '-'}</code></div>
                            <div><strong>Node path</strong><code>{devEnvironment.nodeRuntime?.execPath ?? '-'}</code></div>
                            <div><strong>NPM command</strong><code>{devEnvironment.nodeRuntime?.npmCommand ?? '-'}</code></div>
                            <div><strong>Platform</strong><code>{devEnvironment.nodeRuntime ? `${devEnvironment.nodeRuntime.platform} / ${devEnvironment.nodeRuntime.arch}` : '-'}</code></div>
                          </>
                        ) : (
                          <>
                            <div><strong>Type</strong><code>Environment / Local network</code></div>
                            {devEnvironmentError && <div><strong>Status</strong><code>{devEnvironmentError}</code></div>}
                            <div><strong>Host</strong><code>{devEnvironment.localhostPorts?.host ?? '-'}</code></div>
                            <div><strong>Dev supervisor port</strong><code>{devEnvironment.localhostPorts?.devControlPort ?? '-'}</code></div>
                            <div><strong>Known ports</strong><code>{devEnvironment.localhostPorts?.knownPorts.join(', ') || '-'}</code></div>
                          </>
                        )}
                      </div>
                    ) : selectedDevNode.id === 'dev-control-backend' ? (
                      <>
                        <div className="dev-meta">
                          <div><strong>Type</strong><code>{selectedDevNode.metadata.type}</code></div>
                          <div><strong>URL</strong><a href={selectedDevNode.feature?.url ?? devControlUrl} target="_blank" rel="noreferrer" onClick={event => { event.preventDefault(); openExternalTab(selectedDevNode.feature?.url ?? devControlUrl) }}>{selectedDevNode.feature?.url ?? devControlUrl}</a></div>
                        </div>
                        <section className="dev-detail-section dev-process-list">
                          <h3>Processes</h3>
                          <ul>
                            {devProcesses.map(process => (
                              <li key={process.id}>
                                <strong>{process.label}</strong>
                                <span>{process.status}</span>
                                <code>{process.ports.join(', ') || '-'}</code>
                              </li>
                            ))}
                          </ul>
                        </section>
                      </>
                    ) : (
                      <div className="dev-meta">
                        <div><strong>Type</strong><code>{selectedDevNode.metadata.type}</code></div>
                        {selectedDevNode.feature?.url && <div><strong>URL</strong><a href={selectedDevNode.feature.url} target="_blank" rel="noreferrer" onClick={event => { event.preventDefault(); openExternalTab(selectedDevNode.feature?.url ?? '') }}>{selectedDevNode.feature.url}</a></div>}
                      </div>
                    )
                  )}

                  {selectedDevNode.id === 'daemon-test-ui' && (
                    <div className="dev-actions">
                      <button className="primary" disabled={devBusyId === 'daemon'} onClick={() => { setSelectedDevNodeId(null); void openUnitTestPage() }}>Open Unit Test</button>
                      <button className="primary" onClick={openAvaBrainPage}>Open Ava Brain</button>
                      <button className="primary" onClick={() => { setSelectedDevNodeId(null); openToolAuditPage() }}>Open Tool Audit</button>
                    </div>
                  )}
                </article>
              </div>
            )}
          </section>
        ) : kind === 'brain' ? (
          <section className="brain-page">
            <iframe
              ref={brainFrameRef}
              title="Ava Brain"
              src={embeddedAvaBrainUrl(devControlUrl)}
              className="brain-frame"
            />
          </section>
        ) : kind === 'audit' ? (
          <section className="audit-page">
            <div className="audit-toolbar">
              <div>
                <h2>Recent Tool Calls</h2>
                <p>Shows the latest 100 daemon tool calls, including provider, model, args, result preview, and errors.</p>
              </div>
              <div className="audit-count">
                <ClipboardList size={16} />
                {auditLoading ? 'Loading...' : `${auditEntries.length} entries`}
              </div>
            </div>
            {auditEntries.length === 0 ? (
              <div className="empty audit-empty">
                {auditLoading ? 'Loading tool audit log...' : 'No tool call records yet.'}
              </div>
            ) : (
              <div className="audit-list">
                {auditEntries.map(entry => {
                  const expanded = expandedAuditId === entry.id
                  return (
                    <article key={entry.id} className={`audit-entry ${entry.status}`}>
                      <button
                        type="button"
                        className="audit-entry-head"
                        onClick={() => setExpandedAuditId(expanded ? null : entry.id)}
                      >
                        <span className={`audit-status ${entry.status}`}>{entry.status}</span>
                        <strong>{entry.toolName}</strong>
                        <span>{new Date(entry.createdAt).toLocaleString()}</span>
                        <span>{entry.providerName} / {entry.model}</span>
                        <code>{entry.durationMs}ms</code>
                      </button>
                      {expanded && (
                        <div className="audit-entry-detail">
                          <div><strong>Task</strong><code>{entry.taskId ?? '(none)'}</code></div>
                          <div><strong>Stream</strong><code>{entry.streamId}</code></div>
                          <div><strong>Tool call</strong><code>{entry.toolCallId}</code></div>
                          {entry.serverId && <div><strong>Server</strong><code>{entry.serverId}</code></div>}
                          {entry.pluginId && <div><strong>Plugin</strong><code>{entry.pluginId}</code></div>}
                          {entry.commandInvocation && (
                            <div><strong>Command</strong><code>{entry.commandInvocation.pluginName}/{entry.commandInvocation.commandName}</code></div>
                          )}
                          <section>
                            <h3>Args</h3>
                            <pre>{prettyJson(entry.args)}</pre>
                          </section>
                          {entry.error && (
                            <section>
                              <h3>Error</h3>
                              <pre className="error-text">{entry.error}</pre>
                            </section>
                          )}
                          {entry.resultPreview && (
                            <section>
                              <h3>Result preview</h3>
                              <pre>{entry.resultPreview}</pre>
                            </section>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        ) : (
          <section className="content">
          <div className="target-list">
            <label className="test-category-picker">
              <span>Test category</span>
              <select value={kind} onChange={event => changeTestKind(event.target.value as typeof TEST_KINDS[number])}>
                {TEST_KINDS.map(item => (
                  <option key={item} value={item}>
                    {targetKindLabel(item)} ({targets.filter(target => target.kind === item).length})
                  </option>
                ))}
              </select>
            </label>
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
