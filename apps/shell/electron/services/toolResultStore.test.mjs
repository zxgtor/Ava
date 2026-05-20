import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./toolResultStore.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-tool-result-store-'))
const originalAppData = process.env.APPDATA
const compiledPath = join(tempDir, 'toolResultStore.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const { compactToolResultForContext } = await import(pathToFileURL(compiledPath).href)

test.after(async () => {
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  await rm(tempDir, { recursive: true, force: true })
})

test('marks empty tool output explicitly', async () => {
  const result = await compactToolResultForContext('', {
    activeFolderPath: tempDir,
    streamId: 'stream-empty',
    toolCallId: 'tool-empty',
    toolName: 'shell.run_command',
  })

  assert.equal(result.compacted, false)
  assert.deepEqual(result.content, { message: '(tool completed with no output)' })
})

test('persists large tool output and leaves a compact context result', async () => {
  const stdout = 'x'.repeat(40_000)
  const result = await compactToolResultForContext({
    command: 'npm',
    args: ['run', 'build'],
    exitCode: 0,
    stdout,
    stderr: '',
  }, {
    activeFolderPath: tempDir,
    streamId: 'stream-large',
    toolCallId: 'tool-large',
    toolName: 'shell.run_command',
  })

  assert.equal(result.compacted, true)
  assert.ok(result.persistedOutput?.path)
  assert.equal((await stat(result.persistedOutput.path)).isFile(), true)
  const content = result.content
  assert.equal(typeof content, 'object')
  assert.equal(content.persistedOutput.path, result.persistedOutput.path)
  assert.equal(content.stdoutTruncated, true)
  assert.ok(content.stdout.length < stdout.length)
})

test('compacts nested large strings instead of reinjecting them into context', async () => {
  const nestedLog = 'nested-log-'.repeat(5_000)
  const result = await compactToolResultForContext({
    command: 'node',
    nested: {
      logs: {
        stdout: nestedLog,
      },
    },
  }, {
    activeFolderPath: tempDir,
    streamId: 'stream-nested',
    toolCallId: 'tool-nested',
    toolName: 'shell.run_command',
  })

  assert.equal(result.compacted, true)
  const text = JSON.stringify(result.content)
  assert.equal(text.includes(nestedLog), false)
  assert.ok(text.length < 20_000)
  assert.ok(result.persistedOutput?.path)
})

test('stores persisted tool results in app data instead of active project when app data is available', async () => {
  const projectDir = await mkdtemp(join(tempDir, 'project-'))
  const appDataDir = await mkdtemp(join(tempDir, 'appdata-'))
  process.env.APPDATA = appDataDir

  const result = await compactToolResultForContext({
    stdout: 'x'.repeat(40_000),
  }, {
    activeFolderPath: projectDir,
    streamId: 'stream-appdata',
    toolCallId: 'tool-appdata',
    toolName: 'shell.run_command',
  })

  assert.equal(result.compacted, true)
  assert.ok(result.persistedOutput?.path.startsWith(appDataDir))
  assert.equal(existsSync(join(projectDir, '.ava', 'tool-results')), false)
})
