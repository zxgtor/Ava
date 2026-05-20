import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./toolErrorClassifier.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-tool-error-'))
const compiledPath = join(tempDir, 'toolErrorClassifier.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const { classifyToolError } = await import(pathToFileURL(compiledPath).href)

test.after(async () => { await rm(tempDir, { recursive: true, force: true }) })

test('classifies missing directories with path recovery context', () => {
  const result = classifyToolError('Project directory "D:\\Apps\\glbviewer" does not exist yet.')
  assert.equal(result.kind, 'missing_dir')
  assert.equal(result.path, 'D:\\Apps\\glbviewer')
  assert.match(result.recoveryHint, /file\.create_dir/)
})

test('classifies permission scope as user-confirmable blocker', () => {
  const result = classifyToolError('Working directory "D:\\Apps" is outside the active project or allowed directories.')
  assert.equal(result.kind, 'permission_scope')
  assert.match(result.recoveryHint, /Ask the user/)
})

test('classifies unknown tool names', () => {
  const result = classifyToolError('unknown tool: file_read_multiple_files')
  assert.equal(result.kind, 'unknown_tool')
  assert.match(result.recoveryHint, /exposed Ava tool names/)
})
