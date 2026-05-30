import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ava-brain': {
        target: 'http://127.0.0.1:17872',
        changeOrigin: true,
      },
    },
  },
})
