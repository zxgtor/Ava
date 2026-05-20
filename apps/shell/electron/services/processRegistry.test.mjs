import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./processRegistry.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-process-registry-'))
const compiledPath = join(tempDir, 'processRegistry.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const { ProcessRegistry } = await import(pathToFileURL(compiledPath).href)

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('tracks a background process until it exits and preserves output', async () => {
  const registry = new ProcessRegistry()
  const started = registry.start({
    command: process.execPath,
    args: ['-e', "setTimeout(() => console.log('ava-process-ok'), 50)"],
    cwd: process.cwd(),
  })

  assert.equal(started.status, 'running')
  assert.match(started.id, /^proc_/)

  const waited = await registry.wait(started.id, 2_000)
  assert.ok(waited)
  assert.equal(waited.status, 'exited')
  assert.equal(waited.exitCode, 0)
  assert.match(waited.stdout, /ava-process-ok/)
})

test('kill marks a running process as killed', async () => {
  const registry = new ProcessRegistry()
  const started = registry.start({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10_000)'],
    cwd: process.cwd(),
  })

  const killed = registry.kill(started.id)
  assert.ok(killed)
  assert.equal(killed.status, 'killed')
})
