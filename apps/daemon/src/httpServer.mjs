import http from 'node:http'
import { randomUUID } from 'node:crypto'

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

function emptyResponse(res, statusCode) {
  res.writeHead(statusCode, corsHeaders)
  res.end()
}

function writeSseEvent(res, event) {
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
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

function getRuntimeStatus() {
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
    runtimeAttached: false,
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

async function routeRequest(req, res) {
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
    jsonResponse(res, 200, getRuntimeStatus())
    return
  }

  if (url.pathname === '/runtime/status') {
    jsonResponse(res, 200, getRuntimeStatus())
    return
  }

  if (url.pathname === '/mcp/servers') {
    if (req.method !== 'GET') {
      jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }

    jsonResponse(res, 200, {
      ok: true,
      servers: [],
      runtimeAttached: false,
      note: 'MCP supervisor still runs inside Electron main until the runtime migration step.',
    })
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
      streamMockChatResponse(res, request)
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
  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch((error) => {
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
          server.close((error) => {
            if (error) closeReject(error)
            else closeResolve()
          })
        }),
      })
    })
  })
}
