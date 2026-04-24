import { app, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import {
  loadSettings,
  saveSettings,
  loadConversations,
  saveConversations,
  getUserDataPath,
} from './storage'
import {
  streamChat,
  abortStream,
  type StreamChatArgs,
} from './llm'

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Ava',
    backgroundColor: '#0D0D0E',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // ── smoke test ──────────────────────────────
  ipcMain.handle('ava:ping', () => 'pong')
  ipcMain.handle('ava:paths:userData', () => getUserDataPath())

  // ── settings persistence ────────────────────
  ipcMain.handle('ava:settings:load', async () => loadSettings())
  ipcMain.handle('ava:settings:save', async (_e, data: unknown) => {
    await saveSettings(data)
    return true
  })

  // ── conversations persistence ───────────────
  ipcMain.handle('ava:conversations:load', async () => loadConversations())
  ipcMain.handle('ava:conversations:save', async (_e, data: unknown) => {
    await saveConversations(data)
    return true
  })

  // ── LLM streaming ───────────────────────────
  ipcMain.handle('ava:llm:stream', async (event, args: StreamChatArgs) => {
    try {
      const result = await streamChat(event.sender, args)
      return { ok: true as const, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('ava:llm:abort', (_e, streamId: string) => abortStream(streamId))

  // ── Provider connectivity probe ─────────────
  ipcMain.handle('ava:llm:probe', async (
    _e,
    args: { baseUrl: string; apiKey: string; providerId?: string },
  ) => {
    try {
      const trimmed = args.baseUrl.replace(/\/+$/, '')
      const url = /\/models$/i.test(trimmed)
        ? trimmed
        : /\/v1$/i.test(trimmed)
          ? `${trimmed}/models`
          : `${trimmed}/v1/models`

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (args.providerId === 'anthropic') {
        if (args.apiKey) headers['x-api-key'] = args.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        if (args.apiKey) headers['Authorization'] = `Bearer ${args.apiKey}`
      }

      const res = await fetch(url, { headers })
      if (!res.ok) {
        return { ok: false as const, error: `HTTP ${res.status}` }
      }
      const json: unknown = await res.json()
      const data = (json as {
        data?: Array<{ id?: string; created?: number; created_at?: string }>
      }).data
      // Sort by release date desc. OpenAI uses `created` (Unix seconds),
      // Anthropic uses `created_at` (ISO string). Models without a timestamp
      // keep their original order and sink to the bottom.
      const models = Array.isArray(data)
        ? data
            .filter((m): m is { id: string; created?: number; created_at?: string } =>
              typeof m?.id === 'string',
            )
            .map((m, idx) => {
              const ts = typeof m.created === 'number'
                ? m.created * 1000
                : typeof m.created_at === 'string'
                  ? Date.parse(m.created_at)
                  : NaN
              return { id: m.id, ts: Number.isFinite(ts) ? ts : -1, idx }
            })
            .sort((a, b) => {
              if (a.ts !== b.ts) return b.ts - a.ts  // newer first
              return a.idx - b.idx                    // stable fallback
            })
            .map(m => m.id)
        : []
      return { ok: true as const, models }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

app.whenReady().then(() => {
  registerIpc()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
