import { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, globalShortcut, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { autoUpdater } from 'electron-updater'
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
import { mcpSupervisor, type McpServerConfig } from './services/mcpSupervisor'
import { pluginManager, type PluginState } from './services/pluginManager'
import { toolAuditLog } from './services/toolAuditLog'
import { applyWin11RoundedCorners } from './services/dwmCorners'

const execAsync = promisify(exec)

let mainWindow: BrowserWindow | null = null
let previewWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createPreviewWindow(theme?: string): void {
  if (previewWindow) {
    previewWindow.focus()
    return
  }

  previewWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Ava Preview',
    autoHideMenuBar: true,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 44
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  previewWindow.on('ready-to-show', () => {
    if (previewWindow) {
      applyWin11RoundedCorners(previewWindow, 'round')
      previewWindow.show()
    }
  })

  previewWindow.on('closed', () => {
    previewWindow = null
  })

  const query = { view: 'preview' }
  if (theme) (query as any).theme = theme

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('view', 'preview')
    if (theme) url.searchParams.set('theme', theme)
    previewWindow.loadURL(url.toString())
  } else {
    previewWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

function createMainWindow(): void {
  const appIconPath = join(__dirname, '../../build/icon.png')
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Ava',
    icon: appIconPath,
    // Transparent + frameless window. CSS `backdrop-filter: blur()` on the
    // root container blurs whatever the OS composites behind us (the
    // desktop) — that gives us the Win11 acrylic look without depending
    // on the fragile `backgroundMaterial` API. DWM rounded corners are
    // applied on `ready-to-show` to eliminate the transparent corner gap.
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 44
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) {
      // Apply Win11 system-level rounded corners (no-op on non-Windows / Win10)
      applyWin11RoundedCorners(mainWindow, 'round')
      mcpSupervisor.wire(mainWindow.webContents)
      initAutoUpdater(mainWindow)
    }
    mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
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
    const mcpServers = await readRuntimeMcpServers(data)
    if (mcpServers) await mcpSupervisor.applyConfigs(mcpServers)
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

  // ── MCP runtime ─────────────────────────────
  ipcMain.handle('ava:mcp:listServers', () => mcpSupervisor.listServers())
  ipcMain.handle('ava:mcp:restart', async (_e, serverId: string) => {
    await mcpSupervisor.restart(serverId)
    return true
  })

  // ── Tool audit log ──────────────────────────
  ipcMain.handle('ava:toolAudit:list', async (_e, limit?: number) =>
    toolAuditLog.list(limit),
  )
  ipcMain.handle('ava:toolAudit:clear', async () => {
    await toolAuditLog.clear()
    return true
  })

  // ── Plugins ─────────────────────────────────
  ipcMain.handle('ava:plugins:list', async (_e, states: Record<string, PluginState> | undefined) =>
    pluginManager.discover(states ?? {}),
  )
  ipcMain.handle('ava:plugins:listCommands', async (_e, states: Record<string, PluginState> | undefined) =>
    pluginManager.commandsForStates(states ?? {}),
  )
  ipcMain.handle('ava:plugins:installFolder', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择插件目录',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          title: '选择插件目录',
          properties: ['openDirectory'],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return pluginManager.installFromFolder(result.filePaths[0])
  })
  ipcMain.handle('ava:plugins:installZip', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择插件 zip',
          properties: ['openFile'],
          filters: [{ name: 'Zip archives', extensions: ['zip'] }],
        })
      : await dialog.showOpenDialog({
          title: '选择插件 zip',
          properties: ['openFile'],
          filters: [{ name: 'Zip archives', extensions: ['zip'] }],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return pluginManager.installFromZip(result.filePaths[0])
  })
  ipcMain.handle('ava:plugins:installGit', async (_e, url: string) =>
    pluginManager.installFromGit(url),
  )
  ipcMain.handle('ava:plugins:uninstall', async (_e, pluginId: string) => {
    await pluginManager.uninstall(pluginId)
    return true
  })
  ipcMain.handle('ava:plugins:getMarketplaceCatalog', async () =>
    pluginManager.getMarketplaceCatalog(),
  )
  ipcMain.handle('ava:plugins:update', async (_e, pluginId: string) =>
    pluginManager.update(pluginId),
  )

  // ── Dialog helpers ──────────────────────────
  ipcMain.handle('ava:dialog:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择允许访问的目录',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          title: '选择允许访问的目录',
          properties: ['openDirectory'],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('ava:shell:openPath', async (_e, path: string) => {
    return shell.openPath(path)
  })

  ipcMain.handle('ava:fs:writeFile', async (_e, path: string, content: string) => {
    await fs.writeFile(path, content, 'utf8')
    return true
  })

  ipcMain.handle('ava:fs:readFile', async (_e, path: string) => {
    return fs.readFile(path, 'utf8')
  })

  ipcMain.handle('ava:fs:listDir', async (_e, path: string) => {
    const files = await fs.readdir(path, { withFileTypes: true })
    return files.map(f => ({
      name: f.name,
      isDirectory: f.isDirectory(),
      size: 0 // Simplification
    }))
  })

  ipcMain.handle('ava:shell:openInTerminal', async (_e, path: string) => {
    // Windows: opens powershell at the specified path
    return execAsync(`start powershell.exe -NoExit -WorkingDirectory "${path}"`)
  })

  ipcMain.handle('ava:shell:openInVSCode', async (_e, path: string) => {
    return execAsync(`code "${path}"`)
  })

  // ── Window Management ──────────────────────
  ipcMain.handle('ava:window:openPreview', (_e, theme?: string) => {
    createPreviewWindow(theme)
  })

  ipcMain.handle('ava:window:updatePreview', (_e, content: string) => {
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('ava:preview:update', content)
    })
  })

  ipcMain.handle('ava:window:updateTheme', (_e, theme: string) => {
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('ava:theme:update', theme)
    })
  })

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
  ipcMain.handle('ava:app:version', () => app.getVersion())
  ipcMain.handle('ava:app:checkUpdates', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('ava:app:installUpdate', () => {
    autoUpdater.quitAndInstall()
  })
}

