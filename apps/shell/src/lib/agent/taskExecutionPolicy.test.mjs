import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./taskExecutionPolicy.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText
const tempDir = await mkdtemp(join(tmpdir(), 'ava-task-policy-'))
const compiledPath = join(tempDir, 'taskExecutionPolicy.mjs')
await writeFile(compiledPath, compiled, 'utf8')

const {
  finalReportReadBudgetForStep,
  shouldBlockLargeTaskWithoutPlan,
  toolLoopBudgetForStep,
} = await import(pathToFileURL(compiledPath).href)

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('budget helper prefers role over title regex', () => {
  const featureStep = step('arbitrary', 'inspect things', ['file.write_text'])
  featureStep.role = 'feature'
  assert.equal(toolLoopBudgetForStep(featureStep), 50)
})

test('final-report read budget keys off role first', () => {
  const reportStep = step('wrap_up', 'Wrap up the task')
  reportStep.role = 'final_report'
  assert.equal(finalReportReadBudgetForStep(reportStep), 3)
})

test('final-report read budget undefined for non-final-report role', () => {
  const inspectStep = step('inspect', 'Inspect project')
  inspectStep.role = 'inspect'
  assert.equal(finalReportReadBudgetForStep(inspectStep), undefined)
})

function step(id, title, requiredTools = []) {
  return {
    id,
    title,
    status: 'pending',
    requiredTools,
    completionSignals: [],
    attempts: 0,
  }
}

test('assigns larger loop budget to write-heavy steps', () => {
  assert.equal(toolLoopBudgetForStep(step('write_core_files', 'Write files', ['file.write_text'])), 50)
})

test('validate steps have more than the default chat loop budget', () => {
  const validateStep = step('validate_build', 'Validate build and type checking')
  validateStep.role = 'validate'
  assert.equal(toolLoopBudgetForStep(validateStep), 30)
})

test('caps dynamic loop budgets at 500 rounds', () => {
  assert.equal(toolLoopBudgetForStep(step('custom', 'Huge custom step', ['file.write_text']), 900), 500)
})

test('keeps final report loop budget small', () => {
  assert.equal(toolLoopBudgetForStep(step('final_report', 'Final report')), 4)
})

test('allows only a small read budget during final report', () => {
  assert.equal(finalReportReadBudgetForStep(step('final_report', 'Final report')), 3)
  assert.equal(finalReportReadBudgetForStep(step('inspect_project', 'Inspect project')), undefined)
})

test('blocks large task tool execution when no task plan is bound', () => {
  const decision = shouldBlockLargeTaskWithoutPlan({
    isLargeTask: true,
    hasTaskPlan: false,
    hasActiveStep: false,
  })

  assert.equal(decision.block, true)
  assert.match(decision.reason, /TaskExecutionPlan/)
})

test('does not block small one-shot tool requests without a plan', () => {
  const decision = shouldBlockLargeTaskWithoutPlan({
    isLargeTask: false,
    hasTaskPlan: false,
    hasActiveStep: false,
  })

  assert.equal(decision.block, false)
})
