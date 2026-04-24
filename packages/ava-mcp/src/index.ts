/**
 * @ava/mcp
 *
 * P0 placeholder. Real implementation lands in P2.
 *
 * Planned surface:
 *   - startMcpServer(spec) / stopMcpServer(id)   — lifecycle
 *   - listTools(id)                              — introspection
 *   - callTool(id, name, args)                   — invocation
 *   - McpSupervisor                              — manages many at once
 */

import type { McpServerSpec } from '@ava/plugin-sdk'

export type { McpServerSpec }

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpClientHandle {
  id: string
  spec: McpServerSpec
  /** Will be populated by the real client in P2. */
  tools: McpToolDescriptor[]
}

/** Placeholder — throws until P2. Kept so the shell can import & reference it today. */
export async function startMcpServer(_spec: McpServerSpec): Promise<McpClientHandle> {
  throw new Error('@ava/mcp: startMcpServer not implemented yet (P2)')
}

export async function stopMcpServer(_id: string): Promise<void> {
  throw new Error('@ava/mcp: stopMcpServer not implemented yet (P2)')
}
