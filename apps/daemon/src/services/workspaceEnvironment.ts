import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AvaWorkspaceEnsureProjectDocsRequest,
  AvaWorkspaceEnsureProjectDocsResult,
  AvaWorkspaceListEntry,
} from '@ava/contracts'

function requirePath(path: unknown, label = 'path'): string {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`${label} is required.`)
  }
  return path.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function writeIfMissing(path: string, content: string): Promise<'created' | 'existing'> {
  await mkdir(dirname(path), { recursive: true })
  if (await exists(path)) return 'existing'
  await writeFile(path, content, 'utf8')
  return 'created'
}

function projectDocTemplates(title: string, trait: string): Array<{ fileName: string; content: string }> {
  const safeTitle = title.trim() || 'Untitled'
  const docs = [{
    fileName: 'TASKS.md',
    content: `# Tasks: ${safeTitle}\n\n- [ ] Initial Research\n- [ ] Brainstorming\n- [ ] Draft Implementation\n- [ ] Review & Refine\n`,
  }]

  if (trait === 'code') {
    docs.push({
      fileName: 'SPECS.md',
      content: `# Technical Specs: ${safeTitle}\n\n## Architecture\n- \n\n## Dependencies\n- \n`,
    })
  } else if (trait === 'business') {
    docs.push({
      fileName: 'BUSINESS_PLAN.md',
      content: `# Business Plan: ${safeTitle}\n\n## Market Analysis\n- \n\n## Revenue Model\n- \n`,
    })
  } else if (trait === 'video') {
    docs.push({
      fileName: 'SCRIPT.md',
      content: `# Script/Storyboard: ${safeTitle}\n\n## Scene 1\n- \n`,
    })
  } else if (trait === 'design') {
    docs.push({
      fileName: 'DESIGN_SPEC.md',
      content: `# Design Spec: ${safeTitle}\n\n## Brand/Mood\n- \n\n## Color Palette\n- \n\n## Typography\n- \n`,
    })
    docs.push({
      fileName: 'ASSETS.md',
      content: `# Design Assets: ${safeTitle}\n\n- [ ] Logo\n- [ ] Icons\n- [ ] Mockups\n`,
    })
  } else {
    docs.push({
      fileName: 'GOALS.md',
      content: `# Goals: ${safeTitle}\n\nDescribe the main objectives here.`,
    })
  }

  return docs
}

function detached(command: string, args: string[], cwd?: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {
    // Environment launch is best-effort; callers receive synchronous validation errors.
  })
  child.unref()
}

export async function ensureProjectDocs(request: AvaWorkspaceEnsureProjectDocsRequest): Promise<AvaWorkspaceEnsureProjectDocsResult> {
  const folderPath = requirePath(request.folderPath, 'folderPath')
  const trait = typeof request.trait === 'string' ? request.trait : 'chat'
  await mkdir(folderPath, { recursive: true })

  const created: string[] = []
  const existing: string[] = []
  for (const doc of projectDocTemplates(request.title, trait)) {
    const status = await writeIfMissing(join(folderPath, doc.fileName), doc.content)
    if (status === 'created') created.push(doc.fileName)
    else existing.push(doc.fileName)
  }

  return { folderPath, created, existing }
}

export async function readWorkspaceText(request: { path?: string }): Promise<string> {
  return readFile(requirePath(request.path), 'utf8')
}

export async function writeWorkspaceText(request: { path?: string; content?: string }): Promise<{ path: string; bytes: number }> {
  const path = requirePath(request.path)
  const content = typeof request.content === 'string' ? request.content : ''
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return { path, bytes: Buffer.byteLength(content, 'utf8') }
}

export async function createWorkspaceDir(request: { path?: string }): Promise<{ path: string }> {
  const path = requirePath(request.path)
  await mkdir(path, { recursive: true })
  return { path }
}

export async function listWorkspaceDir(request: { path?: string }): Promise<AvaWorkspaceListEntry[]> {
  const path = requirePath(request.path)
  const entries = await readdir(path, { withFileTypes: true })
  return Promise.all(entries.map(async entry => {
    const fullPath = join(path, entry.name)
    const details = await stat(fullPath).catch(() => null)
    return {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      size: details?.size ?? 0,
    }
  }))
}

export async function openEnvironmentPath(request: { path?: string }): Promise<{ opened: string }> {
  const path = requirePath(request.path)
  if (process.platform === 'win32') {
    detached('cmd.exe', ['/c', 'start', '', path])
  } else if (process.platform === 'darwin') {
    detached('open', [path])
  } else {
    detached('xdg-open', [path])
  }
  return { opened: path }
}

export async function openEnvironmentTerminal(request: { path?: string }): Promise<{ opened: string }> {
  const path = requirePath(request.path)
  if (process.platform === 'win32') {
    detached('powershell.exe', ['-NoExit', '-WorkingDirectory', path], path)
  } else if (process.platform === 'darwin') {
    detached('open', ['-a', 'Terminal', path])
  } else {
    detached('x-terminal-emulator', [], path)
  }
  return { opened: path }
}

export async function openEnvironmentVSCode(request: { path?: string }): Promise<{ opened: string }> {
  const path = requirePath(request.path)
  detached('code', [path], (await exists(path)) ? (await stat(path)).isDirectory() ? path : dirname(path) : dirname(path))
  return { opened: path, }
}
