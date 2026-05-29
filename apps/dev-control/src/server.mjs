import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const HOST = process.env.AVA_DEV_CONTROL_HOST || '127.0.0.1'
const PORT = Number(process.env.AVA_DEV_CONTROL_PORT || 17872)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const STATE_DIR = resolve(ROOT, '.ava-dev-control')
const LAYOUT_PATH = resolve(STATE_DIR, 'layout.json')
const IS_WIN = process.platform === 'win32'
const NPM = IS_WIN ? 'npm.cmd' : 'npm'
const MAX_LOG_LINES = 500

const targets = [
  {
    id: 'ava-desktop',
    label: 'Ava Desktop',
    description: 'Electron desktop shell.',
    command: NPM,
    args: ['run', 'dev', '--workspace=@ava/shell'],
    cwd: ROOT,
    ports: [5173, 5174, 5175],
    url: 'http://127.0.0.1:5173',
    available: true,
  },
  {
    id: 'daemon',
    label: 'Ava Daemon',
    description: 'Node daemon runtime API.',
    command: NPM,
    args: ['run', 'daemon:runtime'],
    cwd: ROOT,
    ports: [17871],
    url: 'http://127.0.0.1:17871/runtime/status',
    available: true,
  },
  {
    id: 'daemon-test-ui',
    label: 'Ava Dev Control Panel',
    description: 'Browser control panel and daemon test UI.',
    command: NPM,
    args: ['run', 'dev:panel'],
    cwd: ROOT,
    ports: [5179],
    url: 'http://127.0.0.1:5179',
    available: true,
  },
  {
    id: 'web-ui',
    label: 'Ava Web UI',
    description: 'Browser chat client for Ava daemon.',
    command: NPM,
    args: ['run', 'dev', '--workspace=@ava/web'],
    cwd: ROOT,
    ports: [5180],
    url: 'http://127.0.0.1:5180',
    available: existsSync(resolve(ROOT, 'apps', 'web', 'package.json')),
  },
]

const managed = new Map()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(text))
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })
  })
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeNodePositions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [id, position] of Object.entries(value)) {
    if (!position || typeof position !== 'object' || Array.isArray(position)) continue
    const x = numberOrNull(position.x)
    const y = numberOrNull(position.y)
    if (x === null || y === null) continue
    result[id] = { x, y }
  }
  return result
}

