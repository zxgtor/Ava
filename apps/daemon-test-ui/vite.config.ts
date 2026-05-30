import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const avaBrainInputFlowPath = resolve(__dirname, '..', 'dev-control', 'ava-brain', 'ava-brain-input-flow.html')

function serveAvaBrainInputFlow() {
  return {
    name: 'ava-brain-input-flow',
    configureServer(server) {
      server.middlewares.use('/ava-brain/input-flow', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(readFileSync(avaBrainInputFlowPath, 'utf8'))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), serveAvaBrainInputFlow()],
  server: {
    proxy: {
      '/ava-brain': {
        target: 'http://127.0.0.1:17872',
        changeOrigin: true,
      },
    },
  },
})
