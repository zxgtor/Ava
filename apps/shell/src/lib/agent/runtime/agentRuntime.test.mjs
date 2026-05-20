import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./agentRuntime.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-agent-runtime-'))
const compiledPath = join(tempDir, 'agentRuntime.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const {
  shouldContinueAfterToolLimit,
  successfulWriteProgress,
  toolProgressContinuationText,
} = await import(pathToFileURL(compiledPath).href)

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('continues after tool limit when a write-heavy step made file progress', () => {
  const parts = [
    { type: 'tool_call', name: 'file.write_text', status: 'ok', args: {}, result: {} },
  ]

  assert.equal(successfulWriteProgress(parts), 1)
  assert.equal(shouldContinueAfterToolLimit(parts, { role: 'feature' }), true)
  assert.match(toolProgressContinuationText('Write files', parts), /Successful file edits this round: 1/)
})

test('does not continue after tool limit without successful writes', () => {
  const parts = [
    { type: 'tool_call', name: 'file.read_text', status: 'ok', args: {}, result: {} },
  ]

  assert.equal(shouldContinueAfterToolLimit(parts, { role: 'feature' }), false)
})