function readLayout() {
  if (!existsSync(LAYOUT_PATH)) return { nodePositions: {}, updatedAt: null }
  try {
    const raw = readFileSync(LAYOUT_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      nodePositions: normalizeNodePositions(parsed.nodePositions),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return { nodePositions: {}, updatedAt: null }
  }
}

function writeLayout(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body.nodePositions : {}
  const layout = {
    nodePositions: normalizeNodePositions(source),
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(LAYOUT_PATH, `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
  return layout
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    ...corsHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(body, null, 2))
}

function empty(res, statusCode) {
  res.writeHead(statusCode, corsHeaders)
  res.end()
}

function targetById(id) {
  return targets.find(target => target.id === id)
}

function npmSpawnCommand(args) {
  const npmCli = process.env.npm_execpath
  const nodeExe = process.env.npm_node_execpath || process.execPath
  if (npmCli && nodeExe) {
    return {
      command: nodeExe,
      args: [npmCli, ...args],
      shell: false,
    }
  }

  if (IS_WIN) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
      shell: false,
    }
  }

  return {
    command: 'npm',
    args,
    shell: false,
  }
}

function spawnCommandForTarget(target) {
  if (target.command === NPM) return npmSpawnCommand(target.args)
  return { command: target.command, args: target.args, shell: false }
}

function appendLog(entry, stream, chunk) {
  const text = String(chunk)
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    entry.logs.push({
      time: new Date().toISOString(),
      stream,
      line,
    })
  }
  if (entry.logs.length > MAX_LOG_LINES) {
    entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES)
  }
}

function pidsOnPorts(ports) {
  if (!ports.length) return []
  if (IS_WIN) {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || ''
    const result = new Set()
    for (const line of out.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue
      for (const port of ports) {
        const re = new RegExp(`[:.]${port}\\s+.*\\s+(\\d+)\\s*$`)
        const match = line.match(re)
        if (match) result.add(Number(match[1]))
      }
    }
    return [...result].filter(Number.isFinite)
  }

  const out = spawnSync('sh', ['-c', `lsof -tiTCP:${ports.join(',')} -sTCP:LISTEN || true`], { encoding: 'utf8' }).stdout || ''
  return out.split(/\s+/).map(Number).filter(Number.isFinite)
}

function killPidTree(pid) {
  if (!pid || !Number.isFinite(pid)) return
  if (IS_WIN) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

function managedEntry(targetId) {
  const entry = managed.get(targetId)
  if (!entry) return null
  if (entry.exitedAt) return entry
  if (entry.child.killed) {
    entry.exitedAt = Date.now()
    return entry
  }
  return entry
}

function processState(target) {
  const entry = managedEntry(target.id)
  const portPids = pidsOnPorts(target.ports)
  const running = Boolean(entry && !entry.exitedAt) || portPids.length > 0
  const status = !target.available
    ? 'unavailable'
    : entry && !entry.exitedAt
      ? 'managed'
      : portPids.length > 0
        ? 'external'
        : 'stopped'

  return {
    id: target.id,
    label: target.label,
    description: target.description,
    command: `${target.command} ${target.args.join(' ')}`,
    cwd: target.cwd,
    ports: target.ports,
    url: target.url,
    available: target.available,
    running,
    status,
    pid: entry && !entry.exitedAt ? entry.child.pid : undefined,
    externalPids: portPids,
    startedAt: entry?.startedAt,
    exitedAt: entry?.exitedAt,
    exitCode: entry?.exitCode,
    signal: entry?.signal,
    logLines: entry?.logs.length ?? 0,
  }
}

async function startTarget(target) {
  if (!target.available) {
    throw new Error(`Target "${target.id}" is not available in this workspace.`)
  }
  const state = processState(target)
  if (state.running) return state

  const spawnCommand = spawnCommandForTarget(target)
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: target.cwd,
    env: process.env,
    detached: !IS_WIN,
    windowsHide: true,
    shell: spawnCommand.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const entry = {
    child,
    startedAt: Date.now(),
    exitedAt: undefined,
    exitCode: undefined,
    signal: undefined,
    logs: [],
  }
  managed.set(target.id, entry)
  appendLog(entry, 'system', `started ${target.command} ${target.args.join(' ')}`)

  child.stdout?.on('data', chunk => appendLog(entry, 'stdout', chunk))
  child.stderr?.on('data', chunk => appendLog(entry, 'stderr', chunk))
  child.on('exit', (code, signal) => {
    entry.exitedAt = Date.now()
    entry.exitCode = code
    entry.signal = signal
    appendLog(entry, 'system', `exited code=${code ?? ''} signal=${signal ?? ''}`)
  })
  child.on('error', error => {
    entry.exitedAt = Date.now()
    entry.exitCode = 1
    appendLog(entry, 'stderr', error.message)
  })

  return processState(target)
}

async function stopTarget(target) {
  const entry = managedEntry(target.id)
  if (entry && !entry.exitedAt) {
    appendLog(entry, 'system', 'stop requested')
    killPidTree(entry.child.pid)
  }

  for (const pid of pidsOnPorts(target.ports)) {
    if (pid === process.pid) continue
    killPidTree(pid)
  }

  await new Promise(resolve => setTimeout(resolve, 250))
  return processState(target)
}

async function restartTarget(target) {
  await stopTarget(target)
  await new Promise(resolve => setTimeout(resolve, 500))
  return startTarget(target)
}

function logsFor(targetId, limit = 200) {
  const entry = managed.get(targetId)
  if (!entry) return []
  return entry.logs.slice(-limit)
}

function environmentState() {
  return {
    nodeRuntime: {
      kind: 'runtime',
      version: process.version,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      npmCommand: NPM,
    },
    localhostPorts: {
      kind: 'network',
      host: HOST,
      devControlPort: PORT,
      knownPorts: Array.from(new Set(targets.flatMap(target => target.ports))).sort((a, b) => a - b),
    },
  }
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    empty(res, 204)
    return
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        service: 'ava-dev-control',
        pid: process.pid,
        cwd: ROOT,
      })
      return
    }

    if (url.pathname === '/processes' && req.method === 'GET') {
      json(res, 200, { ok: true, result: targets.map(processState) })
      return
    }

    if (url.pathname === '/environment' && req.method === 'GET') {
      json(res, 200, { ok: true, result: environmentState() })
      return
    }

    if (url.pathname === '/layout' && req.method === 'GET') {
      json(res, 200, { ok: true, result: readLayout() })
      return
    }

    if (url.pathname === '/layout' && req.method === 'POST') {
      const body = await readJsonBody(req)
      json(res, 200, { ok: true, result: writeLayout(body) })
      return
    }

    const actionMatch = url.pathname.match(/^\/processes\/([^/]+)\/(start|stop|restart|logs)$/)
    if (actionMatch) {
      const [, targetId, action] = actionMatch
      const target = targetById(targetId)
      if (!target) {
        json(res, 404, { ok: false, error: `Unknown target "${targetId}".` })
        return
      }

      if (action === 'logs' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 200)
        json(res, 200, { ok: true, result: logsFor(targetId, Number.isFinite(limit) ? limit : 200) })
        return
      }

      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'Method not allowed.' })
        return
      }

      const result =
        action === 'start' ? await startTarget(target)
          : action === 'stop' ? await stopTarget(target)
            : await restartTarget(target)
      json(res, 200, { ok: true, result })
      return
    }

    json(res, 404, { ok: false, error: 'Not found.' })
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res)
})

server.listen(PORT, HOST, () => {
  console.log(`[ava-dev-control] listening on http://${HOST}:${PORT}`)
  console.log(`[ava-dev-control] workspace root ${ROOT}`)
})

async function shutdown(signal) {
  console.log(`[ava-dev-control] received ${signal}; stopping managed processes`)
  for (const target of targets) {
    const entry = managedEntry(target.id)
    if (entry && !entry.exitedAt) killPidTree(entry.child.pid)
  }
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
