// ─────────────────────────────────────────────────────────────
// Persistence Layer
// JSON file for the TF-IDF index, stored in Ava's app data.
// ─────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { TfIdfIndex, type SerializedIndex } from './tfidf.js'

const INDEX_FILENAME = 'knowledge-index.json'

/** Resolve the index file path. Uses AVA_DATA_DIR env or default. */
function indexPath(): string {
  const dataDir = process.env['AVA_DATA_DIR']
  if (dataDir) return join(dataDir, INDEX_FILENAME)
  // Fallback: platform-specific app data
  const appData = process.env['APPDATA']
    ?? (process.platform === 'darwin'
      ? join(process.env['HOME'] ?? '.', 'Library', 'Application Support')
      : join(process.env['HOME'] ?? '.', '.config'))
  return join(appData, 'Ava', INDEX_FILENAME)
}

/** Load the index from disk, or return an empty one. */
export async function loadIndex(): Promise<TfIdfIndex> {
  const path = indexPath()
  if (!existsSync(path)) return new TfIdfIndex()
  try {
    const raw = await readFile(path, 'utf-8')
    const data: SerializedIndex = JSON.parse(raw)
    return TfIdfIndex.deserialize(data)
  } catch (err) {
    console.error('[knowledge] failed to load index, starting fresh:', err)
    return new TfIdfIndex()
  }
}

/** Save the index to disk. Uses atomic write (tmp → rename). */
export async function saveIndex(index: TfIdfIndex): Promise<void> {
  const path = indexPath()
  const dir = dirname(path)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  const data = index.serialize()
  const json = JSON.stringify(data)
  const tmp = `${path}.tmp`
  await writeFile(tmp, json, 'utf-8')
  // Atomic rename
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}
