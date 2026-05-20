import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./toolRuntime.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-tool-runtime-'))
const compiledPath = join(tempDir, 'toolRuntime.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const { ToolRuntime } = await import(pathToFileURL(compiledPath).href)

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('dedupes resolved tool call ids per stream', () => {
  const runtime = new ToolRuntime()
  assert.equal(runtime.hasResolvedToolCall('s1', 'call_1'), false)
  runtime.rememberResolvedToolCall('s1', 'call_1')
  assert.equal(runtime.hasResolvedToolCall('s1', 'call_1'), true)
  assert.equal(runtime.hasResolvedToolCall('s2', 'call_1'), false)
})

test('emits structured event alongside legacy status event', () => {
  const sent = []
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  }
  const runtime = new ToolRuntime()
  runtime.sendTextDelta(webContents, { streamId: 's1', activeTaskId: 't1' }, 'hello')

  assert.deepEqual(sent.map(item => item.channel), ['ava:llm:chunk', 'ava:llm:event'])
  assert.equal(sent[1].payload.type, 'text_delta')
  assert.equal(sent[1].payload.text, 'hello')
})
