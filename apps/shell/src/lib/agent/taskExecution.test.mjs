import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./taskExecution.ts', import.meta.url)
let source = await readFile(sourcePath, 'utf8')
// Strip imports that pull in DOM/window-dependent modules; the helpers under
// test do not use them at runtime.
source = source.replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/chat['"];?/g, '')
source = source.replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/roles\/planner['"];?/g, '')
source = source.replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/runtime\/taskGraph['"];?/g, '')
// Stub functions that the stripped imports provided. nextTaskStep is not used
// by the helpers we test, but it is referenced elsewhere in the file.
source += `
function planningContextBudgetForProviders() { return 0 }
class TaskGraph { constructor(p){this.p=p} getNextStep(){ return null } }
async function runAnalyzePhase(){ return null }
async function runPlanPhase(){ return null }
`

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-task-exec-'))
const compiledPath = join(tempDir, 'taskExecution.mjs')
// Stub the toolNames import so the real file resolves.
await writeFile(join(tempDir, 'toolNames.mjs'), 'export function normalizeRequiredTools(x){ return x }', 'utf8')
// Rewrite the toolNames import path in compiled output to local stub.
const patched = compiled.replace(/from\s+['"]\.\/toolNames['"]/g, "from './toolNames.mjs'")
await writeFile(compiledPath, patched, 'utf8')

const { evaluateStepCompletion, finalValidationGateSatisfied } =
  await import(pathToFileURL(compiledPath).href)

test.after(async () => { await rm(tempDir, { recursive: true, force: true }) })

function step(overrides = {}) {
  return {
    id: 's',
    title: 't',
    status: 'running',
    requiredTools: [],
    completionSignals: [],
    attempts: 1,
    ...overrides,
  }
}

function plan(overrides = {}) {
  return {
    taskId: 't',
    status: 'running',
    goal: 'g',
    workingDirectory: 'D:\\x',
    kind: 'coding-design',
    steps: [],
    validation: { devServerChecked: false, consoleChecked: false, screenshotChecked: false, buildChecked: false },
    createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

test('repair role completes immediately on first attempt (reactive only)', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'whatever', role: 'repair' }),
    parts: [],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('validate role with failed project.validate triggers needsRepair', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'arbitrary_id', role: 'validate', attempts: 1 }),
    parts: [
      { type: 'tool_call', name: 'project.validate', status: 'error', args: {}, error: 'tsc failed: TS2322 line 12' },
    ],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.match(result.needsRepair, /TS2322/)
})

test('validate role with successful project.validate completes', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'verify', role: 'validate' }),
    parts: [{ type: 'tool_call', name: 'project.validate', status: 'ok', args: {}, result: { ok: true } }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('final_report role blocks when applicable checks not satisfied', () => {
  const planWithChecks = plan({
    steps: [
      { id: 'a', role: 'console', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'b', role: 'validate', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
    ],
  })
  const result = evaluateStepCompletion({
    plan: planWithChecks,
    step: step({ id: 'wrap', role: 'final_report' }),
    parts: [],
    fullContent: 'Done.',
  })
  assert.equal(result.complete, false)
  assert.match(result.blocked, /console|validation/i)
})

test('final_report role passes when no preview/console/validate steps exist (backend task)', () => {
  const backendPlan = plan({
    steps: [
      { id: 'inspect', role: 'inspect', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'write', role: 'feature', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
    ],
  })
  const result = evaluateStepCompletion({
    plan: backendPlan,
    step: step({ id: 'final', role: 'final_report' }),
    parts: [],
    fullContent: 'All done — wrote 3 files.',
  })
  assert.equal(result.complete, true)
})

test('finalValidationGateSatisfied is true when no checks are applicable', () => {
  const backendPlan = plan({
    steps: [{ id: 'a', role: 'feature', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 }],
  })
  assert.equal(finalValidationGateSatisfied(backendPlan.validation, backendPlan), true)
})

test('finalValidationGateSatisfied requires console+screenshot+build when those steps exist', () => {
  const fullPlan = plan({
    steps: [
      { id: 'p', role: 'preview', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'c', role: 'console', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 's', role: 'screenshot', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'v', role: 'validate', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
    ],
  })
  assert.equal(finalValidationGateSatisfied(fullPlan.validation, fullPlan), false)
  fullPlan.validation.consoleChecked = true
  fullPlan.validation.screenshotChecked = true
  fullPlan.validation.buildChecked = true
  assert.equal(finalValidationGateSatisfied(fullPlan.validation, fullPlan), true)
})

test('generic step with required tool completes when that tool succeeds', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'x', requiredTools: ['file.write_text'] }),
    parts: [{ type: 'tool_call', name: 'file.write_text', status: 'ok', args: {}, result: {} }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('legacy static-plan step.id="repair" still routes via stepRole fallback', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'repair' /* no role */ }),
    parts: [],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})
