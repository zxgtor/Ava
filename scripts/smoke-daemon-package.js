const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-daemon-package-'))
const packDir = path.join(tmp, 'pack')
const installDir = path.join(tmp, 'install')
fs.mkdirSync(packDir, { recursive: true })
fs.mkdirSync(installDir, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit ${result.status}`,
      result.error ? String(result.error.stack ?? result.error.message ?? result.error) : '',
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout.trim()
}

function npmCliPath() {
  const fromEnv = process.env.npm_execpath
  if (fromEnv && fromEnv.endsWith('.js')) return fromEnv
  return require.resolve('npm/bin/npm-cli.js')
}

function nodeBin(name) {
  return process.platform === 'win32'
    ? path.join(installDir, 'node_modules', '.bin', `${name}.cmd`)
    : path.join(installDir, 'node_modules', '.bin', name)
}

function installedDaemonEntry() {
  return path.join(installDir, 'node_modules', '@ava', 'daemon', 'dist', 'ava-daemon.cjs')
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Keep polling until the daemon is ready.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function readSse(url) {
  const response = await fetch(url)
  assert.equal(response.ok, true)
  const text = await response.text()
  assert.match(text, /chat\.run\.completed/)
}

function readWs(url) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws')
    const ws = new WebSocket(url)
    let terminal = false
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('WebSocket smoke timed out'))
    }, 5_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        runId: 'package-smoke-ws',
        messages: [{ role: 'user', content: 'package smoke' }],
      }))
    })
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString())
      if (event.type === 'chat.run.completed' || event.type === 'chat.run.failed') terminal = true
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (terminal) resolve()
      else reject(new Error('WebSocket closed before a terminal chat event'))
    })
    ws.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function main() {
  const packJson = run(process.execPath, [npmCliPath(), 'pack', '--workspace=@ava/daemon', '--pack-destination', packDir, '--json'])
  const packed = JSON.parse(packJson)
  const tarball = path.join(packDir, packed[0].filename)
  assert.equal(fs.existsSync(tarball), true)

  run(process.execPath, [npmCliPath(), 'init', '-y'], { cwd: installDir })
  run(process.execPath, [npmCliPath(), 'install', tarball, '--omit=dev'], { cwd: installDir })
  assert.equal(fs.existsSync(nodeBin('ava-daemon')), true)
  assert.equal(fs.existsSync(installedDaemonEntry()), true)

  const port = String(18_900 + Math.floor(Math.random() * 500))
  const userData = path.join(tmp, 'user-data')
  const daemon = spawn(process.execPath, [installedDaemonEntry()], {
    cwd: installDir,
    env: {
      ...process.env,
      AVA_DAEMON_HOST: '127.0.0.1',
      AVA_DAEMON_PORT: port,
      AVA_USER_DATA_DIR: userData,
      AVA_PROJECT_ROOT: installDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  daemon.stdout.on('data', chunk => { stdout += chunk.toString() })
  daemon.stderr.on('data', chunk => { stderr += chunk.toString() })

  try {
    const base = `http://127.0.0.1:${port}`
    const status = await waitForJson(`${base}/runtime/status`, 15_000)
    assert.equal(status.ok, true)
    assert.equal(status.service, 'ava-daemon')
    assert.equal(status.runtimeAttached, true)

    await readSse(`${base}/chat/stream?message=package%20smoke`)
    await readWs(`ws://127.0.0.1:${port}/chat/ws`)
    console.log('daemon package smoke test passed')
  } finally {
    daemon.kill()
    await new Promise(resolve => daemon.once('exit', resolve))
    if (stderr.trim()) process.stderr.write(stderr)
    if (!stdout.includes('runtime listening')) process.stdout.write(stdout)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
