export interface RuntimeEnvironmentInfo {
  platform: NodeJS.Platform
  os: 'Windows' | 'macOS' | 'Linux' | 'Unknown'
  defaultShell: 'PowerShell' | 'cmd' | 'bash' | 'sh' | 'unknown'
  pathStyle: 'windows' | 'posix'
  pathExample: string
  allowedCommands: string[]
  devServerAllowedCommands: string[]
  commandGuidance: string[]
}

export const COMMAND_ALLOWLIST = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'bunx',
  'node',
  'git',
  'rg',
  'python',
  'python3',
  'py',
  'pip',
  'pip3',
  'pytest',
  'dotnet',
  'tsc',
  'vite',
  'deno',
  'uv',
  'uvx',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
])

export const DEVSERVER_COMMAND_ALLOWLIST = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'node'])

export function runtimeEnvironmentInfo(): RuntimeEnvironmentInfo {
  const platform = process.platform
  if (platform === 'win32') {
    return {
      platform,
      os: 'Windows',
      defaultShell: 'PowerShell',
      pathStyle: 'windows',
      pathExample: 'D:\\Apps\\Project',
      allowedCommands: Array.from(COMMAND_ALLOWLIST),
      devServerAllowedCommands: Array.from(DEVSERVER_COMMAND_ALLOWLIST),
      commandGuidance: [
        'Use Windows paths with backslashes when referencing local files.',
        'Do not use Unix-only commands such as mv, cp, rm, touch, mkdir -p, or chmod.',
        'Use PowerShell equivalents for safe operations: Move-Item, Copy-Item, New-Item, Get-ChildItem.',
        'Do not delete files with rm or Remove-Item unless Ava adds an explicit safe delete tool for that workflow.',
        'For file creation/editing, prefer Ava file tools over shell commands.',
        'For npm/node/git work, use shell.run_command with command and args as separate fields.',
        'For npm project scaffolding, package names must be lowercase/kebab-case even if the folder path contains uppercase letters.',
        'For long-running non-devserver commands, use process.start and check process.status/process.wait/process.logs.',
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      platform,
      os: 'macOS',
      defaultShell: 'bash',
      pathStyle: 'posix',
      pathExample: '/Users/name/project',
      allowedCommands: Array.from(COMMAND_ALLOWLIST),
      devServerAllowedCommands: Array.from(DEVSERVER_COMMAND_ALLOWLIST),
      commandGuidance: [
        'Use POSIX paths when referencing local files.',
        'Prefer Ava file tools for file creation/editing.',
        'Use shell.run_command with command and args as separate fields.',
        'For npm project scaffolding, package names must be lowercase/kebab-case even if the folder path contains uppercase letters.',
        'For long-running non-devserver commands, use process.start and check process.status/process.wait/process.logs.',
      ],
    }
  }
  if (platform === 'linux') {
    return {
      platform,
      os: 'Linux',
      defaultShell: 'bash',
      pathStyle: 'posix',
      pathExample: '/home/user/project',
      allowedCommands: Array.from(COMMAND_ALLOWLIST),
      devServerAllowedCommands: Array.from(DEVSERVER_COMMAND_ALLOWLIST),
      commandGuidance: [
        'Use POSIX paths when referencing local files.',
        'Prefer Ava file tools for file creation/editing.',
        'Use shell.run_command with command and args as separate fields.',
        'For npm project scaffolding, package names must be lowercase/kebab-case even if the folder path contains uppercase letters.',
        'For long-running non-devserver commands, use process.start and check process.status/process.wait/process.logs.',
      ],
    }
  }
  return {
    platform,
    os: 'Unknown',
    defaultShell: 'unknown',
    pathStyle: 'posix',
    pathExample: '/path/to/project',
    allowedCommands: Array.from(COMMAND_ALLOWLIST),
    devServerAllowedCommands: Array.from(DEVSERVER_COMMAND_ALLOWLIST),
    commandGuidance: [
      'Prefer Ava file tools for file creation/editing.',
      'Use shell.run_command with command and args as separate fields.',
    ],
  }
}

export function runtimeEnvironmentPrompt(): string {
  const env = runtimeEnvironmentInfo()
  return [
    'Runtime environment:',
    `- OS: ${env.os} (${env.platform})`,
    `- Default shell family: ${env.defaultShell}`,
    `- Path style: ${env.pathStyle}; example: ${env.pathExample}`,
    `- shell.run_command allowed commands: ${env.allowedCommands.join(', ')}`,
    `- devserver.start allowed commands: ${env.devServerAllowedCommands.join(', ')}`,
    'Command rules:',
    ...env.commandGuidance.map(item => `- ${item}`),
  ].join('\n')
}
