// ─────────────────────────────────────────────
// File-backed persistence for Settings + Conversations.
// Stored in Electron userData (e.g. %APPDATA%/Ava/).
// ─────────────────────────────────────────────

import { app } from 'electron'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

function userDataFile(name: string): string {
  return join(app.getPath('userData'), name)
}

async function ensureDir(path: string): Promise<void> {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await readFile(file, 'utf-8')
    return JSON.parse(text) as T
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    console.warn(`[storage] failed to read ${file}:`, err)
    return null
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(file)
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, file)
}

// ── Settings ──────────────────────────────────────

const SETTINGS_FILE = 'settings.json'

export async function loadSettings(): Promise<unknown> {
  return readJson(userDataFile(SETTINGS_FILE))
}

export async function saveSettings(data: unknown): Promise<void> {
  await writeJsonAtomic(userDataFile(SETTINGS_FILE), data)
}

// ── Conversations ─────────────────────────────────

const CONVERSATIONS_FILE = 'conversations.json'

export async function loadConversations(): Promise<unknown> {
  return readJson(userDataFile(CONVERSATIONS_FILE))
}

export async function saveConversations(data: unknown): Promise<void> {
  await writeJsonAtomic(userDataFile(CONVERSATIONS_FILE), data)
}

export function getUserDataPath(): string {
  return app.getPath('userData')
}
