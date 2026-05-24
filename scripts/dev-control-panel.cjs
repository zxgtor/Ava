/* eslint-disable no-console */
const http = require('node:http')
const { spawn } = require('node:child_process')

const children = new Set()
let shuttingDown = false

function npmSpawnCommand(args) {
  const npmCli = process.env.npm_execpath
  const nodeExe = process.env.npm_node_execpath
  if (npmCli && nodeExe) {
    return {
      command: nodeExe,
      args: [npmCli, ...args],
      shell: false,
    }
  }

  if (process.platform === 'win32') {
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

function spawnChild(label, args) {
  const spawnCommand = npmSpawnCommand(args)
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
    shell: spawnCommand.shell,
  })

  children.add(child)

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown) return

    console.log(`[${label}] exited`, signal ? `via ${signal}` : `with code ${code ?? 0}`)
    shuttingDown = true
    stopAll()
    process.exit(code ?? 0)
  })

  return child
}

function isReachable(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(750, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function stopAll() {
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
}

process.on('SIGINT', () => {
  stopAll()
  process.exit(130)
})

process.on('SIGTERM', () => {
  stopAll()
  process.exit(143)
})

async function main() {
  console.log('[dev] starting Ava Dev Control Panel')
  if (await isReachable('http://127.0.0.1:17872/health')) {
    console.log('[dev] reusing existing dev-control at http://127.0.0.1:17872')
  } else {
    spawnChild('dev-control', ['run', 'dev-control'])
  }
  if (await isReachable('http://127.0.0.1:5179')) {
    console.log('[dev] reusing existing Ava Dev Control Panel at http://127.0.0.1:5179')
  } else {
    spawnChild('dev-control-panel', ['run', 'dev:panel'])
  }
}

main().catch(error => {
  console.error('[dev] failed to start', error)
  stopAll()
  process.exit(1)
})
