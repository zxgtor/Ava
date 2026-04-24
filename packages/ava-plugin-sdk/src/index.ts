/**
 * @ava/plugin-sdk
 *
 * Types mirror the Claude Cowork / Claude Code plugin format:
 *   <plugin-root>/
 *     .claude-plugin/plugin.json   ← PluginManifest
 *     .mcp.json                    ← McpServersConfig
 *     skills/<name>/SKILL.md       ← Skill (markdown w/ frontmatter)
 *     commands/<name>.md           ← Command
 *     agents/<name>.md             ← Sub-agent (optional)
 *     hooks/*                      ← Hooks (optional)
 *
 * This is P0 scaffold — fields will be refined as the runtime lands.
 * Spec reference: https://code.claude.com/docs/en/plugin-marketplaces
 */

/** `.claude-plugin/plugin.json` */
export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string | { name: string; email?: string; url?: string }
  homepage?: string
  license?: string
  /** Optional explicit lists; if omitted, runtime discovers by folder convention. */
  commands?: string[]
  skills?: string[]
  agents?: string[]
  hooks?: string[]
}

/** `.mcp.json` — one entry per MCP server the plugin ships. */
export interface McpServersConfig {
  mcpServers: Record<string, McpServerSpec>
}

export type McpServerSpec = StdioMcpServer | HttpMcpServer

export interface StdioMcpServer {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface HttpMcpServer {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

/** Parsed Skill — contents of a `skills/<name>/SKILL.md` file. */
export interface Skill {
  name: string
  description?: string
  body: string
  /** Absolute path to the SKILL.md, useful for resolving relative references. */
  sourcePath: string
}

/** Parsed Command — contents of a `commands/<name>.md` file. */
export interface Command {
  name: string
  description?: string
  body: string
  sourcePath: string
}

/** Runtime view of a loaded plugin. */
export interface LoadedPlugin {
  id: string
  rootPath: string
  manifest: PluginManifest
  mcpServers: Record<string, McpServerSpec>
  skills: Skill[]
  commands: Command[]
  enabled: boolean
}
