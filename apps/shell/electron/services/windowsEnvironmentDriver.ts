import {
  type EnvironmentAction,
  type EnvironmentActionResult,
  type EnvironmentDriver,
  type EnvironmentEvent,
  type EnvironmentObservation,
  type EnvironmentState,
  type EnvironmentStateQuery,
  type EnvironmentVerification,
} from './environmentDriver'
import { mcpSupervisor } from './mcpSupervisor'

export const WINDOWS_MCP_SERVER_ID = 'windows-mcp'

export class WindowsEnvironmentDriver implements EnvironmentDriver {
  readonly name = 'windows' as const

  canHandleTool(toolName: string): boolean {
    const resolved = mcpSupervisor.resolveTool(toolName)
    return resolved?.serverId === WINDOWS_MCP_SERVER_ID
  }

  async observe(): Promise<EnvironmentObservation> {
    const server = mcpSupervisor.getServer(WINDOWS_MCP_SERVER_ID)
    const tools = server?.tools?.map(tool => tool.name) ?? []
    return {
      driver: this.name,
      summary: server?.status === 'running'
        ? `Windows environment driver is available with ${tools.length} MCP-backed capability(s).`
        : `Windows environment driver is ${server?.status ?? 'unavailable'}.`,
      capabilities: tools,
      raw: server,
    }
  }

  async queryState(query: EnvironmentStateQuery = {}): Promise<EnvironmentState> {
    const server = mcpSupervisor.getServer(WINDOWS_MCP_SERVER_ID)
    return {
      driver: this.name,
      scope: query.scope,
      target: query.target,
      status: server?.status === 'running' ? 'available' : server ? 'partial' : 'unavailable',
      raw: server,
    }
  }

  async act(action: EnvironmentAction): Promise<EnvironmentActionResult> {
    if (action.type !== 'mcp_tool') {
      return { ok: false, error: `Windows driver does not implement semantic action "${action.name}" yet.` }
    }
    const resolved = mcpSupervisor.resolveTool(action.name)
    if (resolved?.serverId !== WINDOWS_MCP_SERVER_ID) {
      return { ok: false, error: `Tool "${action.name}" is not owned by the Windows environment driver.` }
    }
    const result = await mcpSupervisor.callTool({
      namespacedName: action.name,
      rawArgs: action.args ?? {},
    })
    return result.ok
      ? { ok: true, content: result.content, isError: result.isError }
      : { ok: false, error: result.error, aborted: result.aborted }
  }

  subscribeEvents(_handler: (event: EnvironmentEvent) => void): () => void {
    // TODO: Bridge Windows MCP/event-stream notifications into this API.
    return () => { /* no-op until event stream integration exists */ }
  }

  async verifyResult(action: EnvironmentAction, result: EnvironmentActionResult): Promise<EnvironmentVerification> {
    // TODO: Add semantic verification using accessibility state, grounding, or targeted observe() calls.
    return {
      ok: result.ok && !result.isError,
      summary: result.ok && !result.isError
        ? `Windows action "${action.name}" completed.`
        : `Windows action "${action.name}" did not complete successfully.`,
      evidence: result.content ?? result.error,
    }
  }
}

export const windowsEnvironmentDriver = new WindowsEnvironmentDriver()
