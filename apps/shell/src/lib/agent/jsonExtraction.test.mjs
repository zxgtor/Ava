import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./jsonExtraction.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const tempDir = await mkdtemp(join(tmpdir(), 'ava-json-extract-'))
const compiledPath = join(tempDir, 'jsonExtraction.mjs')
await writeFile(compiledPath, compiled, 'utf8')
const { extractJsonObject } = await import(pathToFileURL(compiledPath).href)
test.after(async () => { await rm(tempDir, { recursive: true, force: true }) })

test('extracts a fenced json block', () => {
  const out = extractJsonObject('Here you go:\n```json\n{ "a": 1 }\n```\nthanks.')
  assert.deepEqual(out, { a: 1 })
})

test('extracts json with nested braces from a fenced block', () => {
  const out = extractJsonObject('```json\n{ "a": { "b": 2 }, "c": [1,2] }\n```')
  assert.deepEqual(out, { a: { b: 2 }, c: [1, 2] })
})

test('extracts the FIRST balanced top-level json from prose with multiple objects', () => {
  const out = extractJsonObject('Plan: { "steps": [{ "id": "x" }] } and also { "garbage": 1 }')
  assert.deepEqual(out, { steps: [{ id: 'x' }] })
})

test('ignores braces that appear inside json strings', () => {
  const out = extractJsonObject('result = { "a": "}{}", "b": 2 }')
  assert.deepEqual(out, { a: '}{}', b: 2 })
})

test('returns null when no balanced object is present', () => {
  assert.equal(extractJsonObject('no json here, just words'), null)
})

test('returns null on truncated json', () => {
  assert.equal(extractJsonObject('{ "a": 1, "b": '), null)
})
