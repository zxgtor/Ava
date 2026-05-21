import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./capabilityRouter.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-cap-router-'))
const compiledPath = join(tempDir, 'capabilityRouter.mjs')
await writeFile(compiledPath, compiled, 'utf8')
const { buildCapabilityIndex, routeMcpTools, routeSkills } = await import(pathToFileURL(compiledPath).href)

test.after(async () => { await rm(tempDir, { recursive: true, force: true }) })

function skill(name, text, tags = []) {
  return {
    pluginId: `plugin-${name}`,
    pluginName: `Plugin ${name}`,
    name,
    sourcePath: `D:\\skills\\${name}\\SKILL.md`,
    summary: text,
    tags,
    contentPreview: text,
    truncated: false,
  }
}

test('buildCapabilityIndex combines tools and skills', () => {
  const index = buildCapabilityIndex({
    builtInTools: [{ rawName: 'file.write_text', name: 'file.write_text', description: 'Write file', inputSchema: {} }],
    mcpTools: [{ rawName: 'search', name: 'remote.search', description: 'Search remote docs', inputSchema: {} }],
    skills: [skill('frontend', 'Build React UI components', ['react', 'ui'])],
  })
  assert.equal(index.length, 3)
  assert.deepEqual(index.map(item => item.kind), ['built_in_tool', 'mcp_tool', 'skill'])
})

test('routeSkills selects relevant skills instead of all installed skills', () => {
  const skills = [
    skill('frontend-skill', 'Build polished React Vite frontend UI with CSS and components', ['react', 'vite', 'frontend']),
    skill('pdf', 'Read and edit PDF documents', ['pdf', 'document']),
    skill('telegram', 'Download Telegram channel media', ['telegram']),
  ]
  const selected = routeSkills(skills, {
    currentTask: 'Create a professional React Vite 3D GLB viewer site with UI controls',
    activeStepRole: 'feature',
    activeStepRequiredTools: ['file.write_text', 'file.patch'],
    maxSkills: 2,
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].item.name, 'frontend-skill')
})

test('routeSkills respects maxSkills and ignores weak matches', () => {
  const skills = Array.from({ length: 200 }, (_, index) =>
    skill(`unrelated-${index}`, 'Archive bookkeeping and unrelated notes', ['archive']))
  skills.push(skill('debugger', 'Diagnose TypeScript build errors and repair failing files', ['debug', 'typescript', 'build']))
  const selected = routeSkills(skills, {
    currentTask: 'Validation failed with TS6133 in src/App.tsx. Repair the TypeScript build.',
    activeStepRole: 'repair',
    maxSkills: 3,
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].item.name, 'debugger')
})

test('routeSkills returns no skills for final report', () => {
  const selected = routeSkills([
    skill('summary', 'Write final reports and summaries', ['summary']),
  ], {
    currentTask: 'Write final report',
    activeStepRole: 'final_report',
    maxSkills: 0,
  })
  assert.equal(selected.length, 0)
})

test('routeMcpTools selects relevant MCP tools and respects maxMcpTools', () => {
  const tools = [
    { rawName: 'query', name: 'db.query', description: 'Run SQL database queries', inputSchema: {} },
    { rawName: 'search_docs', name: 'docs.search_docs', description: 'Search API documentation and examples', inputSchema: {} },
    { rawName: 'send', name: 'email.send', description: 'Send email messages', inputSchema: {} },
  ]
  const selected = routeMcpTools(tools, {
    currentTask: 'Search the API documentation for Vite preview examples',
    activeStepRole: 'inspect',
    maxMcpTools: 1,
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].item.name, 'docs.search_docs')
})

test('routeMcpTools keeps explicitly required MCP tool', () => {
  const tools = [
    { rawName: 'send', name: 'email.send', description: 'Send email messages', inputSchema: {} },
  ]
  const selected = routeMcpTools(tools, {
    currentTask: 'Validate project',
    activeStepRole: 'validate',
    activeStepRequiredTools: ['email.send'],
    maxMcpTools: 1,
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].item.name, 'email.send')
  assert.match(selected[0].reasons.join(','), /required-tool/)
})
