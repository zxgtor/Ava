import { execFile } from 'node:child_process'

export type CodeAgentId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'openclaw'

export interface CodeAgentInstallCommand {
  packageName: string
  label: string
}

export interface CodeAgentProbeResult {
  id: CodeAgentId
  name: string
  command: string
  status: 'ready' | 'missing' | 'error'
  version?: string
  error?: string
  install?: CodeAgentInstallCommand
  checkedAt: number
}

export interface CodeAgentInstallResult {
  id: CodeAgentId
  name: string
  command: string
  args: string[]
  stdout: string
  stderr: string
  checkedAt: number
}

interface CodeAgentCandidate {
  id: CodeAgentId
  name: string
  command: string
  versionArgs: string[]
  packageName: string
}

const CODE_AGENT_CANDIDATES: CodeAgentCandidate[] = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude', versionArgs: ['--version'], packageName: '@anthropic-ai/claude-code' },
  { id: 'codex', name: 'OpenAI Codex', command: 'codex', versionArgs: ['--version'], packageName: '@openai/codex' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', versionArgs: ['--version'], packageName: '@google/gemini-cli' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', versionArgs: ['--version'], packageName: 'opencode-ai' },
  { id: 'openclaw', name: 'OpenClaw', command: 'openclaw', versionArgs: ['--version'], packageName: 'openclaw' },
]

export async function probeCodeAgents(): Promise<CodeAgentProbeResult[]> {
  return Promise.all(CODE_AGENT_CANDIDATES.map(probeCodeAgent))
}

export async function installCodeAgent(agentId: unknown): Promise<CodeAgentInstallResult> {
  if (typeof agentId !== 'string') throw new Error('agentId is required.')
  const candidate = CODE_AGENT_CANDIDATES.find(item => item.id === agentId)
  if (!candidate) throw new Error(`Unsupported code agent: ${agentId}`)
  const command = npmInstallCommand()
  const args = npmInstallArgs(candidate.packageName)
  const output = await execInstall(command, args)
  return {
    id: candidate.id,
    name: candidate.name,
    command,
    args,
    stdout: output.stdout.trim(),
    stderr: output.stderr.trim(),
    checkedAt: Date.now(),
  }
}

async function probeCodeAgent(candidate: CodeAgentCandidate): Promise<CodeAgentProbeResult> {
  const checkedAt = Date.now()
  const install = installCommandFor(candidate)
  try {
    const output = await execVersionWithFallback(candidate.command, candidate.versionArgs)
    return {
      id: candidate.id,
      name: candidate.name,
      command: candidate.command,
      status: 'ready',
      version: firstMeaningfulLine(output) ?? 'detected',
      install,
      checkedAt,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    const message = summarizeProbeError(err)
    return {
      id: candidate.id,
      name: candidate.name,
      command: candidate.command,
      status: code === 'ENOENT' ? 'missing' : 'error',
      error: code === 'ENOENT' ? `${candidate.command} not found on PATH` : message,
      install,
      checkedAt,
    }
  }
}

async function execVersionWithFallback(command: string, args: string[]): Promise<string> {
  try {
    return await execVersion(command, args)
  } catch (err) {
    if (process.platform !== 'win32') throw err
    return execVersionViaPowerShell(command, args)
  }
}

function execVersion(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`.trim())
    })
    child.stdin?.end()
  })
}

function execVersionViaPowerShell(command: string, args: string[]): Promise<string> {
  const quotedArgs = args.map(arg => `'${arg.replace(/'/g, "''")}'`).join(' ')
  const script = [
    `$cmd = (Get-Command '${command.replace(/'/g, "''")}' -ErrorAction Stop).Source`,
    `& $cmd ${quotedArgs}`,
  ].join('; ')
  return execVersionNoShell('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

function execVersionNoShell(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`.trim())
    })
    child.stdin?.end()
  })
}

function execInstall(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = summarizeProbeError(error)
        reject(new Error(message))
        return
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
    })
    child.stdin?.end()
  })
}

function installCommandFor(candidate: CodeAgentCandidate): CodeAgentInstallCommand {
  return {
    packageName: candidate.packageName,
    label: `npm install -g ${candidate.packageName}`,
  }
}

function npmInstallCommand(): string {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) return process.execPath
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npmInstallArgs(packageName: string): string[] {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) return [npmExecPath, 'install', '-g', packageName]
  return ['install', '-g', packageName]
}

function firstMeaningfulLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
}

function summarizeProbeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/not recognized as an internal or external command/i.test(raw)) return 'Command not found on daemon PATH.'
  if (/Get-Command/i.test(raw) && /not recognized|not found|cannot find/i.test(raw)) return 'Command not found by PowerShell.'
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !/^Command failed:/i.test(line))
    ?.slice(0, 180) ?? 'Probe command failed.'
}
