const TOOL_NAME_ALIASES: Record<string, string> = {
  'fs.mkdir': 'file.create_dir',
  'fs.makedir': 'file.create_dir',
  'fs.makedirs': 'file.create_dir',
  'file.mkdir': 'file.create_dir',
  'filesystem.mkdir': 'file.create_dir',
  'filesystem.create_directory': 'file.create_dir',
  'fs.readfile': 'file.read_text',
  'fs.read_file': 'file.read_text',
  'file.read': 'file.read_text',
  'filesystem.read_file': 'file.read_text',
  'filesystem.read_text_file': 'file.read_text',
  'fs.writefile': 'file.write_text',
  'fs.write_file': 'file.write_text',
  'file.write': 'file.write_text',
  'filesystem.write_file': 'file.write_text',
  'filesystem.write_text_file': 'file.write_text',
  'fs.readdir': 'file.list_dir',
  'fs.listdir': 'file.list_dir',
  'file.list': 'file.list_dir',
  'filesystem.list_directory': 'file.list_dir',
  'fs.stat': 'file.stat',
  'filesystem.stat': 'file.stat',
  'shell.exec': 'shell.run_command',
  'shell.execute': 'shell.run_command',
  'shell.command': 'shell.run_command',
  terminal: 'shell.run_command',
  bash: 'shell.run_command',
  powershell: 'shell.run_command',
  cmd: 'shell.run_command',
  npm: 'shell.run_command',
  npx: 'shell.run_command',
  node: 'shell.run_command',
  git: 'shell.run_command',
}

const KNOWN_TASK_TOOLS = new Set([
  'shell.run_command',
  'file.read_text',
  'file.write_text',
  'file.list_dir',
  'file.create_dir',
  'file.stat',
  'file.patch',
  'project.detect',
  'project.map',
  'project.validate',
  'search.ripgrep',
  'devserver.start',
  'devserver.stop',
  'devserver.status',
  'preview.open',
  'preview.console',
  'preview.screenshot',
])

export function normalizeTaskToolName(name: string): string | null {
  const raw = name.trim()
  const lower = raw.toLowerCase()
  const mapped = TOOL_NAME_ALIASES[lower] ?? lower
  if (KNOWN_TASK_TOOLS.has(mapped)) return mapped
  if (/\b(shell|bash|powershell|cmd|terminal|npm|npx|node|git)\b/.test(lower)) return 'shell.run_command'
  return KNOWN_TASK_TOOLS.has(raw) ? raw : null
}

export function normalizeRequiredTools(requiredTools: string[]): string[] {
  const normalized = requiredTools
    .map(tool => normalizeTaskToolName(tool))
    .filter((tool): tool is string => Boolean(tool))
  return Array.from(new Set(normalized))
}
