import { loadSettings } from './index'
import { startDaemonServer } from './httpServer.mjs'
import { createDaemonRuntimeServices } from './runtimeServices'

interface DaemonHandle {
  url: string
  close: () => Promise<void>
}

async function main() {
  const runtime = createDaemonRuntimeServices()
  const daemon = await startDaemonServer({ runtime }) as DaemonHandle

  const settings = await loadSettings()
  if (settings) {
    await runtime.applyMcpServersFromSettings(settings)
  }

  console.log(`[ava-daemon] runtime listening on ${daemon.url}`)
  console.log('[ava-daemon] endpoints: /health, /runtime/status, /tasks/analyze, /tasks/plan, /mcp/servers, /chat/stream, /chat/ws')

  async function shutdown(signal: string) {
    console.log(`[ava-daemon] received ${signal}; shutting down`)
    try {
      await runtime.shutdownMcp()
      await daemon.close()
      process.exit(0)
    } catch (error) {
      console.error('[ava-daemon] shutdown failed', error)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[ava-daemon] failed to start runtime daemon', error)
  process.exit(1)
})
