import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./llm.ts', import.meta.url)
let source = await readFile(sourcePath, 'utf8')
source = source.replace(/import[\s\S]*?from ['"]electron['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/mcpSupervisor['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/pluginManager['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/toolAuditLog['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/builtInTools['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/runtimeEnvironment['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/adapters\/openai['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/adapters\/anthropic['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/adapters\/base['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/toolErrorClassifier['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/toolResultStore['"];?\n/g, '')
source = source.replace(/import[\s\S]*?from ['"]\.\/services\/toolRuntime['"];?\n/g, '')
source += `
const mcpSupervisor = {};
const pluginManager = {};
const toolAuditLog = {};
const builtInTools = {};
const toolRuntime = {};
function runtimeEnvironmentPrompt(){ return '' }
function classifyToolError(error){ return { kind: 'unknown', message: String(error), recoveryHint: '' } }
async function compactToolResultForContext(content){ return { content, compacted: false } }
class OpenAiAdapter {}
class AnthropicAdapter {}
`

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-llm-parser-'))
const compiledPath = join(tempDir, 'llm-parser.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const { hasUnterminatedToolCallMarkup, parseHermesToolCalls, stripResidualToolMarkup } = await import(pathToFileURL(compiledPath).href)

test.after(async () => { await rm(tempDir, { recursive: true, force: true }) })

test('parses unterminated XML function tool call and removes it from visible text', () => {
  const raw = [
    'Fixing file now.',
    '<tool_call> <function=file_write_text> <parameter=path>',
    'D:\\Apps\\GLBViewer2\\src\\components\\GLBViewer.tsx',
    '</parameter> <parameter=content>export default function GLBViewer(){ return null }',
  ].join('\n')
  const parsed = parseHermesToolCalls(raw)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].name, 'file_write_text')
  assert.match(String(parsed.toolCalls[0].args.path), /GLBViewer\.tsx/)
  assert.equal(parsed.visibleText, 'Fixing file now.')
})

test('stripResidualToolMarkup removes unterminated tool markup', () => {
  const stripped = stripResidualToolMarkup('Hello\n<tool_call><function=file_write_text><parameter=path>x')
  assert.equal(stripped, 'Hello')
})

test('parses bracket command tool call with JSON array args', () => {
  const raw = [
    '请允许我执行这些操作。',
    '',
    '[process.start command="npx" args=["--yes","create-vite@latest","GLBViewer2","--template","react-ts"]]',
  ].join('\n')
  const parsed = parseHermesToolCalls(raw)
  assert.equal(parsed.visibleText, '请允许我执行这些操作。')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].name, 'process.start')
  assert.equal(parsed.toolCalls[0].args.command, 'npx')
  assert.deepEqual(parsed.toolCalls[0].args.args, ['--yes', 'create-vite@latest', 'GLBViewer2', '--template', 'react-ts'])
})

test('stripResidualToolMarkup removes complete and incomplete bracket tool markup', () => {
  assert.equal(
    stripResidualToolMarkup('Before\n[process.start command="npx" args=["--yes"]]\nAfter'),
    'Before\n\nAfter',
  )
  assert.equal(
    stripResidualToolMarkup('Before\n[file.write_text path="D:\\x\\a.ts" content="unterminated'),
    'Before',
  )
})

test('detects unterminated XML tool calls for retry instead of execution', () => {
  assert.equal(hasUnterminatedToolCallMarkup('<tool_call><function=file_write_text><parameter=path>x'), true)
  assert.equal(
    hasUnterminatedToolCallMarkup('<tool_call><function=file_write_text><parameter=path>x</parameter></function></tool_call>'),
    false,
  )
})

test('detects and strips incomplete tool_code markup', () => {
  assert.equal(hasUnterminatedToolCallMarkup('Let me inspect\n<tool_code> <tool_code>'), true)
  assert.equal(stripResidualToolMarkup('Let me inspect\n<tool_code> <tool_code>'), 'Let me inspect')
})
