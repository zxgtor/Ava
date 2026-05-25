import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { daemonBaseUrl } from './daemonChatClient'
import { runtimePaths } from '../../../daemon/src/services/runtimePaths'

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

function daemonSpawnCommand(): { command: string; args: string[]; shell: boolean } {
  const npmCli = process.env.npm_execpath
  const nodeExe = process.env.npm_node_execpath
  if (npmCli && nodeExe) {
    return {
      command: nodeExe,
      args: [npmCli, 'run', 'daemon:runtime'],
      shell: false,
    }
  }

  return {
    command: process.platform === 'win32' ? 'cmd.exe' : npmCommand(),
    args: process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run daemon:runtime']
      : ['run', 'daemon:runtime'],
    shell: false,
  }
}

function isMonorepoRoot(dir: string): boolean {
  const packagePath = join(dir, 'package.json')
  if (!existsSync(packagePath) || !existsSync(join(dir, 'apps', 'daemon', 'package.json'))) return false
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { workspaces?: unknown }
    return Array.isArray(pkg.workspaces) || Boolean(pkg.workspaces && typeof pkg.workspaces === 'object')
  } catch {
    return false
  }
}

function findMonorepoRoot(start: string): string | null {
  let dir = resolve(start)
  while (true) {
    if (isMonorepoRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function daemonProjectRoot(): string {
  const paths = runtimePaths()
  const candidates = [
    process.env.AVA_PROJECT_ROOT,
    paths.projectRoot,
    paths.appPath,
    process.cwd(),
    __dirname,
  ].filter((item): item is string => Boolean(item))

  for (const candidate of candidates) {
    const root = findMonorepoRoot(candidate)
    if (root) return root
  }

  return paths.projectRoot
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
    const projectRoot = daemonProjectRoot()
    const daemonCommand = daemonSpawnCommand()
    daemonProcess = spawn(daemonCommand.command, daemonCommand.args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        AVA_PROJECT_ROOT: projectRoot,
      },
      shell: daemonCommand.shell,
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

    waitForRuntime(45_000).then(resolve, reject)
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
