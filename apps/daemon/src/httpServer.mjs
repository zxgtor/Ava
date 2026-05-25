import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 17871
const MAX_JSON_BODY_BYTES = 1024 * 1024
const startedAt = Date.now()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(statusCode, {
    ...corsHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(payload)
}

async function runtimeJsonResponse(res, runtime, methodName, args = []) {
  if (!runtime || typeof runtime[methodName] !== 'function') {
    jsonResponse(res, 503, {
      ok: false,
      error: `Runtime service "${methodName}" is not attached.`,
      runtimeAttached: Boolean(runtime),
    })
    return
  }

  try {
    const result = await runtime[methodName](...args)
    jsonResponse(res, 200, { ok: true, result })
  } catch (error) {
    jsonResponse(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function emptyResponse(res, statusCode) {
  res.writeHead(statusCode, corsHeaders)
  res.end()
}

function writeSseEvent(res, event) {
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function writeWsEvent(ws, event) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event))
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    let body = ''

    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new Error('request_body_too_large'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('invalid_json_body'))
      }
    })
    req.on('error', reject)
  })
}

function getRuntimeStatus(runtimeAttached = false) {
  return {
    ok: true,
    service: 'ava-daemon',
    version: '0.0.1',
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    runtimeAttached,
  }
}

function getLastUserText(messages) {
  const lastUserMessage = Array.isArray(messages)
    ? messages.findLast((message) => message?.role === 'user')
    : undefined

  if (!lastUserMessage) return ''
  if (typeof lastUserMessage.content === 'string') return lastUserMessage.content
  if (!Array.isArray(lastUserMessage.content)) return ''

  return lastUserMessage.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function streamMockChatResponse(res, request = {}) {
  const runId = typeof request.runId === 'string' && request.runId.trim()
    ? request.runId
    : randomUUID()
  const timestamp = new Date().toISOString()
  const userText = getLastUserText(request.messages)
  const preview = userText ? ` Request preview: ${userText.slice(0, 120)}` : ''
  const content = `Daemon chat stream is reachable. Runtime migration is not attached yet.${preview}`

  res.writeHead(200, {
    ...corsHeaders,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })

  writeSseEvent(res, {
    type: 'chat.run.started',
    runId,
    phase: 'running',
    timestamp,
    runtimeAttached: false,
  })

  writeSseEvent(res, {
    type: 'chat.message.delta',
    runId,
    delta: content,
  })

  writeSseEvent(res, {
    type: 'chat.message.completed',
    runId,
    message: {
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
    },
  })

  writeSseEvent(res, {
    type: 'chat.run.completed',
    runId,
    phase: 'completed',
    timestamp: new Date().toISOString(),
  })

  res.end()
}

async function streamRuntimeChatResponse(res, request, runtime) {
  let terminalEventSent = false

  res.writeHead(200, {
    ...corsHeaders,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })

  const emit = (event) => {
    if (event?.type === 'chat.run.completed' || event?.type === 'chat.run.failed') {
      terminalEventSent = true
    }
    writeSseEvent(res, event)
  }

  try {
    await runtime.streamChat(request, emit)
    if (!terminalEventSent) {
      emit({
        type: 'chat.run.completed',
        runId: typeof request.runId === 'string' ? request.runId : randomUUID(),
        phase: 'completed',
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    emit({
      type: 'chat.run.failed',
      runId: typeof request.runId === 'string' ? request.runId : randomUUID(),
      phase: 'failed',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    res.end()
  }
}

async function streamRuntimeChatWebSocket(ws, request, runtime) {
  let terminalEventSent = false
  const runId = typeof request?.runId === 'string' ? request.runId : randomUUID()

  const emit = (event) => {
    if (event?.type === 'chat.run.completed' || event?.type === 'chat.run.failed') {
      terminalEventSent = true
    }
    writeWsEvent(ws, event)
  }

  try {
    if (runtime?.streamChat) {
      await runtime.streamChat(request, emit)
      if (!terminalEventSent) {
        emit({
          type: 'chat.run.completed',
          runId,
          phase: 'completed',
          timestamp: new Date().toISOString(),
        })
      }
    } else {
      const timestamp = new Date().toISOString()
      const userText = getLastUserText(request?.messages)
      const preview = userText ? ` Request preview: ${userText.slice(0, 120)}` : ''
      const content = `Daemon chat WebSocket is reachable. Runtime migration is not attached yet.${preview}`
      emit({
        type: 'chat.run.started',
        runId,
        phase: 'running',
        timestamp,
        runtimeAttached: false,
      })
      emit({
        type: 'chat.message.delta',
        runId,
        delta: content,
      })
      emit({
        type: 'chat.message.completed',
        runId,
        message: {
          role: 'assistant',
          content,
          createdAt: new Date().toISOString(),
        },
      })
      emit({
        type: 'chat.run.completed',
        runId,
        phase: 'completed',
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    emit({
      type: 'chat.run.failed',
      runId,
      phase: 'failed',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    ws.close()
  }
}

async function routeRequest(req, res, runtime) {
  if (req.method === 'OPTIONS') {
    emptyResponse(res, 204)
    return
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`)

  if (url.pathname === '/health') {
    jsonResponse(res, 200, getRuntimeStatus(Boolean(runtime)))
    return
  }

  if (url.pathname === '/runtime/status') {
    jsonResponse(res, 200, getRuntimeStatus(Boolean(runtime)))
    return
  }

  if (url.pathname === '/mcp/servers') {
    if (req.method !== 'GET') {
      jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }

    if (runtime?.listMcpServers) {
      await runtimeJsonResponse(res, runtime, 'listMcpServers')
      return
    }

    jsonResponse(res, 200, { ok: true, result: [] })
    return
  }

  if (url.pathname === '/mcp/restart' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'restartMcpServer', [body?.serverId])
    return
  }

  if (url.pathname === '/settings/load' && req.method === 'GET') {
    await runtimeJsonResponse(res, runtime, 'loadSettings')
    return
  }

  if (url.pathname === '/settings/save' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'saveSettings', [Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body])
    return
  }

  if (url.pathname === '/tasks/analyze' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'analyzeTask', [body])
    return
  }

  if (url.pathname === '/tasks/plan' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'planTask', [body])
    return
  }

  if (url.pathname === '/plugins/list' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'listPlugins', [body?.states])
    return
  }

  if (url.pathname === '/plugins/list-commands' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'listPluginCommands', [body?.states])
    return
  }

  if (url.pathname === '/plugins/marketplace' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'getMarketplaceCatalog', [body?.states, body?.options])
    return
  }

  if (url.pathname === '/plugins/install-git' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'installPluginFromGit', [body?.url])
    return
  }

  if (url.pathname === '/plugins/install-folder' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'installPluginFromFolder', [body?.path])
    return
  }

  if (url.pathname === '/plugins/install-zip' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'installPluginFromZip', [body?.path])
    return
  }

  if (url.pathname === '/plugins/uninstall' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'uninstallPlugin', [body?.pluginId])
    return
  }

  if (url.pathname === '/plugins/update' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'updatePlugin', [body?.pluginId])
    return
  }

  if (url.pathname === '/tool-audit/list' && req.method === 'GET') {
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
    await runtimeJsonResponse(res, runtime, 'listToolAudit', [Number.isFinite(limit) ? limit : undefined])
    return
  }

  if (url.pathname === '/tool-audit/clear' && req.method === 'POST') {
    await runtimeJsonResponse(res, runtime, 'clearToolAudit')
    return
  }

  if (url.pathname === '/dev/unit-test-context' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'unitTestContext', [body?.states])
    return
  }

  if (url.pathname === '/dev/unit-test-results/append' && req.method === 'POST') {
    const body = await readJsonBody(req)
    await runtimeJsonResponse(res, runtime, 'appendUnitTestResult', [body?.entry])
    return
  }

  if (url.pathname === '/dev/unit-test-results/read' && req.method === 'GET') {
    await runtimeJsonResponse(res, runtime, 'readUnitTestResults')
    return
  }

  if (url.pathname === '/dev/unit-test-results/clear' && req.method === 'POST') {
    await runtimeJsonResponse(res, runtime, 'clearUnitTestResults')
    return
  }

  if (url.pathname === '/chat/stream') {
    if (req.method === 'GET') {
      streamMockChatResponse(res, {
        messages: [
          {
            role: 'user',
            content: url.searchParams.get('message') ?? '',
          },
        ],
      })
      return
    }

    try {
      const request = await readJsonBody(req)
      if (runtime?.streamChat) {
        await streamRuntimeChatResponse(res, request, runtime)
      } else {
        streamMockChatResponse(res, request)
      }
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : 'invalid_request',
      })
    }
    return
  }

  jsonResponse(res, 404, { ok: false, error: 'not_found', path: url.pathname })
}

export function startDaemonServer(options = {}) {
  const host = options.host ?? process.env.AVA_DAEMON_HOST ?? DEFAULT_HOST
  const port = Number(options.port ?? process.env.AVA_DAEMON_PORT ?? DEFAULT_PORT)
  const runtime = options.runtime ?? null
  const server = http.createServer((req, res) => {
    routeRequest(req, res, runtime).catch((error) => {
      if (res.headersSent) {
        res.destroy(error)
        return
      }

      jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'internal_error',
      })
    })
  })
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`)
    if (url.pathname !== '/chat/ws') {
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    ws.once('message', (raw) => {
      try {
        const request = JSON.parse(raw.toString())
        void streamRuntimeChatWebSocket(ws, request, runtime)
      } catch (error) {
        writeWsEvent(ws, {
          type: 'chat.run.failed',
          runId: randomUUID(),
          phase: 'failed',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'invalid_json_body',
        })
        ws.close()
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve({
        host,
        port,
        server,
        url: `http://${host}:${port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          wss.close()
          server.close((error) => {
            if (error) closeReject(error)
            else closeResolve()
          })
        }),
      })
    })
  })
}
