import http from 'node:http'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 17871
const startedAt = Date.now()

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(payload)
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

function routeRequest(req, res) {
  if (req.method === 'OPTIONS') {
    jsonResponse(res, 204, {})
    return
  }

  if (req.method !== 'GET') {
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
    jsonResponse(res, 200, {
      ok: true,
      servers: [],
      runtimeAttached: false,
      note: 'MCP supervisor still runs inside Electron main until the runtime migration step.',
    })
    return
  }

  jsonResponse(res, 404, { ok: false, error: 'not_found', path: url.pathname })
}

export function startDaemonServer(options = {}) {
  const host = options.host ?? process.env.AVA_DAEMON_HOST ?? DEFAULT_HOST
  const port = Number(options.port ?? process.env.AVA_DAEMON_PORT ?? DEFAULT_PORT)
  const server = http.createServer(routeRequest)

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
