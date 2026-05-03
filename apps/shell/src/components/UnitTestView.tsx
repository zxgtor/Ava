import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FlaskConical, Play, RefreshCw, XCircle } from 'lucide-react'
import { useStore } from '../store'

type TargetKind = 'built-in' | 'mcp' | 'skill'
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

const PREVIEW_TEST_URL = 'http://127.0.0.1:47831/'

function defaultBuiltInRequest(toolName: string, cwd: string): string {
  const testDir = `${cwd}\\.ava-unit-test`
  const testFile = `${testDir}\\tool-write.txt`
  const patchFile = `${testDir}\\patch-target.txt`
  const screenshotPath = `${testDir}\\preview.png`
  const nodeServerScript = `require('http').createServer(function(q,r){r.end('ava unit test')}).listen(47831,'127.0.0.1',function(){console.log('${PREVIEW_TEST_URL}')})`

  const requests: Record<string, string> = {
    'shell.run_command': `Call shell.run_command exactly once to run node with args ["-e","console.log('ava shell ok')"] in cwd "${cwd}".`,
    'file.read_text': `Call file.read_text exactly once to read "${cwd}\\package.json".`,
    'file.write_text': `Call file.write_text exactly once to write "${testFile}" with content "ava unit test write ok".`,
    'file.list_dir': `Call file.list_dir exactly once to list "${cwd}".`,
    'file.create_dir': `Call file.create_dir exactly once to create "${testDir}\\created-dir".`,
    'file.stat': `Call file.stat exactly once for "${cwd}\\package.json".`,
    'file.patch': `First call file.write_text to create "${patchFile}" with content "before patch". Then call file.patch exactly once on "${patchFile}" replacing "before" with "after".`,
    'project.detect': `Call project.detect exactly once with cwd "${cwd}".`,
    'project.map': `Call project.map exactly once with cwd "${cwd}" and maxDepth 2.`,
    'project.validate': `Call project.validate exactly once with cwd "${cwd}" and level "quick".`,
    'search.ripgrep': `Call search.ripgrep exactly once in cwd "${cwd}" to search for "ava" with maxResults 5.`,
    'git.status': `Call git.status exactly once with cwd "${cwd}".`,
    'git.diff': `Call git.diff exactly once with cwd "${cwd}".`,
    'devserver.start': `Call devserver.start exactly once with cwd "${cwd}", command "node", args ["-e","${nodeServerScript}"], and expectedUrl "${PREVIEW_TEST_URL}".`,
    'devserver.status': `Call devserver.status exactly once with cwd "${cwd}".`,
    'devserver.stop': `First call devserver.start with cwd "${cwd}", command "node", args ["-e","${nodeServerScript}"], and expectedUrl "${PREVIEW_TEST_URL}". Then call devserver.stop exactly once for cwd "${cwd}".`,
    'preview.open': `First call devserver.start with cwd "${cwd}", command "node", args ["-e","${nodeServerScript}"], and expectedUrl "${PREVIEW_TEST_URL}". Then call preview.open exactly once for "${PREVIEW_TEST_URL}".`,
    'preview.console': `First call devserver.start with cwd "${cwd}", command "node", args ["-e","${nodeServerScript}"], and expectedUrl "${PREVIEW_TEST_URL}". Then call preview.console exactly once for "${PREVIEW_TEST_URL}" with waitMs 300.`,
    'preview.screenshot': `First call devserver.start with cwd "${cwd}", command "node", args ["-e","${nodeServerScript}"], and expectedUrl "${PREVIEW_TEST_URL}". Then call preview.screenshot exactly once for "${PREVIEW_TEST_URL}" and save to "${screenshotPath}".`,
  }

  return requests[toolName] ?? `Call ${toolName} exactly once with safe minimal arguments for cwd "${cwd}".`
}

function makeMcpRequest(toolName: string, schema: unknown): string {
  return [
    `Call MCP tool ${toolName} exactly once.`,
    'Use the input schema to choose the smallest safe valid arguments.',
    'If required arguments are unknown, choose harmless placeholder values and let the tool return its real validation result.',
    `Schema: ${JSON.stringify(schema ?? {})}`,
  ].join('\n')
}

