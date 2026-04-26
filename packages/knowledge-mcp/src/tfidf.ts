// ─────────────────────────────────────────────────────────────
// TF-IDF Search Engine
// Pure Node.js, CJK-aware tokenizer, cosine similarity ranking.
// ─────────────────────────────────────────────────────────────

/** A chunk of text with metadata about its origin. */
export interface Chunk {
  id: string
  sourceId: string
  sourcePath: string
  text: string
  offset: number
}

/** A search result with score and matched chunk. */
export interface SearchResult {
  chunk: Chunk
  score: number
}

// ── Tokenizer ─────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'of', 'in', 'to',
  'for', 'with', 'on', 'at', 'from', 'by', 'about', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'while', 'where', 'how',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'them', 'we', 'you', 'i', 'me',
  'my', 'your', 'his', 'her', 'our', 'their',
  // Common CJK particles
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
  '都', '一', '个', '上', '也', '很', '到', '说', '要', '去',
  '你', '会', '着', '没', '那', '这', '她', '他',
])

/**
 * Tokenize text into lowercase terms.
 * - Splits on whitespace and punctuation.
 * - Splits CJK characters into individual tokens (unigrams).
 * - Filters stopwords and single-char Latin tokens.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  // Replace punctuation with spaces, lowercase
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  // Split into runs of characters
  const parts = cleaned.split(/\s+/).filter(Boolean)

  for (const part of parts) {
    // Check for CJK characters
    const cjkRanges = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
    if (cjkRanges.test(part)) {
      // Split CJK into individual characters, keep Latin runs intact
      let latin = ''
      for (const char of part) {
        if (cjkRanges.test(char)) {
          if (latin) {
            if (latin.length > 1 && !STOP_WORDS.has(latin)) tokens.push(latin)
            latin = ''
          }
          if (!STOP_WORDS.has(char)) tokens.push(char)
        } else {
          latin += char
        }
      }
      if (latin.length > 1 && !STOP_WORDS.has(latin)) tokens.push(latin)
    } else {
      if (part.length > 1 && !STOP_WORDS.has(part)) {
        tokens.push(part)
      }
    }
  }
  return tokens
}

// ── TF-IDF Index ──────────────────────────────────────────────

/** Term frequency map: term → count */
type TfMap = Map<string, number>

interface IndexedDoc {
  chunk: Chunk
  tf: TfMap
  magnitude: number
}

export class TfIdfIndex {
  private docs: IndexedDoc[] = []
  /** Document frequency: term → number of docs containing it */
  private df = new Map<string, number>()
  private dirty = false

  get size(): number {
    return this.docs.length
  }

  /** Add a chunk to the index. */
  add(chunk: Chunk): void {
    const tokens = tokenize(chunk.text)
    const tf: TfMap = new Map()
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1)
    }
    // Update DF
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }
    this.docs.push({ chunk, tf, magnitude: 0 })
    this.dirty = true
  }

  /** Remove all chunks belonging to a source. */
  removeSource(sourceId: string): number {
    const before = this.docs.length
    const removed = this.docs.filter(d => d.chunk.sourceId === sourceId)
    if (removed.length === 0) return 0
    // Update DF
    for (const doc of removed) {
      for (const term of doc.tf.keys()) {
        const current = this.df.get(term) ?? 0
        if (current <= 1) this.df.delete(term)
        else this.df.set(term, current - 1)
      }
    }
    this.docs = this.docs.filter(d => d.chunk.sourceId !== sourceId)
    this.dirty = true
    return before - this.docs.length
  }

  /** Get unique source IDs. */
  sources(): Array<{ sourceId: string; sourcePath: string; chunkCount: number }> {
    const map = new Map<string, { sourcePath: string; count: number }>()
    for (const doc of this.docs) {
      const entry = map.get(doc.chunk.sourceId)
      if (entry) {
        entry.count += 1
      } else {
        map.set(doc.chunk.sourceId, { sourcePath: doc.chunk.sourcePath, count: 1 })
      }
    }
    return Array.from(map.entries()).map(([sourceId, { sourcePath, count }]) => ({
      sourceId,
      sourcePath,
      chunkCount: count,
    }))
  }

  /** Search for the most relevant chunks. */
  search(query: string, limit = 5): SearchResult[] {
    if (this.docs.length === 0) return []
    if (this.dirty) this.recomputeMagnitudes()

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const queryTf: TfMap = new Map()
    for (const t of queryTokens) {
      queryTf.set(t, (queryTf.get(t) ?? 0) + 1)
    }

    const N = this.docs.length
    // Compute query TF-IDF vector magnitude
    let queryMag = 0
    const queryWeights = new Map<string, number>()
    for (const [term, count] of queryTf) {
      const dfVal = this.df.get(term) ?? 0
      if (dfVal === 0) continue
      const idf = Math.log(N / dfVal)
      const w = count * idf
      queryWeights.set(term, w)
      queryMag += w * w
    }
    queryMag = Math.sqrt(queryMag)
    if (queryMag === 0) return []

    // Score each document
    const scored: SearchResult[] = []
    for (const doc of this.docs) {
      let dot = 0
      for (const [term, qw] of queryWeights) {
        const dtf = doc.tf.get(term)
        if (!dtf) continue
        const idf = Math.log(N / (this.df.get(term) ?? 1))
        dot += qw * dtf * idf
      }
      if (dot === 0) continue
      const score = dot / (queryMag * (doc.magnitude || 1))
      scored.push({ chunk: doc.chunk, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  // ── Serialization ───────────────────────────────────────────

  serialize(): SerializedIndex {
    return {
      docs: this.docs.map(d => ({
        chunk: d.chunk,
        tf: Object.fromEntries(d.tf),
      })),
      df: Object.fromEntries(this.df),
    }
  }

  static deserialize(data: SerializedIndex): TfIdfIndex {
    const index = new TfIdfIndex()
    index.df = new Map(Object.entries(data.df))
    index.docs = data.docs.map(d => ({
      chunk: d.chunk,
      tf: new Map(Object.entries(d.tf)),
      magnitude: 0,
    }))
    index.dirty = true
    return index
  }

  // ── Internal ────────────────────────────────────────────────

  private recomputeMagnitudes(): void {
    const N = this.docs.length
    for (const doc of this.docs) {
      let mag = 0
      for (const [term, count] of doc.tf) {
        const idf = Math.log(N / (this.df.get(term) ?? 1))
        const w = count * idf
        mag += w * w
      }
      doc.magnitude = Math.sqrt(mag)
    }
    this.dirty = false
  }
}

export interface SerializedIndex {
  docs: Array<{ chunk: Chunk; tf: Record<string, number> }>
  df: Record<string, number>
}
