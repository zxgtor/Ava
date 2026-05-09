/**
 * Find the first balanced top-level JSON object in `text` and return it parsed.
 * Handles fenced ```json blocks, nested braces, and braces inside string literals.
 * Returns null if no parseable balanced object is found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = matchFencedJson(text)
  if (fenced) {
    const parsed = tryParse(fenced)
    if (parsed) return parsed
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start)
    if (end === -1) return null
    const parsed = tryParse(text.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}

function matchFencedJson(text: string): string | null {
  const re = /```(?:json)?\s*([\s\S]*?)\s*```/i
  const m = text.match(re)
  return m ? m[1].trim() : null
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
