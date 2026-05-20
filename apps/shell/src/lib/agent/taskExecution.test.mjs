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

const { evaluateStepCompletion, extractWorkingDirectoryFromText, finalValidationGateSatisfied, recoverStepFromRound, taskStepRecovery } =
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

test('repair role requires an actual repair tool call', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'repair', role: 'repair', requiredTools: ['file.write_text', 'file.patch'] }),
    parts: [],
    fullContent: '',
  })
  assert.equal(result.complete, false)
})

test('extractWorkingDirectoryFromText trims trailing question punctuation', () => {
  assert.equal(extractWorkingDirectoryFromText('Use D:\\apps\\GLBViewer?'), 'D:\\apps\\GLBViewer')
})

test('repair role completes after a file edit tool succeeds', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'repair', role: 'repair', requiredTools: ['file.write_text', 'file.patch'] }),
    parts: [{ type: 'tool_call', name: 'file.write_text', args: {}, status: 'ok', result: {} }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('feature write step does not complete after a single file write without verification evidence', () => {
  const result = evaluateStepCompletion({
    plan: plan({
      steps: [step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] })],
    }),
    step: step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] }),
    parts: [{ type: 'tool_call', name: 'file.write_text', args: { path: 'D:\\x\\src\\App.tsx' }, status: 'ok', result: { bytes: 100 } }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
})

test('feature write step completes after edit evidence and project verification evidence', () => {
  const result = evaluateStepCompletion({
    plan: plan({
      steps: [step({
        id: 'write_core_files',
        role: 'feature',
        requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'],
        evidence: [
          { toolName: 'file.write_text', toolCallId: 'call_write', status: 'ok', timestamp: 1 },
          { toolName: 'project.map', toolCallId: 'call_map', status: 'ok', timestamp: 2 },
        ],
      })],
    }),
    step: step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] }),
    parts: [{ type: 'tool_call', name: 'project.map', args: { path: 'D:\\x' }, status: 'ok', result: { files: ['src/App.tsx'] } }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('ignored duplicate tool result does not satisfy step completion', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'x', requiredTools: ['file.write_text'] }),
    parts: [{
      type: 'tool_call',
      name: 'file.write_text',
      status: 'ok',
      args: {},
      result: { ignored: true, reason: 'duplicate' },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
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

test('setup scaffold step does not complete on shell success without package.json evidence', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'init_project',
      title: 'Initialize project',
      role: 'scaffold',
      requiredTools: ['shell.run_command'],
    }),
    parts: [
      { type: 'tool_call', name: 'shell.run_command', status: 'ok', args: { command: 'npx', args: ['create', 'vite@latest', '.'] }, result: { exitCode: 0 } },
    ],
    fullContent: '',
  })
  assert.equal(result.complete, false)
})

test('setup scaffold step completes when package.json was written', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'init_project',
      title: 'Initialize project',
      role: 'scaffold',
      requiredTools: ['shell.run_command', 'file.write_text'],
    }),
    parts: [
      { type: 'tool_call', name: 'file.write_text', status: 'ok', args: { path: 'D:\\x\\package.json' }, result: { bytes: 20 } },
    ],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('plain directory scaffold step can complete on file.create_dir', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'create_app_structure',
      title: 'Create app structure',
      role: 'scaffold',
      requiredTools: ['file.create_dir'],
    }),
    parts: [
      { type: 'tool_call', name: 'file.create_dir', status: 'ok', args: { path: 'D:\\x\\src' }, result: {} },
    ],
    fullContent: '',
  })
  assert.equal(result.complete, true)
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

test('step requiring process.wait does not complete on process.start alone', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'install', requiredTools: ['process.start', 'process.wait'] }),
    parts: [{ type: 'tool_call', name: 'process.start', status: 'ok', args: {}, result: { processId: 'proc_1', status: 'running' } }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
})

test('step requiring process.wait completes when process exits successfully', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'install', requiredTools: ['process.start', 'process.wait'] }),
    parts: [{ type: 'tool_call', name: 'process.wait', status: 'ok', args: { id: 'proc_1' }, result: { id: 'proc_1', status: 'exited', exitCode: 0 } }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('taskStepRecovery captures process id and command summary', () => {
  const recovery = taskStepRecovery([
    { type: 'tool_call', name: 'process.start', status: 'ok', args: { command: 'npm', args: ['install'] }, result: { processId: 'proc_abc', status: 'running' } },
  ], '')
  assert.ok(recovery)
  assert.equal(recovery.processId, 'proc_abc')
  assert.equal(recovery.command, 'npm install')
})

test('recoverStepFromRound persists tool evidence for task memory', () => {
  const inputPlan = plan({
    steps: [step({ id: 'install', status: 'running' })],
    currentStepId: 'install',
  })
  const next = recoverStepFromRound(inputPlan, 'install', [
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npm', args: ['install'] },
      result: {
        exitCode: 0,
        persistedOutput: { path: 'D:\\x\\.ava\\tool-results\\install.json' },
      },
      endedAt: 123,
    },
  ], '')
  const evidence = next.steps[0].evidence
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].toolCallId, 'call_1')
  assert.equal(evidence[0].command, 'npm install')
  assert.equal(evidence[0].exitCode, 0)
  assert.match(evidence[0].persistedOutputPath, /install\.json/)
})

test('legacy static-plan step.id="repair" still requires an actual repair action', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'repair' /* no role */, requiredTools: ['file.patch'] }),
    parts: [{ type: 'tool_call', name: 'file.patch', status: 'ok', args: {}, result: {} }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})
