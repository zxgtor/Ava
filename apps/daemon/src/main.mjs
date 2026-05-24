import { startDaemonServer } from './httpServer.mjs'

const daemon = await startDaemonServer()

console.log(`[ava-daemon] listening on ${daemon.url}`)
console.log('[ava-daemon] endpoints: /health, /runtime/status, /mcp/servers')

async function shutdown(signal) {
  console.log(`[ava-daemon] received ${signal}; shutting down`)
  try {
    await daemon.close()
    process.exit(0)
  } catch (error) {
    console.error('[ava-daemon] shutdown failed', error)
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