function createTray(): void {
  const iconPath = join(__dirname, '../../build/icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示 Ava', click: () => mainWindow?.show() },
    { label: '重启后端服务', click: () => {
        for (const s of mcpSupervisor.listServers()) {
          if (s.status === 'running') void mcpSupervisor.restart(s.id)
        }
      }
    },
    { type: 'separator' },
    { label: '退出 (Quit)', click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  
  tray.setToolTip('Ava')
  tray.setContextMenu(contextMenu)
  
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
}

function initAutoUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = false
  autoUpdater.logger = console

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('ava:app:updateAvailable', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    win.webContents.send('ava:app:updateNotAvailable', info)
  })

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('ava:app:updateProgress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    win.webContents.send('ava:app:updateDownloaded', info)
  })

  autoUpdater.on('error', (err) => {
    win.webContents.send('ava:app:updateError', err.message)
  })
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  registerIpc()
  createMainWindow()
  createTray()
  
  globalShortcut.register('Alt+Space', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })

  loadSettings()
    .then(async raw => {
      const mcpServers = await readRuntimeMcpServers(raw)
      if (mcpServers) return mcpSupervisor.applyConfigs(mcpServers)
      return undefined
    })
    .catch(err => console.warn('[mcp] initial apply failed:', err))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  // Do not quit, stay in tray
})

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  mcpSupervisor.shutdown().catch(err => console.warn('[mcp] shutdown failed:', err))
})

async function readRuntimeMcpServers(raw: unknown): Promise<McpServerConfig[] | null> {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as { version?: unknown; mcpServers?: unknown; pluginStates?: unknown }
  if (src.version !== 2 || !Array.isArray(src.mcpServers)) return null
  const baseServers = src.mcpServers
    .filter((item): item is McpServerConfig => Boolean(item && typeof item === 'object' && typeof (item as McpServerConfig).id === 'string'))
  const pluginStates = isPluginStates(src.pluginStates) ? src.pluginStates : {}
  const pluginServers = await pluginManager.mcpServersForStates(pluginStates)
  return [...baseServers, ...pluginServers]
}

function isPluginStates(raw: unknown): raw is Record<string, PluginState> {
  if (!raw || typeof raw !== 'object') return false
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object') return false
  }
  return true
}
