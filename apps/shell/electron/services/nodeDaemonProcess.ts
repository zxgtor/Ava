import { spawn, type ChildProcess } from 'node:child_process'
import { daemonBaseUrl } from './daemonChatClient'

let daemonProcess: ChildProcess | null = null
let startPromise: Promise<void> | null = null

async function runtimeAttached(): Promise<boolean> {
  try {
    const response = await fetch(`${daemonBaseUrl()}/runtime/status`)
    if (!response.ok) return false
    const payload = await response.json() as { runtimeAttached?: unknown }
    return payload.runtimeAttached === true
  } catch {
    return false
  }
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

async function waitForRuntime(timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await runtimeAttached()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Node daemon did not become ready at ${daemonBaseUrl()} within ${timeoutMs}ms.`)
}

export async function ensureNodeDaemonRuntime(): Promise<void> {
  if (await runtimeAttached()) return
  if (startPromise) return startPromise

  startPromise = new Promise<void>((resolve, reject) => {
    daemonProcess = spawn(npmCommand(), ['run', 'daemon:runtime'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AVA_PROJECT_ROOT: process.cwd(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    daemonProcess.stdout?.on('data', chunk => {
      process.stdout.write(`[daemon] ${chunk}`)
    })
    daemonProcess.stderr?.on('data', chunk => {
      process.stderr.write(`[daemon] ${chunk}`)
    })
    daemonProcess.once('exit', (code, signal) => {
      daemonProcess = null
      if (code && code !== 0) {
        console.warn(`[daemon] node runtime exited with code ${code}`)
      } else if (signal) {
        console.warn(`[daemon] node runtime exited via ${signal}`)
      }
    })

    waitForRuntime(15_000).then(resolve, reject)
  }).finally(() => {
    startPromise = null
  })

  return startPromise
}

export async function stopNodeDaemonRuntime(): Promise<void> {
  const child = daemonProcess
  daemonProcess = null
  if (!child || child.killed) return
  child.kill()
}

