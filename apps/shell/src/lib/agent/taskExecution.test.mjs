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
source = source.replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/runtime\/taskGraph['"];?/g, '')
// Stub functions that the stripped imports provided. nextTaskStep is not used
// by the helpers we test, but it is referenced elsewhere in the file.
source += `
class TaskGraph { constructor(p){this.p=p} getNextStep(){ return null } }
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

const { evaluateStepCompletion, extractWorkingDirectoryFromText, finalValidationGateSatisfied, normalizeTaskExecutionPlan, recoverStepFromRound, taskStepRecovery, updatePlanValidation, updateValidationProgressState } =
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

test('feature write step does not complete after a file write without durable write evidence', () => {
  const result = evaluateStepCompletion({
    plan: plan({
      steps: [step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] })],
    }),
    step: step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] }),
    parts: [{ type: 'tool_call', name: 'file.write_text', args: { path: 'D:\\x\\src\\App.tsx' }, status: 'ok', result: {} }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
})

test('feature write step completes after durable file write result', () => {
  const result = evaluateStepCompletion({
    plan: plan({
      steps: [step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] })],
    }),
    step: step({ id: 'write_core_files', role: 'feature', requiredTools: ['file.write_text', 'file.patch', 'project.map', 'file.stat'] }),
    parts: [{ type: 'tool_call', name: 'file.write_text', args: { path: 'D:\\x\\src\\App.tsx' }, status: 'ok', result: { path: 'D:\\x\\src\\App.tsx', bytes: 100 } }],
    fullContent: '',
  })
  assert.equal(result.complete, true)
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

test('feature read-only stall routes to repair instead of blocking', () => {
  const result = evaluateStepCompletion({
    plan: plan({
      steps: [step({
        id: 'implement_main_entry',
        title: 'Update Main Entry Point (App.tsx, index.css)',
        role: 'feature',
        requiredTools: ['file.write_text', 'file.read_text'],
        attempts: 1,
        evidence: [
          { toolName: 'file.list_dir', toolCallId: 'call_list', status: 'ok', timestamp: 1 },
        ],
      })],
    }),
    step: step({
      id: 'implement_main_entry',
      title: 'Update Main Entry Point (App.tsx, index.css)',
      role: 'feature',
      requiredTools: ['file.write_text', 'file.read_text'],
      attempts: 1,
      evidence: [
        { toolName: 'file.list_dir', toolCallId: 'call_list', status: 'ok', timestamp: 1 },
      ],
    }),
    parts: [{ type: 'tool_call', name: 'file.read_text', args: { path: 'D:\\x\\src\\App.tsx' }, status: 'ok', result: { content: 'old app' } }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
  assert.match(result.needsRepair, /stalled after read-only inspection/)
})

test('feature step with useful tool evidence does not block solely because attempts are high', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'write_core_files',
      title: 'Write core files',
      role: 'feature',
      requiredTools: ['file.write_text', 'file.patch', 'project.map'],
      attempts: 20,
    }),
    parts: [{ type: 'tool_call', name: 'file.write_text', args: { path: 'D:\\x\\src\\App.tsx' }, status: 'ok', result: {} }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
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

test('scaffold step with shell progress does not block solely because attempts are high', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'init_project',
      title: 'Initialize project',
      role: 'scaffold',
      requiredTools: ['shell.run_command'],
      attempts: 20,
    }),
    parts: [
      { type: 'tool_call', name: 'shell.run_command', status: 'ok', args: { command: 'npx', args: ['create', 'vite@latest', '.'] }, result: { exitCode: 0 } },
    ],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
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

test('file scaffold step completes on durable file write', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'create-index',
      title: 'Create HTML entry point',
      role: 'scaffold',
      requiredTools: ['file.write_text'],
    }),
    parts: [
      {
        type: 'tool_call',
        name: 'file.write_text',
        status: 'ok',
        args: { path: 'D:\\x\\index.html' },
        result: { path: 'D:\\x\\index.html', bytes: 297, action: 'overwritten' },
      },
    ],
    fullContent: '',
  })
  assert.equal(result.complete, true)
})

test('directory scaffold step completes when requested structure already exists', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({
      id: 'create_app_structure',
      title: 'Create application directory structure',
      role: 'scaffold',
      requiredTools: ['file.create_dir'],
    }),
    parts: [
      {
        type: 'tool_call',
        name: 'file.list_dir',
        status: 'ok',
        args: { path: 'D:\\x' },
        result: {
          path: 'D:\\x',
          entries: [
            { name: 'package.json', type: 'file' },
            { name: 'src', type: 'directory' },
          ],
        },
      },
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

test('frontend validate role does not complete on typecheck-only command', () => {
  const frontendPlan = plan({
    kind: 'coding-design',
    steps: [
      { id: 'preview', role: 'preview', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'validate', role: 'validate', title: '', status: 'running', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 0 },
    ],
  })
  const result = evaluateStepCompletion({
    plan: frontendPlan,
    step: frontendPlan.steps[1],
    parts: [{
      type: 'tool_call',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npx', args: ['tsc', '--noEmit'] },
      result: { exitCode: 0 },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.needsRepair, undefined)
  assert.equal(result.blocked, undefined)
})

test('frontend validate role completes on successful build command', () => {
  const frontendPlan = plan({
    kind: 'coding-design',
    steps: [
      { id: 'preview', role: 'preview', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'validate', role: 'validate', title: '', status: 'running', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 0 },
    ],
  })
  const result = evaluateStepCompletion({
    plan: frontendPlan,
    step: frontendPlan.steps[1],
    parts: [{
      type: 'tool_call',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npm', args: ['run', 'build'] },
      result: { exitCode: 0 },
    }],
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
    fullContent: 'Changed files: src/main.ts. Validation: passed. Remaining risks: none.',
  })
  assert.equal(result.complete, true)
})

test('validate role with failed shell build routes to repair', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'verify', role: 'validate', attempts: 1 }),
    parts: [{
      type: 'tool_call',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npm', args: ['run', 'build'] },
      result: { exitCode: 1, stderr: 'src/App.tsx(1,1): error TS6133' },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.match(result.needsRepair, /TS6133|exitCode/)
})

test('validate role keeps routing build failures to repair beyond fixed attempt counts', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'verify', role: 'validate', attempts: 30 }),
    parts: [{
      type: 'tool_call',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npm', args: ['run', 'build'] },
      result: { exitCode: 2, stdout: 'src/App.tsx(1,1): error TS2614\nsrc/View.tsx(2,1): error TS2345' },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
  assert.match(result.needsRepair, /2 build\/type error/)
  assert.match(result.needsRepair, /TS2614|TS2345/)
})

test('validate role counts unique TypeScript diagnostic codes as repair budget signal', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'verify', role: 'validate', attempts: 1 }),
    parts: [{
      type: 'tool_call',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npm', args: ['run', 'build'] },
      result: { exitCode: 2, stdout: [
        'src/App.tsx(1,1): error TS2614: bad import',
        'src/View.tsx(2,1): error TS2345: bad type',
        'src/Panel.tsx(3,1): error TS6133: unused var',
      ].join('\n') },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
  assert.match(result.needsRepair, /3 build\/type error/)
})

test('validate role with weak validation evidence does not hard block on attempt count', () => {
  const frontendPlan = plan({
    kind: 'coding-design',
    steps: [
      { id: 'preview', role: 'preview', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'validate', role: 'validate', title: '', status: 'running', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 20 },
    ],
  })
  const result = evaluateStepCompletion({
    plan: frontendPlan,
    step: frontendPlan.steps[1],
    parts: [{
      type: 'tool_call',
      name: 'shell.run_command',
      status: 'ok',
      args: { command: 'npx', args: ['tsc', '--noEmit'] },
      result: { exitCode: 0 },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
})

test('validation progress continues when the repair evidence changes', () => {
  const basePlan = plan()
  const failedValidation = [{
    type: 'tool_call',
    name: 'shell.run_command',
    status: 'ok',
    args: { command: 'npm', args: ['run', 'build'] },
    result: { exitCode: 2, stderr: 'src/App.tsx(1,1): error TS6133: unused import' },
  }]
  let state = { repairEvidenceSinceLastValidation: [] }
  let update = updateValidationProgressState({ state, plan: basePlan, parts: failedValidation })
  assert.equal(update.noProgressReason, undefined)

  update = updateValidationProgressState({
    state: update.state,
    plan: basePlan,
    parts: [{ type: 'tool_call', name: 'file.patch', status: 'ok', args: { path: 'D:\\x\\src\\App.tsx', patch: 'remove import A' }, result: { path: 'D:\\x\\src\\App.tsx' } }],
  })
  update = updateValidationProgressState({ state: update.state, plan: basePlan, parts: failedValidation })
  assert.equal(update.noProgressReason, undefined)

  update = updateValidationProgressState({
    state: update.state,
    plan: basePlan,
    parts: [{ type: 'tool_call', name: 'file.patch', status: 'ok', args: { path: 'D:\\x\\src\\App.tsx', patch: 'remove import B' }, result: { path: 'D:\\x\\src\\App.tsx' } }],
  })
  update = updateValidationProgressState({ state: update.state, plan: basePlan, parts: failedValidation })
  assert.equal(update.noProgressReason, undefined)
})

test('validation progress stops when the same validation failure follows the same repair evidence', () => {
  const basePlan = plan()
  const failedValidation = [{
    type: 'tool_call',
    name: 'shell.run_command',
    status: 'ok',
    args: { command: 'npm', args: ['run', 'build'] },
    result: { exitCode: 2, stderr: 'src/App.tsx(1,1): error TS6133: unused import' },
  }]
  const samePatch = [{ type: 'tool_call', name: 'file.patch', status: 'ok', args: { path: 'D:\\x\\src\\App.tsx', patch: 'remove import A' }, result: { path: 'D:\\x\\src\\App.tsx' } }]
  let update = updateValidationProgressState({ state: { repairEvidenceSinceLastValidation: [] }, plan: basePlan, parts: failedValidation })
  update = updateValidationProgressState({ state: update.state, plan: basePlan, parts: samePatch })
  update = updateValidationProgressState({ state: update.state, plan: basePlan, parts: failedValidation })
  assert.equal(update.noProgressReason, undefined)
  update = updateValidationProgressState({ state: update.state, plan: basePlan, parts: samePatch })
  update = updateValidationProgressState({ state: update.state, plan: basePlan, parts: failedValidation })
  assert.match(update.noProgressReason, /Validation no-progress detected/)
})

test('repair read-only evidence routes to repair guidance instead of hard blocking', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'repair', title: 'Repair build issue', role: 'repair', requiredTools: ['file.patch', 'file.write_text'], attempts: 20 }),
    parts: [{ type: 'tool_call', name: 'file.read_text', args: { path: 'D:\\x\\src\\App.tsx' }, status: 'ok', result: { content: 'bad import' } }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.equal(result.blocked, undefined)
  assert.match(result.needsRepair, /did not repair anything/)
})

test('repair action must target error file when validation includes a file path', () => {
  const repairStep = step({
    id: 'repair',
    title: 'Repair build issue',
    role: 'repair',
    requiredTools: ['file.patch', 'file.write_text'],
    lastError: 'src/App.tsx(2,1): error TS6133: unused import',
  })
  const wrongFile = evaluateStepCompletion({
    plan: plan({ steps: [repairStep] }),
    step: repairStep,
    parts: [{ type: 'tool_call', name: 'file.patch', args: { path: 'D:\\x\\src\\Other.tsx', oldText: 'a', newText: 'b' }, status: 'ok', result: { path: 'D:\\x\\src\\Other.tsx' } }],
    fullContent: '',
  })
  assert.equal(wrongFile.complete, false)
  assert.match(wrongFile.needsRepair, /failing file/)

  const rightFile = evaluateStepCompletion({
    plan: plan({ steps: [repairStep] }),
    step: repairStep,
    parts: [{ type: 'tool_call', name: 'file.patch', args: { path: 'D:\\x\\src\\App.tsx', oldText: 'a', newText: 'b' }, status: 'ok', result: { path: 'D:\\x\\src\\App.tsx' } }],
    fullContent: '',
  })
  assert.equal(rightFile.complete, true)
})

test('step with no evidence can block as no-progress', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'start_preview', title: 'Start Preview', role: 'preview', requiredTools: ['devserver.start'], attempts: 1 }),
    parts: [],
    fullContent: '<antThinking>I should start the server.</antThinking>',
  })
  assert.equal(result.complete, false)
  assert.match(result.blocked, /no usable completion evidence/)
})

test('final_report role rejects thinking-only content', () => {
  const backendPlan = plan({
    steps: [{ id: 'write', role: 'feature', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 }],
  })
  const result = evaluateStepCompletion({
    plan: backendPlan,
    step: step({ id: 'final', role: 'final_report' }),
    parts: [],
    fullContent: '<antThinking>I need to validate and then report.</antThinking>',
  })
  assert.equal(result.complete, false)
})

test('normalizeTaskExecutionPlan injects console and screenshot checks after preview', () => {
  const normalized = normalizeTaskExecutionPlan(plan({
    steps: [
      { id: 'validate-build', role: 'validate', title: 'Validate Build', status: 'pending', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 0 },
      { id: 'preview-app', role: 'preview', title: 'Preview Application', status: 'pending', requiredTools: ['devserver.start'], completionSignals: [], attempts: 0 },
      { id: 'final-report', role: 'final_report', title: 'Final Report', status: 'pending', requiredTools: [], completionSignals: [], attempts: 0 },
    ],
  }))
  assert.deepEqual(normalized.steps.map(s => s.role), ['validate', 'preview', 'console', 'screenshot', 'final_report'])
  assert.deepEqual(normalized.steps.find(s => s.role === 'console').requiredTools, ['preview.console', 'devserver.status', 'devserver.start'])
  assert.deepEqual(normalized.steps.find(s => s.role === 'screenshot').requiredTools, ['preview.screenshot', 'devserver.status', 'devserver.start'])
})

test('updatePlanValidation is scoped to the active step role', () => {
  const base = plan({
    steps: [
      { id: 'scaffold', role: 'scaffold', title: '', status: 'running', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 0 },
      { id: 'validate', role: 'validate', title: '', status: 'pending', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 0 },
    ],
  })
  const validationDuringScaffold = updatePlanValidation(base, [
    { type: 'tool_call', name: 'shell.run_command', status: 'ok', args: { command: 'npm', args: ['run', 'build'] }, result: { exitCode: 0 } },
  ], base.steps[0])
  assert.equal(validationDuringScaffold.buildChecked, false)

  const validationDuringValidate = updatePlanValidation(base, [
    { type: 'tool_call', name: 'shell.run_command', status: 'ok', args: { command: 'npm', args: ['run', 'build'] }, result: { exitCode: 0 } },
  ], base.steps[1])
  assert.equal(validationDuringValidate.buildChecked, true)

  const failedBuild = updatePlanValidation(base, [
    { type: 'tool_call', name: 'shell.run_command', status: 'ok', args: { command: 'npm', args: ['run', 'build'] }, result: { exitCode: 1, stderr: 'build failed' } },
  ], base.steps[1])
  assert.equal(failedBuild.buildChecked, false)
})

test('updatePlanValidation does not mark frontend build checked for typecheck-only command', () => {
  const frontendPlan = plan({
    kind: 'coding-design',
    steps: [
      { id: 'preview', role: 'preview', title: '', status: 'done', requiredTools: [], completionSignals: [], attempts: 0 },
      { id: 'validate', role: 'validate', title: '', status: 'running', requiredTools: ['shell.run_command'], completionSignals: [], attempts: 0 },
    ],
  })
  const validation = updatePlanValidation(frontendPlan, [
    { type: 'tool_call', name: 'shell.run_command', status: 'ok', args: { command: 'npx', args: ['tsc', '--noEmit'] }, result: { exitCode: 0 } },
  ], frontendPlan.steps[1])
  assert.equal(validation.buildChecked, false)
})

test('updatePlanValidation marks screenshot checked only when visual content is accepted', () => {
  const screenshotPlan = plan({
    steps: [
      { id: 'shot', role: 'screenshot', title: '', status: 'running', requiredTools: ['preview.screenshot'], completionSignals: [], attempts: 0 },
    ],
  })
  const blank = updatePlanValidation(screenshotPlan, [
    {
      type: 'tool_call',
      name: 'preview.screenshot',
      status: 'ok',
      args: {},
      result: {
        screenshotPath: 'D:\\x\\shot.png',
        errorCount: 0,
        pageStats: { bodyTextLength: 0, elementCount: 2, canvasCount: 0 },
        visualStats: { blankLike: true },
      },
    },
  ], screenshotPlan.steps[0])
  assert.equal(blank.screenshotChecked, false)

  const accepted = updatePlanValidation(screenshotPlan, [
    {
      type: 'tool_call',
      name: 'preview.screenshot',
      status: 'ok',
      args: {},
      result: {
        screenshotPath: 'D:\\x\\shot.png',
        errorCount: 0,
        pageStats: { bodyTextLength: 12, elementCount: 10, canvasCount: 1 },
        visualStats: { blankLike: false },
      },
    },
  ], screenshotPlan.steps[0])
  assert.equal(accepted.screenshotChecked, true)
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

test('final report step requires files, validation, and risks sections', () => {
  const finalPlan = plan({
    steps: [step({ id: 'final_report', role: 'final_report' })],
  })
  assert.equal(evaluateStepCompletion({
    plan: finalPlan,
    step: finalPlan.steps[0],
    parts: [],
    fullContent: 'Changed files: App.tsx\nValidation result: build passed',
  }).complete, false)
  assert.equal(evaluateStepCompletion({
    plan: finalPlan,
    step: finalPlan.steps[0],
    parts: [],
    fullContent: 'Changed files: App.tsx\n</antThinking>\nValidation result: build passed\nRemaining risks: none known',
  }).complete, true)
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

test('console step completes only after preview.console, not devserver recovery tools', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'console', role: 'console', requiredTools: ['preview.console', 'devserver.status', 'devserver.start'] }),
    parts: [{ type: 'tool_call', name: 'devserver.start', status: 'ok', args: {}, result: { url: 'http://127.0.0.1:5174/' } }],
    fullContent: '',
  })
  assert.equal(result.complete, false)

  const completed = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'console', role: 'console', requiredTools: ['preview.console', 'devserver.status', 'devserver.start'] }),
    parts: [{ type: 'tool_call', name: 'preview.console', status: 'ok', args: {}, result: { messages: [] } }],
    fullContent: '',
  })
  assert.equal(completed.complete, true)
})

test('console step routes browser errors to repair', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'console', role: 'console', requiredTools: ['preview.console', 'devserver.status', 'devserver.start'] }),
    parts: [{
      type: 'tool_call',
      name: 'preview.console',
      status: 'error',
      args: {},
      result: { errorCount: 1, messages: [{ level: 'error', text: 'ReferenceError: x is not defined' }] },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.match(result.needsRepair, /Preview console check failed/)
  assert.match(result.needsRepair, /ReferenceError/)
})

test('screenshot step rejects blank accepted tool result', () => {
  const result = evaluateStepCompletion({
    plan: plan(),
    step: step({ id: 'screenshot', role: 'screenshot', requiredTools: ['preview.screenshot'] }),
    parts: [{
      type: 'tool_call',
      name: 'preview.screenshot',
      status: 'ok',
      args: {},
      result: {
        screenshotPath: 'D:\\x\\shot.png',
        errorCount: 0,
        pageStats: { bodyTextLength: 0, elementCount: 2, canvasCount: 0 },
        visualStats: { blankLike: true },
      },
    }],
    fullContent: '',
  })
  assert.equal(result.complete, false)
  assert.match(result.needsRepair, /did not prove/)
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
