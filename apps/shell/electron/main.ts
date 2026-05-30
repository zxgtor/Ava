import { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, globalShortcut, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { basename, join } from 'node:path'


import {
  loadConversations,
  saveConversations,
  getUserDataPath,
} from './storage'
import { applyWin11RoundedCorners } from './services/dwmCorners'
import {
  abortDaemonChatStream,
  streamChatThroughDaemon,
} from './services/daemonChatClient'
import { daemonRuntimeClient } from './services/daemonRuntimeClient'
import { ensureNodeDaemonRuntime, stopNodeDaemonRuntime } from './services/nodeDaemonProcess'
import { configureRuntimePaths } from '../../daemon/src/services/runtimePaths'
import type { PluginState, StreamChatArgs } from '@ava/daemon'

const execAsync = promisify(exec)
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

type CapabilityValue = 'yes' | 'no' | 'unknown'
type CapabilityToolFormat = 'openai' | 'hermes' | 'json' | 'none' | 'unknown'

interface ModelCapabilityProfile {
  model: string
  providerId: string
  vision: CapabilityValue
  tools: CapabilityValue
  thinking: CapabilityValue
  toolFormat: CapabilityToolFormat
  source: 'probe' | 'heuristic'
  checkedAt: number
  error?: string
}

function inferModelCapabilities(providerId: string, model: string): ModelCapabilityProfile {
  const id = `${providerId} ${model}`.toLowerCase()
  const hasVision = /\b(vision|vl|vlm|gpt-4o|o4|gemini|pixtral|llava|qwen2\.5-vl|qwen-vl|omni)\b/i.test(id)
  const hasThinking = /\b(reason|thinking|think|qwen3|deepseek-r1|r1|o1|o3|o4|qwq)\b/i.test(id)
  return {
    model,
    providerId,
    vision: hasVision ? 'yes' : 'unknown',
    tools: 'unknown',
    thinking: hasThinking ? 'yes' : 'unknown',
    toolFormat: 'unknown',
    source: 'heuristic',
    checkedAt: Date.now(),
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

function providerHeaders(provider: { id: string; apiKey: string }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.id === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
  }
  return headers
}

function detectToolFormatFromProbe(json: unknown): { tools: CapabilityValue; toolFormat: CapabilityToolFormat; thinking: CapabilityValue } {
  const raw = JSON.stringify(json ?? {})
  const parsed = json as {
    choices?: Array<{
      message?: {
        content?: string
        reasoning_content?: string
        reasoning?: string
        tool_calls?: unknown[]
      }
      delta?: {
        reasoning_content?: string
        reasoning?: string
        tool_calls?: unknown[]
      }
    }>
  }
  const choice = parsed.choices?.[0]
  const message = choice?.message
  const content = typeof message?.content === 'string' ? message.content : ''
  const hasNativeTool = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
  const hasThinking = Boolean(message?.reasoning_content || message?.reasoning || choice?.delta?.reasoning_content || choice?.delta?.reasoning || /reasoning_content/i.test(raw))
  if (hasNativeTool) return { tools: 'yes', toolFormat: 'openai', thinking: hasThinking ? 'yes' : 'unknown' }
  if (/<tool_call>[\s\S]*?<\/tool_call>/i.test(content)) return { tools: 'yes', toolFormat: 'hermes', thinking: hasThinking ? 'yes' : 'unknown' }
  if (/```(?:json)?\s*[\s\S]*?"name"\s*:\s*"ava_capability_probe"/i.test(content) || /^\s*\{[\s\S]*"name"\s*:\s*"ava_capability_probe"/i.test(content)) {
    return { tools: 'yes', toolFormat: 'json', thinking: hasThinking ? 'yes' : 'unknown' }
  }
  return { tools: 'no', toolFormat: 'none', thinking: hasThinking ? 'yes' : 'unknown' }
}

async function probeModelCapabilities(args: {
  provider: {
    id: string
    name: string
    type: 'local' | 'cloud' | 'aggregator'
    baseUrl: string
    apiKey: string
    defaultModel: string
  }
  model: string
}): Promise<{ ok: true; profile: ModelCapabilityProfile } | { ok: false; profile: ModelCapabilityProfile; error: string }> {
  const model = args.model || args.provider.defaultModel
  const inferred = inferModelCapabilities(args.provider.id, model)
  if (!args.provider.baseUrl || !model) {
    const error = 'Missing baseUrl or model.'
    return { ok: false, profile: { ...inferred, error }, error }
  }
  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: 'You are a tool capability probe. If tools are available, call ava_capability_probe exactly once. Do not explain.' },
        { role: 'user', content: 'Call the provided tool now.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'ava_capability_probe',
          description: 'Capability probe for Ava.',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'string' } },
            required: ['ok'],
          },
        },
      }],
      tool_choice: 'auto',
      max_tokens: 96,
      temperature: 0,
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
    }
    const res = await fetch(chatCompletionsUrl(args.provider.baseUrl), {
      method: 'POST',
      headers: providerHeaders(args.provider),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const error = `HTTP ${res.status}`
      return { ok: false, profile: { ...inferred, error }, error }
    }
    const json = await res.json() as unknown
    const detected = detectToolFormatFromProbe(json)
    return {
      ok: true,
      profile: {
        ...inferred,
        tools: detected.tools,
        toolFormat: detected.toolFormat,
        thinking: detected.thinking === 'unknown' ? inferred.thinking : detected.thinking,
        source: 'probe',
        checkedAt: Date.now(),
      },
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ok: false, profile: { ...inferred, error }, error }
  }
}

function defaultProjectFileContent(fileName: string): string | null {
  if (fileName === 'TASKS.md') {
    return [
      '# Tasks',
      '',
      '- [ ] Initial Research',
      '- [ ] Brainstorming',
      '- [ ] Draft Implementation',
      '- [ ] Review & Refine',
      '',
    ].join('\n')
  }
  return null
}

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

  // ── conversations persistence ───────────────
  ipcMain.handle('ava:conversations:load', async () => loadConversations())
  ipcMain.handle('ava:conversations:save', async (_e, data: unknown) => {
    await saveConversations(data)
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
    return daemonRuntimeClient.installPluginFromFolder(result.filePaths[0])
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

  ipcMain.handle('ava:shell:openPath', async (_e, path: string) => {
    return shell.openPath(path)
  })

  ipcMain.handle('ava:fs:writeFile', async (_e, path: string, content: string) => {
    await fs.writeFile(path, content, 'utf8')
    return true
  })

  ipcMain.handle('ava:fs:createDir', async (_e, path: string) => {
    await fs.mkdir(path, { recursive: true })
    return true
  })

  ipcMain.handle('ava:fs:readFile', async (_e, path: string) => {
    try {
      return await fs.readFile(path, 'utf8')
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
      if (code === 'ENOENT') {
        // Return default content WITHOUT writing it to disk. Auto-creating
        // TASKS.md at the project root made `npm create vite@latest .` and
        // similar scaffolders refuse to run because the directory was no
        // longer empty. The caller still sees the default text via this
        // return — it just isn't persisted.
        const defaultContent = defaultProjectFileContent(basename(path))
        if (defaultContent !== null) {
          return defaultContent
        }
      }
      throw err
    }
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
  ) => probeModelCapabilities(args))
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
