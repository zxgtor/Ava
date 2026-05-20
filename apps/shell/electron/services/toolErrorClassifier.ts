export type ToolErrorKind =
  | 'missing_dir'
  | 'missing_file'
  | 'permission_scope'
  | 'unknown_tool'
  | 'missing_arg'
  | 'command_not_allowed'
  | 'tool_runtime'
  | 'unknown'

export interface ClassifiedToolError {
  kind: ToolErrorKind
  message: string
  path?: string
  recoveryHint: string
}

const QUOTED_PATH_RE = /"([A-Za-z]:[\\/][^"]+)"/
const PLAIN_PATH_RE = /\b([A-Za-z]:[\\/][^\r\n"]+)/

export function classifyToolError(error: unknown): ClassifiedToolError {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  const path = extractPath(message)

  if (lower.includes('outside the active project') || lower.includes('outside the latest user request scope')) {
    return {
      kind: 'permission_scope',
      message,
      path,
      recoveryHint: 'The requested path is outside the current task scope. Ask the user to confirm/allow the target directory instead of retrying the same tool call.',
    }
  }

  if (lower.includes('unknown tool') || lower.includes('unknown built-in tool')) {
    return {
      kind: 'unknown_tool',
      message,
      recoveryHint: 'Use one of the exposed Ava tool names exactly, or an alias Ava can normalize. Do not invent MCP-style names.',
    }
  }

  if (lower.includes('requires "') || lower.includes('tool requires "') || lower.includes('required')) {
    return {
      kind: 'missing_arg',
      message,
      recoveryHint: 'Retry with the required structured arguments filled in. Do not send a combined shell string.',
    }
  }

  if (
    lower.includes('blocked potentially dangerous command argument') ||
    lower.includes('is not allowed') ||
    lower.includes('command') && lower.includes('allowed commands')
  ) {
    return {
      kind: 'command_not_allowed',
      message,
      recoveryHint: 'Use an allowed structured command for build/install/test only. For creating or editing files, do not use PowerShell scripts; use file.write_text or file.patch instead.',
    }
  }

  if (
    lower.includes('directory does not exist') ||
    lower.includes('enoent') && lower.includes('scandir') ||
    lower.includes('project directory') && lower.includes('does not exist')
  ) {
    return {
      kind: 'missing_dir',
      message,
      path,
      recoveryHint: 'Create the target working directory with file.create_dir first. Do not inspect src/ or run project.map before the project is scaffolded.',
    }
  }

  if (lower.includes('file') && lower.includes('does not exist') || lower.includes('enoent') && lower.includes('open')) {
    return {
      kind: 'missing_file',
      message,
      path,
      recoveryHint: 'If this file should be created, use file.write_text. If you need discovery, list/map the parent directory first.',
    }
  }

  if (lower.startsWith('tool runtime error:')) {
    return {
      kind: 'tool_runtime',
      message,
      path,
      recoveryHint: 'Treat this as a tool failure, summarize the exact error, and choose a safer next tool call instead of retrying blindly.',
    }
  }

  return {
    kind: 'unknown',
    message,
    path,
    recoveryHint: 'Use the latest tool result to choose a different concrete action. Do not repeat the same failing call without changing arguments.',
  }
}

function extractPath(message: string): string | undefined {
  const quoted = QUOTED_PATH_RE.exec(message)?.[1]
  if (quoted) return quoted.trim()
  const plain = PLAIN_PATH_RE.exec(message)?.[1]
  return plain?.trim().replace(/[.)\],;:]+$/, '')
}
