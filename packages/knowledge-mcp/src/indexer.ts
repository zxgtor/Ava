// ─────────────────────────────────────────────────────────────
// File Indexer
// Reads files, splits into overlapping chunks, feeds TF-IDF.
// ─────────────────────────────────────────────────────────────

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, extname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { Chunk } from './tfidf.js'

const CHUNK_SIZE = 500        // characters per chunk
const CHUNK_OVERLAP = 80      // overlap between adjacent chunks
const MAX_FILE_SIZE = 1_000_000  // 1 MB — skip larger files
const MAX_FILES = 5_000       // safety limit per ingest call

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.css', '.html', '.htm', '.yaml', '.yml', '.toml', '.xml',
  '.csv', '.log', '.sh', '.bat', '.ps1', '.sql', '.rs', '.go',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.swift', '.kt', '.scala', '.r', '.m', '.mm',
])

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.next',
  '.nuxt', 'dist', 'build', 'out', '.vscode', '.idea', '.DS_Store',
  'vendor', 'venv', '.venv', 'env', '.env',
])

/** Generate a stable source ID from a path. */
export function makeSourceId(filePath: string): string {
  const abs = resolve(filePath)
  return createHash('sha256').update(abs).digest('hex').slice(0, 12)
}

/** Split text into overlapping chunks. */
export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chunkSize) return [text]
  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + chunkSize))
    offset += chunkSize - overlap
  }
  return chunks
}

/** Read a single file and return chunks. */
export async function indexFile(filePath: string): Promise<Chunk[]> {
  const abs = resolve(filePath)
  const ext = extname(abs).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext)) return []

  const info = await stat(abs)
  if (!info.isFile() || info.size > MAX_FILE_SIZE || info.size === 0) return []

  const content = await readFile(abs, 'utf-8')
  const sourceId = makeSourceId(abs)
  const texts = chunkText(content)

  return texts.map((text, i) => ({
    id: `${sourceId}-${i}`,
    sourceId,
    sourcePath: abs,
    text,
    offset: i * (CHUNK_SIZE - CHUNK_OVERLAP),
  }))
}

/** Recursively read a directory and return chunks for all supported files. */
export async function indexDirectory(dirPath: string): Promise<{ chunks: Chunk[]; fileCount: number }> {
  const abs = resolve(dirPath)
  const chunks: Chunk[] = []
  let fileCount = 0

  async function walk(dir: string): Promise<void> {
    if (fileCount >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(full)
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue
        try {
          const fileChunks = await indexFile(full)
          if (fileChunks.length > 0) {
            chunks.push(...fileChunks)
            fileCount += 1
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(abs)
  return { chunks, fileCount }
}

/** Determine if a path is a file or directory and index accordingly. */
export async function indexPath(targetPath: string): Promise<{
  chunks: Chunk[]
  fileCount: number
  isDirectory: boolean
}> {
  const abs = resolve(targetPath)
  const info = await stat(abs)
  if (info.isDirectory()) {
    const result = await indexDirectory(abs)
    return { ...result, isDirectory: true }
  } else {
    const chunks = await indexFile(abs)
    return { chunks, fileCount: chunks.length > 0 ? 1 : 0, isDirectory: false }
  }
}
