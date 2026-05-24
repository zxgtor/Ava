import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FlaskConical, Play, RefreshCw, XCircle } from 'lucide-react'
import { useStore } from '../store'
import type { UnitTestSection } from '../types'

type TargetKind = UnitTestSection
type TestStatus = 'idle' | 'running' | 'passed' | 'failed'

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
  status: TestStatus
  message?: string
  lastTool?: string
  durationMs?: number
}

interface UnitTestLogEntry {
  id: string
  kind: TargetKind
  name: string
  status: 'passed' | 'failed'
  message?: string
  durationMs?: number
  request?: string
  toolCalls?: Array<{
    name?: string
    status?: string
    error?: string
    args?: Record<string, unknown>
  }>
  stopReason?: string
  fullContent?: string
}

interface LlmPreflightResult {
  ok: boolean
  error?: string
}

interface DaemonTestRequest {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
  expectEventTypes?: string[]
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
  const devserverStartCall = `<tool_call>${JSON.stringify({
    name: 'devserver.start',
    arguments: { cwd, command: 'node', args: ['-e', nodeServerScript], expectedUrl: previewUrl },
  })}</tool_call>`
  const previewCall = (name: string, args: Record<string, unknown>) =>
    `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`

  const requests: Record<string, string> = {
    'shell.run_command': `Call shell.run_command exactly once to run node with args ["-e","console.log('ava shell ok')"] in cwd "${cwd}".`,
    'file.read_text': `Call file.read_text exactly once to read "${cwd}\\package.json".`,
    'file.write_text': `Call file.write_text exactly once to write "${testFile}" with content "ava unit test write ok".`,
    'file.list_dir': `Call file.list_dir exactly once to list "${cwd}".`,
    'file.create_dir': `Call file.create_dir exactly once to create "${testDir}\\created-dir".`,
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

  const type = record.type
  if (type === 'string') return 'ava-unit-test'
  if (type === 'number' || type === 'integer') return 1
  if (type === 'boolean') return true
  if (type === 'array') return []
  if (type === 'object' || record.properties) {
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
  return [
    `Call MCP tool ${toolName} exactly once.`,
    `Use exactly these JSON arguments: ${JSON.stringify(args)}.`,
    'Do not call any other tool.',
    'If the tool returns a validation or business error, report that result briefly.',
  ].join('\n')
}

function makeSkillRequest(skillName: string, pluginName: string): string {
  return `Use enabled skill "${skillName}" from plugin "${pluginName}" and answer with one concise sentence describing what this skill is for.`
}

function makeDaemonTargets(baseUrl: string, chatRuntimeEnabled: boolean): TestTarget[] {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const request = (value: DaemonTestRequest) => JSON.stringify(value, null, 2)
  return [
    {
      id: 'daemon:health',
      kind: 'daemon',
      name: 'daemon.health',
      label: 'daemon.health',
      meta: normalizedBaseUrl,
      description: 'GET /health should return ok=true and service=ava-daemon.',
      defaultRequest: request({ method: 'GET', url: `${normalizedBaseUrl}/health` }),
    },
    {
      id: 'daemon:runtime-status',
      kind: 'daemon',
      name: 'daemon.runtime.status',
      label: 'daemon.runtime.status',
      meta: normalizedBaseUrl,
      description: 'GET /runtime/status should return daemon process/runtime status.',
      defaultRequest: request({ method: 'GET', url: `${normalizedBaseUrl}/runtime/status` }),
    },
    {
      id: 'daemon:mcp-servers',
      kind: 'daemon',
      name: 'daemon.mcp.servers',
      label: 'daemon.mcp.servers',
      meta: normalizedBaseUrl,
      description: 'GET /mcp/servers should return a valid daemon response, even before MCP is migrated.',
      defaultRequest: request({ method: 'GET', url: `${normalizedBaseUrl}/mcp/servers` }),
    },
    {
      id: 'daemon:chat-stream',
      kind: 'daemon',
      name: 'daemon.chat.stream',
      label: 'daemon.chat.stream',
      meta: chatRuntimeEnabled ? 'seam enabled' : 'seam disabled',
      description: 'POST /chat/stream should return a complete SSE event sequence.',
      defaultRequest: request({
        method: 'POST',
        url: `${normalizedBaseUrl}/chat/stream`,
        body: {
          messages: [
            { role: 'user', content: 'hello daemon unit test' },
          ],
        },
        expectEventTypes: [
          'chat.run.started',
          'chat.message.delta',
          'chat.message.completed',
          'chat.run.completed',
        ],
      }),
    },
  ]
}

function parseDaemonRequest(text: string): DaemonTestRequest {
  const parsed = JSON.parse(text) as DaemonTestRequest
  if (parsed.method !== 'GET' && parsed.method !== 'POST') {
    throw new Error('Daemon request method must be GET or POST.')
  }
  if (!parsed.url || typeof parsed.url !== 'string') {
    throw new Error('Daemon request url is required.')
  }
  return parsed
}

function parseSseEventTypes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.startsWith('event:'))
    .map(line => line.slice('event:'.length).trim())
}

