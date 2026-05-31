import { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, globalShortcut, shell } from 'electron'

import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'


import { getUserDataPath } from './storage'
import { applyWin11RoundedCorners } from './services/dwmCorners'
import {
  abortDaemonChatStream,
  streamChatThroughDaemon,
} from './services/daemonChatClient'
import { daemonRuntimeClient } from './services/daemonRuntimeClient'
import { ensureNodeDaemonRuntime, stopNodeDaemonRuntime } from './services/nodeDaemonProcess'
import { configureRuntimePaths } from '../../daemon/src/services/runtimePaths'
import type { PluginState, StreamChatArgs } from '@ava/daemon'

const TITLE_BAR_HEIGHT = 36
const DEV_CONTROL_PANEL_URL = process.env.AVA_DEV_CONTROL_PANEL_URL || 'http://127.0.0.1:5179'

function isBrokenPipeError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EPIPE')
}

process.on('uncaughtException', err => {
  if (isBrokenPipeError(err)) {
    console.warn('[main] ignored broken pipe from closed child process/stdout')
    return
  }
  throw err
})

process.on('unhandledRejection', reason => {
  if (isBrokenPipeError(reason)) {
    console.warn('[main] ignored broken pipe rejection from closed child process/stdout')
    return
  }
  console.error('[main] unhandled rejection:', reason)
})

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
      height: TITLE_BAR_HEIGHT,
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
      height: TITLE_BAR_HEIGHT,
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
  ipcMain.handle('ava:settings:load', async () => daemonRuntimeClient.loadSettings())
  ipcMain.handle('ava:settings:save', async (_e, data: unknown) => {
    await daemonRuntimeClient.saveSettings(data)
    return true
  })

  ipcMain.handle('ava:agent:classifyInput', async (_e, request: unknown) => daemonRuntimeClient.classifyInput(request))
  ipcMain.handle('ava:agent:dispatchInput', async (_e, request: unknown) => daemonRuntimeClient.dispatchInput(request))
  ipcMain.handle('ava:agent:startIntakeSession', async (_e, request: unknown) => daemonRuntimeClient.startIntakeSession(request))
  ipcMain.handle('ava:agent:replyIntakeSession', async (_e, request: unknown) => daemonRuntimeClient.replyIntakeSession(request))
  ipcMain.handle('ava:agent:analyzeTask', async (_e, request: unknown) => daemonRuntimeClient.analyzeTask(request))
  ipcMain.handle('ava:agent:planTask', async (_e, request: unknown) => daemonRuntimeClient.planTask(request))
  ipcMain.handle('ava:agent:getActiveTaskPlan', async (_e, request: unknown) => daemonRuntimeClient.getActiveTaskPlan(request))
  ipcMain.handle('ava:agent:setActiveTaskPlan', async (_e, request: unknown) => daemonRuntimeClient.setActiveTaskPlan(request))
  ipcMain.handle('ava:agent:clearActiveTaskPlan', async (_e, request: unknown) => daemonRuntimeClient.clearActiveTaskPlan(request))
  ipcMain.handle('ava:agent:dispatchCodeAgentTask', async (_e, request: unknown) => daemonRuntimeClient.dispatchCodeAgentTask(request))
  ipcMain.handle('ava:agent:listCodeAgentSessions', async () => daemonRuntimeClient.listCodeAgentSessions())
  ipcMain.handle('ava:agent:startCodeAgentSession', async (_e, sessionId: string) => daemonRuntimeClient.startCodeAgentSession(sessionId))
  ipcMain.handle('ava:agent:sendCodeAgentSessionMessage', async (_e, request: unknown) => daemonRuntimeClient.sendCodeAgentSessionMessage(request))
  ipcMain.handle('ava:agent:stopCodeAgentSession', async (_e, sessionId: string) => daemonRuntimeClient.stopCodeAgentSession(sessionId))
  ipcMain.handle('ava:agent:getProjectBrief', async (_e, request: unknown) => daemonRuntimeClient.getProjectBrief(request))

  // ── conversations persistence ───────────────
  ipcMain.handle('ava:conversations:load', async () => daemonRuntimeClient.loadConversations())
  ipcMain.handle('ava:conversations:save', async (_e, data: unknown) => {
    await daemonRuntimeClient.saveConversations(data)
    return true
  })

  // ── LLM streaming ───────────────────────────
  ipcMain.handle('ava:llm:stream', async (event, args: StreamChatArgs) => {
    try {
      const result = await streamChatThroughDaemon(event.sender, args)
      return { ok: true as const, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('ava:llm:abort', (_e, streamId: string) => abortDaemonChatStream(streamId))

  // ── MCP runtime ─────────────────────────────
  ipcMain.handle('ava:mcp:listServers', () => daemonRuntimeClient.listMcpServers())
  ipcMain.handle('ava:mcp:restart', async (_e, serverId: string) => {
    await daemonRuntimeClient.restartMcpServer(serverId)
    return true
  })

  ipcMain.handle('ava:dev:openControlPanel', async () => {
    await shell.openExternal(DEV_CONTROL_PANEL_URL)
    return DEV_CONTROL_PANEL_URL
  })

  ipcMain.handle('ava:dev:appendUnitTestResult', async (_e, raw: unknown) => {
    if (!is.dev && process.env.AVA_E2E !== '1') return { ok: false as const, error: 'Unit Test logging is only available in dev mode.' }
    return daemonRuntimeClient.appendUnitTestResult(raw)
  })

  // ── Tool audit log ──────────────────────────
  ipcMain.handle('ava:toolAudit:list', async (_e, limit?: number) => daemonRuntimeClient.listToolAudit(limit))
  ipcMain.handle('ava:toolAudit:clear', async () => {
    await daemonRuntimeClient.clearToolAudit()
    return true
  })

  // ── Plugins ─────────────────────────────────
  ipcMain.handle('ava:plugins:list', async (_e, states: Record<string, PluginState> | undefined) =>
    daemonRuntimeClient.listPlugins(states ?? {}),
  )
  ipcMain.handle('ava:plugins:listCommands', async (_e, states: Record<string, PluginState> | undefined) =>
    daemonRuntimeClient.listPluginCommands(states ?? {}),
  )
  ipcMain.handle('ava:plugins:installFolder', async (_e, path?: string) => {
    if (typeof path === 'string' && path.trim()) {
      return daemonRuntimeClient.installPluginFromFolder(path.trim())
    }
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
    return daemonRuntimeClient.installPluginFromFolder(result.filePaths[0])
  })
  ipcMain.handle('ava:plugins:installZip', async (_e, path?: string) => {
    if (typeof path === 'string' && path.trim()) {
      return daemonRuntimeClient.installPluginFromZip(path.trim())
    }
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
    return daemonRuntimeClient.installPluginFromZip(result.filePaths[0])
  })
  ipcMain.handle('ava:plugins:installGit', async (_e, url: string) =>
    daemonRuntimeClient.installPluginFromGit(url),
  )
  ipcMain.handle('ava:plugins:uninstall', async (_e, pluginId: string) => {
    await daemonRuntimeClient.uninstallPlugin(pluginId)
    return true
  })
  ipcMain.handle('ava:plugins:getMarketplaceCatalog', async (_e, states, options) =>
    daemonRuntimeClient.getMarketplaceCatalog(states, options),
  )
  ipcMain.handle('ava:plugins:update', async (_e, pluginId: string) =>
    daemonRuntimeClient.updatePlugin(pluginId),
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

  ipcMain.handle('ava:environment:openPath', async (_e, path: string) => {
    const result = await daemonRuntimeClient.openPath({ path }) as { opened?: string }
    return result.opened ?? path
  })

  ipcMain.handle('ava:workspace:writeText', async (_e, path: string, content: string) => {
    await daemonRuntimeClient.writeWorkspaceText({ path, content })
    return true
  })

  ipcMain.handle('ava:workspace:createDir', async (_e, path: string) => {
    await daemonRuntimeClient.createWorkspaceDir({ path })
    return true
  })

  ipcMain.handle('ava:workspace:readText', async (_e, path: string) => {
    return daemonRuntimeClient.readWorkspaceText({ path })
  })

  ipcMain.handle('ava:workspace:listDir', async (_e, path: string) => {
    return daemonRuntimeClient.listWorkspaceDir({ path })
  })

  ipcMain.handle('ava:workspace:probeCodeAgents', async () => {
    return daemonRuntimeClient.probeCodeAgents()
  })

  ipcMain.handle('ava:workspace:installCodeAgent', async (_e, agentId: string) => {
    return daemonRuntimeClient.installCodeAgent(agentId)
  })

  ipcMain.handle('ava:environment:openTerminal', async (_e, path: string) => {
    return daemonRuntimeClient.openTerminal({ path })
  })

  ipcMain.handle('ava:environment:openVSCode', async (_e, path: string) => {
    return daemonRuntimeClient.openVSCode({ path })
  })

  ipcMain.handle('ava:workspace:ensureProjectDocs', async (_e, request: unknown) => {
    return daemonRuntimeClient.ensureProjectDocs(request)
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
  ) => daemonRuntimeClient.probeModels(args))
  ipcMain.handle('ava:llm:probeModelCapabilities', async (
    _e,
    args: {
      provider: {
        id: string
        name: string
        type: 'local' | 'cloud' | 'aggregator'
        baseUrl: string
        apiKey: string
        defaultModel: string
      }
      model: string
    },
  ) => daemonRuntimeClient.probeModelCapabilities(args))
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
    { label: '打开 Dev Control Panel', click: () => {
        void shell.openExternal(DEV_CONTROL_PANEL_URL)
      },
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

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  configureRuntimePaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
  })

  await ensureNodeDaemonRuntime().catch(err => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[daemon] node runtime unavailable: ${message}`)
  })

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
  stopNodeDaemonRuntime().catch(err => console.warn('[daemon] node shutdown failed:', err))
})
