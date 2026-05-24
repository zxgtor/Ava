const { spawn } = require('node:child_process')

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = new Set()
let shuttingDown = false

function spawnChild(label, args) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  })

  children.add(child)

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown) return

    shuttingDown = true

    if (signal) console.log(`[${label}] exited via ${signal}`)
    else if (code && code !== 0) console.error(`[${label}] exited with code ${code}`)
    else console.log(`[${label}] exited`)

    stopAll()
    process.exit(code ?? 0)
  })

  return child
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

spawnChild('daemon', ['run', 'daemon:runtime'])
spawnChild('shell', ['start'])