function statusIcon(status: TestStatus) {
  if (status === 'passed') return <CheckCircle2 size={15} className="text-success" />
  if (status === 'failed') return <XCircle size={15} className="text-error" />
  if (status === 'running') return <RefreshCw size={15} className="animate-spin text-accent" />
  return <FlaskConical size={15} className="text-text-3" />
}

export function UnitTestView() {
  const { state } = useStore()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [devCwd, setDevCwd] = useState('')
  const [logPath, setLogPath] = useState('')
  const [targets, setTargets] = useState<TestTarget[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const targetRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const kind = state.unitTestSection
  const cwd = devCwd
  const selected = targets.find(target => target.id === selectedId) ?? targets[0]
  const visibleTargets = useMemo(() => targets.filter(target => target.kind === kind), [kind, targets])
  const selectedState = selected ? tests[selected.id] : undefined

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const context = await window.ava.dev.unitTestContext(state.settings.pluginStates)
      if (!context.isDev) {
        setError('Unit Test page is only available in dev mode.')
        return
      }

      const nextCwd = context.cwd
      setDevCwd(context.cwd)
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
      const daemon = makeDaemonTargets(
        context.daemon?.baseUrl ?? 'http://127.0.0.1:17871',
        Boolean(context.daemon?.chatRuntimeEnabled),
      )
      const nextTargets = [...builtIns, ...mcp, ...skills, ...daemon]
      setTargets(nextTargets)
      setTests(prev => {
        const next = { ...prev }
        for (const target of nextTargets) {
          if (!next[target.id]) next[target.id] = { request: target.defaultRequest, status: 'idle' }
        }
        return next
      })
      setSelectedId(current => current || nextTargets.find(target => target.kind === kind)?.id || nextTargets[0]?.id || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [kind, state.settings.pluginStates])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const firstForKind = targets.find(target => target.kind === kind)
    if (firstForKind && selected?.kind !== kind) setSelectedId(firstForKind.id)
  }, [kind, selected?.kind, targets])

  useEffect(() => {
    if (!selectedId) return
    targetRefs.current[selectedId]?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const updateRequest = (id: string, request: string) => {
    setTests(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? { status: 'idle' as const, request }), request, status: 'idle' },
    }))
  }

  const checkLlmAvailable = useCallback(async (): Promise<LlmPreflightResult> => {
    const providers = state.settings.modelProviders.filter(provider => provider.enabled)
    if (providers.length === 0) {
      return { ok: false, error: 'No enabled LLM provider. Enable a provider in Settings before running Unit Test.' }
    }

    const errors: string[] = []
    for (const provider of providers) {
      if (!provider.baseUrl) {
        errors.push(`${provider.name}: missing baseUrl`)
        continue
      }
      try {
        const result = await window.ava.llm.probe({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          providerId: provider.id,
        })
        if (result.ok) return { ok: true }
        errors.push(`${provider.name}: ${result.error}`)
      } catch (err) {
        errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return {
      ok: false,
      error: [
        'LLM server unavailable. Start LM Studio / Ollama / provider server, then run Unit Test again.',
        errors.length ? `Provider check: ${errors.join('; ')}` : '',
      ].filter(Boolean).join(' '),
    }
  }, [state.settings.modelProviders])

  const markTargetsWaitingForLlm = (items: TestTarget[], message: string) => {
    setTests(prev => {
      const next = { ...prev }
      for (const target of items) {
        const request = next[target.id]?.request || target.defaultRequest
        next[target.id] = { ...next[target.id], request, status: 'idle', message }
      }
      return next
    })
  }

  const writeLog = (entry: UnitTestLogEntry) => {
    try {
      const devApi = window.ava.dev as typeof window.ava.dev & {
        appendUnitTestResult?: (entry: UnitTestLogEntry) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
      }
      if (typeof devApi.appendUnitTestResult !== 'function') {
        console.warn('[unit-test] log API unavailable; restart Ava to enable persistent logs')
        return
      }
      devApi.appendUnitTestResult(entry).catch(err => {
        console.warn('[unit-test] failed to write log:', err)
      })
    } catch (err) {
      console.warn('[unit-test] failed to schedule log write:', err)
    }
  }

  const runDaemonTarget = async (target: TestTarget) => {
    const requestText = tests[target.id]?.request || target.defaultRequest
    const startedAt = Date.now()
    setTests(prev => ({ ...prev, [target.id]: { request: requestText, status: 'running', message: 'Calling daemon...' } }))

    try {
      const request = parseDaemonRequest(requestText)
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.method === 'POST'
          ? { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json, text/event-stream' },
        body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
      })
      const text = await response.text()
      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      let passed = true
      let message = `Passed in ${durationMs}ms`
      let fullContent = text

      if (contentType.includes('text/event-stream')) {
        const eventTypes = parseSseEventTypes(text)
        const missing = (request.expectEventTypes ?? []).filter(type => !eventTypes.includes(type))
        passed = missing.length === 0
        message = passed
          ? `Passed in ${durationMs}ms; events: ${eventTypes.join(', ')}`
          : `Missing SSE events: ${missing.join(', ')}`
      } else {
        const json = JSON.parse(text) as { ok?: boolean; service?: string; runtimeAttached?: boolean }
        passed = json.ok === true
        message = passed
          ? `Passed in ${durationMs}ms; ok=true${json.runtimeAttached === false ? '; runtimeAttached=false' : ''}`
          : `Daemon returned ok=false: ${text.slice(0, 300)}`
        fullContent = JSON.stringify(json, null, 2)
      }

      setTests(prev => ({
        ...prev,
        [target.id]: {
          request: requestText,
          status: passed ? 'passed' : 'failed',
          message,
          durationMs,
          lastTool: target.name,
        },
      }))
      writeLog({
        id: target.id,
        kind: target.kind,
        name: target.name,
        status: passed ? 'passed' : 'failed',
        message,
        durationMs,
        request: requestText,
        fullContent,
      })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({
        ...prev,
        [target.id]: {
          request: requestText,
          status: 'failed',
          message,
          durationMs,
        },
      }))
      writeLog({
        id: target.id,
        kind: target.kind,
        name: target.name,
        status: 'failed',
        message,
        durationMs,
        request: requestText,
      })
    }
  }

  const runTarget = async (target: TestTarget, options: { skipPreflight?: boolean } = {}) => {
    if (target.kind === 'daemon') {
      await runDaemonTarget(target)
      return
    }

    const request = tests[target.id]?.request || target.defaultRequest
    const startedAt = Date.now()
    const streamId = `ut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const parts: any[] = []

    const failBeforeStream = (message: string) => {
      const durationMs = Date.now() - startedAt
      setTests(prev => ({ ...prev, [target.id]: { request, status: 'failed', message, durationMs } }))
      writeLog({
        id: target.id,
        kind: target.kind,
        name: target.name,
        status: 'failed',
        message,
        durationMs,
        request,
      })
    }

    const providers = state.settings.modelProviders.filter(provider => provider.enabled)
    if (providers.length === 0) {
      failBeforeStream('No enabled LLM provider.')
      return
    }
    if (!cwd) {
      failBeforeStream('No test cwd available.')
      return
    }
    if (!options.skipPreflight) {
      const preflight = await checkLlmAvailable()
      if (!preflight.ok) {
        failBeforeStream(preflight.error ?? 'LLM server unavailable.')
        return
      }
    }

    setTests(prev => ({ ...prev, [target.id]: { request, status: 'running', message: 'Waiting for LLM/tool result...' } }))

    const offPart = window.ava.llm.onPart(({ streamId: id, partIndex, part }) => {
      if (id !== streamId) return
      parts[partIndex] = part
    })
    const offUpdate = window.ava.llm.onPartUpdate(({ streamId: id, partIndex, patch }) => {
      if (id !== streamId) return
      parts[partIndex] = { ...(parts[partIndex] ?? {}), ...patch }
    })

    try {
      const reply = await window.ava.llm.stream({
        streamId,
        activeFolderPath: cwd,
        providers: state.settings.modelProviders,
        toolFormatMap: state.settings.modelToolFormatMap,
        pluginStates: state.settings.pluginStates,
        temperature: 0,
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
          {
            role: 'user',
            content: request,
          },
        ],
      })

      if (!reply.ok) throw new Error(reply.error)
      const toolParts = parts.filter(part => part?.type === 'tool_call')
      const targetCalls = toolParts.filter(part => part.name === target.name)
      const targetFailedCall = targetCalls.find(part => part.status === 'error' || part.status === 'aborted')
      const targetOkCall = targetCalls.find(part => part.status === 'ok')
      const targetReachedCall = targetCalls.find(part => part.status === 'ok' || part.status === 'error')
      const passed =
        target.kind === 'skill'
          ? Boolean(reply.result.fullContent.trim()) && !reply.result.stopReason
        : target.kind === 'mcp'
            ? Boolean(targetReachedCall)
            : Boolean(targetOkCall)
      const durationMs = Date.now() - startedAt
      const message = passed
        ? target.kind === 'mcp' && targetFailedCall
          ? `Reached MCP tool in ${durationMs}ms; tool returned error: ${targetFailedCall.error ?? 'tool error'}`
          : reply.result.stopReason
            ? `Passed in ${durationMs}ms; target tool was reached before stopReason: ${reply.result.stopReason}`
            : targetFailedCall
              ? `Passed in ${durationMs}ms; target tool succeeded before later retry error: ${targetFailedCall.error ?? 'tool error'}`
          : `Passed in ${durationMs}ms`
        : targetFailedCall?.error || reply.result.stopReason || `Target tool was not called successfully. Calls: ${toolParts.map(part => `${part.name}:${part.status}`).join(', ') || 'none'}`
      const lastTool = toolParts.map(part => `${part.name}:${part.status}`).join(', ')

      setTests(prev => ({
        ...prev,
        [target.id]: {
          request,
          status: passed ? 'passed' : 'failed',
          message,
          lastTool,
          durationMs,
        },
      }))
      writeLog({
        id: target.id,
        kind: target.kind,
        name: target.name,
        status: passed ? 'passed' : 'failed',
        message,
        durationMs,
        request,
        toolCalls: toolParts.map(part => ({
          name: part.name,
          status: part.status,
          error: part.error,
          args: part.args,
        })),
        stopReason: reply.result.stopReason,
        fullContent: reply.result.fullContent,
      })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      setTests(prev => ({
        ...prev,
        [target.id]: {
          request,
          status: 'failed',
          message,
          durationMs,
        },
      }))
      writeLog({
        id: target.id,
        kind: target.kind,
        name: target.name,
        status: 'failed',
        message,
        durationMs,
        request,
      })
    } finally {
      offPart()
      offUpdate()
    }
  }

  const runVisibleTargets = async () => {
    setError(null)
    if (kind === 'daemon') {
      for (const target of visibleTargets) {
        setSelectedId(target.id)
        await runDaemonTarget(target)
      }
      return
    }

    const preflight = await checkLlmAvailable()
    if (!preflight.ok) {
      const message = preflight.error ?? 'LLM server unavailable.'
      setError(message)
      markTargetsWaitingForLlm(visibleTargets, message)
      return
    }

    for (const target of visibleTargets) {
      setSelectedId(target.id)
      try {
        await runTarget(target, { skipPreflight: true })
      } catch (err) {
        const request = tests[target.id]?.request || target.defaultRequest
        setTests(prev => ({
          ...prev,
          [target.id]: {
            request,
            status: 'failed',
            message: err instanceof Error ? err.message : String(err),
          },
        }))
      }
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text">Unit Test</h1>
            <p className="mt-1 text-xs text-text-3">
              Dev-only LLM tool-call tests. CWD: <span className="font-mono text-text-2">{cwd || '(none)'}</span>
            </p>
            {logPath && (
              <p className="mt-1 text-xs text-text-3">
                Log: <span className="font-mono text-text-2">{logPath}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-2 hover:bg-white/[0.04]">
              Refresh
            </button>
            <button onClick={runVisibleTargets} disabled={loading || visibleTargets.length === 0} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
              Run {kind}
            </button>
          </div>
        </div>
        {error && <div className="mt-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{error}</div>}
      </div>

      <div className="grid flex-1 min-h-0 overflow-hidden grid-cols-[280px_1fr]">
        <div className="flex min-h-0 flex-col border-r border-border-subtle">
          <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-10">
            {loading ? (
              <div className="p-4 text-xs text-text-3">Loading...</div>
            ) : visibleTargets.length === 0 ? (
              <div className="p-4 text-xs text-text-3">No {kind} targets found.</div>
            ) : (
              visibleTargets.map(target => {
                const row = tests[target.id]
                return (
                  <button
                    key={target.id}
                    ref={node => { targetRefs.current[target.id] = node }}
                    onClick={() => setSelectedId(target.id)}
                    className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                      selected?.id === target.id ? 'bg-white/[0.08] text-text' : 'text-text-2 hover:bg-white/[0.04] hover:text-text'
                    }`}
                  >
                    {statusIcon(row?.status ?? 'idle')}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{target.label}</span>
                      {target.meta && <span className="block truncate text-[10px] text-text-3">{target.meta}</span>}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto p-6 pb-12">
          {selected ? (
            <div className="max-w-4xl space-y-4">
              <div className="rounded-xl border border-border-subtle bg-surface/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-text">
                      {statusIcon(selectedState?.status ?? 'idle')}
                      {selected.label}
                    </div>
                    {selected.description && <p className="mt-1 text-xs text-text-3">{selected.description}</p>}
                  </div>
                  <button
                    onClick={() => runTarget(selected)}
                    disabled={selectedState?.status === 'running'}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    <Play size={13} />
                    Run
                  </button>
                </div>
                {selectedState?.message && (
                  <div className={`mt-3 rounded-md px-3 py-2 text-xs ${
                    selectedState.status === 'passed'
                      ? 'bg-success/10 text-success'
                      : selectedState.status === 'failed'
                        ? 'bg-error/10 text-error'
                        : 'bg-white/[0.04] text-text-2'
                  }`}>
                    {selectedState.message}
                  </div>
                )}
                {selectedState?.lastTool && (
                  <div className="mt-2 text-xs text-text-3">Tool calls: {selectedState.lastTool}</div>
                )}
              </div>

              <label className="block">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-3">LLM Request</div>
                <textarea
                  value={selectedState?.request ?? selected.defaultRequest}
                  onChange={event => updateRequest(selected.id, event.target.value)}
                  className="min-h-[180px] w-full resize-y rounded-xl border border-border-subtle bg-black/20 p-3 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent/50"
                />
              </label>

              {selected.inputSchema !== undefined && (
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-3">Input Schema</div>
                  <pre className="max-h-[260px] overflow-auto rounded-xl border border-border-subtle bg-black/20 p-3 text-xs text-text-2">
                    {JSON.stringify(selected.inputSchema, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-text-3">No test target selected.</div>
          )}
        </div>
      </div>
    </div>
  )
}