function makeSkillRequest(skillName: string, pluginName: string): string {
  return `Use enabled skill "${skillName}" from plugin "${pluginName}" and answer with one concise sentence describing what this skill is for.`
}

function statusIcon(status: TestStatus) {
  if (status === 'passed') return <CheckCircle2 size={15} className="text-success" />
  if (status === 'failed') return <XCircle size={15} className="text-error" />
  if (status === 'running') return <RefreshCw size={15} className="animate-spin text-accent" />
  return <FlaskConical size={15} className="text-text-3" />
}

export function UnitTestView() {
  const { state, activeConversation } = useStore()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [devCwd, setDevCwd] = useState('')
  const [targets, setTargets] = useState<TestTarget[]>([])
  const [kind, setKind] = useState<TargetKind>('built-in')
  const [selectedId, setSelectedId] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})

  const cwd = activeConversation?.folderPath || devCwd
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

      const nextCwd = activeConversation?.folderPath || context.cwd
      setDevCwd(context.cwd)
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
      const nextTargets = [...builtIns, ...mcp, ...skills]
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
  }, [activeConversation?.folderPath, kind, state.settings.pluginStates])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const firstForKind = targets.find(target => target.kind === kind)
    if (firstForKind && selected?.kind !== kind) setSelectedId(firstForKind.id)
  }, [kind, selected?.kind, targets])

  const updateRequest = (id: string, request: string) => {
    setTests(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? { status: 'idle' as const, request }), request, status: 'idle' },
    }))
  }

  const runTarget = async (target: TestTarget) => {
    const providers = state.settings.modelProviders.filter(provider => provider.enabled)
    if (providers.length === 0) {
      setTests(prev => ({ ...prev, [target.id]: { ...(prev[target.id] ?? { request: target.defaultRequest }), status: 'failed', message: 'No enabled LLM provider.' } }))
      return
    }
    if (!cwd) {
      setTests(prev => ({ ...prev, [target.id]: { ...(prev[target.id] ?? { request: target.defaultRequest }), status: 'failed', message: 'No test cwd available.' } }))
      return
    }

    const request = tests[target.id]?.request || target.defaultRequest
    const startedAt = Date.now()
    const streamId = `ut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const parts: any[] = []
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
      const failedCall = toolParts.find(part => part.status === 'error' || part.status === 'aborted')
      const passed =
        target.kind === 'skill'
          ? Boolean(reply.result.fullContent.trim()) && !reply.result.stopReason
          : targetCalls.some(part => part.status === 'ok') && !failedCall && !reply.result.stopReason

      setTests(prev => ({
        ...prev,
        [target.id]: {
          request,
          status: passed ? 'passed' : 'failed',
          message: passed
            ? `Passed in ${Date.now() - startedAt}ms`
            : failedCall?.error || reply.result.stopReason || `Target tool was not called successfully. Calls: ${toolParts.map(part => `${part.name}:${part.status}`).join(', ') || 'none'}`,
          lastTool: toolParts.map(part => `${part.name}:${part.status}`).join(', '),
          durationMs: Date.now() - startedAt,
        },
      }))
    } catch (err) {
      setTests(prev => ({
        ...prev,
        [target.id]: {
          request,
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        },
      }))
    } finally {
      offPart()
      offUpdate()
    }
  }

  const runVisibleTargets = async () => {
    for (const target of visibleTargets) {
      await runTarget(target)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text">Unit Test</h1>
            <p className="mt-1 text-xs text-text-3">
              Dev-only LLM tool-call tests. CWD: <span className="font-mono text-text-2">{cwd || '(none)'}</span>
            </p>
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

      <div className="grid flex-1 min-h-0 grid-cols-[280px_1fr]">
        <div className="min-h-0 border-r border-border-subtle">
          <div className="flex gap-1 border-b border-border-subtle p-2">
            {(['built-in', 'mcp', 'skill'] as TargetKind[]).map(item => (
              <button
                key={item}
                onClick={() => setKind(item)}
                className={`flex-1 rounded px-2 py-1.5 text-xs capitalize ${kind === item ? 'bg-white/[0.08] text-text' : 'text-text-3 hover:bg-white/[0.04]'}`}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="h-full min-h-0 overflow-y-auto p-2">
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

        <div className="min-h-0 overflow-y-auto p-6">
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
