# Task Execution v2 — Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps that prevent Ava's coding-task pipeline from working as designed: dynamic-plan resilience, an applicability-aware final-report gate, an analyze phase that actually sees conversation context, robust planner JSON parsing, and tool exposure that matches the per-step contract.

**Architecture:** Introduce a small `step.role` taxonomy and route engine behavior (completion gate, repair routing, final-report gate) through it instead of hard-coded step IDs. Static and dynamic plans both populate `role`, so both flows get the same resilience features. Side fixes harden JSON parsing, thread history into the analyze phase, narrow tool exposure per step, and remove dead code.

**Tech Stack:** TypeScript 5.7, Electron main/renderer IPC, Node built-in test runner with on-the-fly TS transpile (existing pattern in `taskExecutionPolicy.test.mjs`).

**Out of scope:** cross-step context loss via `taskRoundSummary` (issue #7 in the review) — fixing it is a design tradeoff between fidelity and token cost; bring it as a separate spec.

---

## P0 Review Addendum — Must Fix Before More Runtime Work

These issues came from the 2026-05-20 local code review after the initial Task Execution v2/runtime work. Treat them as blockers before continuing broad architecture changes or manual big-task testing.

- [x] **P0.1 Tighten step completion gates**

Current risk: `evaluateStepCompletion` can mark a step complete when any required tool succeeds. For `write_core_files`, one successful `file.write_text` or `file.patch` can incorrectly advance to preview/validate while the app is only partially written.

Required fix:
- Add role/step-specific completion gates.
- `write_core_files` must require stronger evidence than a single write. Acceptable v1 evidence: a planned/observed file checklist, or `project.map`/`file.stat` verification after writes.
- Do not allow generic "any required tool succeeded" completion for `feature`, `scaffold`, `install`, `validate`, or `final_report` roles.

Files to review/change:
- `apps/shell/src/lib/agent/taskExecution.ts`
- `apps/shell/electron/llm.ts`
- `apps/shell/src/components/ChatView.tsx`

Tests to add/update:
- A `write_core_files` step with one successful `file.write_text` must stay running unless its completion evidence is satisfied.
- A `write_core_files` step with required file evidence satisfied can complete.
- A duplicate/ignored tool result must not satisfy a step completion gate.

- [x] **P0.2 Persist full shell output before compacting**

Current risk: `shell.run_command` truncates stdout/stderr at `MAX_OUTPUT_CHARS` before `toolResultStore` sees it, so persisted tool results still lose the real build/test error.

Required fix:
- Capture full stdout/stderr to a persistent log file or bounded rolling file first.
- Send only compact head/tail preview to the LLM.
- Store a `persistedOutput` reference that points to the full command output, not the already-truncated preview.

Files to review/change:
- `apps/shell/electron/services/builtInTools.ts`
- `apps/shell/electron/services/toolResultStore.ts`

Tests to add/update:
- A command producing output larger than `MAX_OUTPUT_CHARS` must return compact preview and a persisted full output reference.
- The persisted file must contain text beyond the compact preview.

- [x] **P0.3 Centralize progress/recovery semantics**

Current risk: `llm.ts` counts `project.map/file.stat/project.detect` as step progress, while renderer recovery only continues after file write/patch progress. This can create silent or inconsistent stops.

Required fix:
- Move progress classification into one shared runtime policy module.
- Use the same policy for main-process `runToolLoop` early returns and renderer `tool_loop_limit` recovery.
- Return explicit recovery actions: `continue_step`, `block_step`, `recover_step`, or `stop_with_error`.

Files to review/change:
- `apps/shell/electron/llm.ts`
- `apps/shell/src/lib/agent/runtime/agentRuntime.ts`
- `apps/shell/src/components/ChatView.tsx`

Tests to add/update:
- Inspect progress (`project.map`) and file progress (`file.write_text`) produce consistent recovery behavior.
- Tool loop limit after non-progress blocks with a useful reason.

- [x] **P0.4 Dedupe duplicate tool calls before stale/error handling**

Current risk: duplicate tool call ids are checked after stale/final-report-budget validation. A repeated stale tool call can still emit repeated stale errors and burn loop budget.

Required fix:
- Check `toolRuntime.hasResolvedToolCall(streamId, toolCall.id)` immediately after parsing a tool call and before stale/final-report validation.
- Duplicate/ignored tool calls must not be counted as successful tool evidence.

Files to review/change:
- `apps/shell/electron/llm.ts`
- `apps/shell/electron/services/toolRuntime.ts`

Tests to add/update:
- Repeated stale tool call id is ignored after first resolution.
- Ignored duplicate tool call does not advance the active step.

- [x] **P0.5 Recursively compact nested tool results**

Current risk: `compactContent` only truncates top-level string fields. Nested logs or nested arrays can still be injected into the next LLM context.

Required fix:
- Implement recursive compaction with depth/size limits, or replace oversized structured content with `{ preview, truncated, persistedOutput }`.
- Keep enough preview for diagnosis but never re-inject full nested output.

Files to review/change:
- `apps/shell/electron/services/toolResultStore.ts`

Tests to add/update:
- Nested large string fields are compacted.
- Arrays/objects over the size threshold do not exceed the context-safe preview size.

- [x] **P0.6 Decide where persisted tool artifacts live**

Current risk: project-local `.ava/tool-results` may pollute user projects and Git status.

Required fix:
- Decide policy explicitly: app data by default, or project-local only when enabled.
- If project-local remains default, ensure `.ava/` is auto-ignored or clearly documented.

Files to review/change:
- `apps/shell/electron/services/toolResultStore.ts`
- `.gitignore` behavior for generated task artifacts, if needed.

---

## File Structure

Files touched, in order of dependency:

- Modify: `apps/shell/src/types.ts` — add `role` to `TaskExecutionStep`.
- Create: `apps/shell/src/lib/agent/jsonExtraction.ts` — balanced-brace JSON extractor.
- Create: `apps/shell/src/lib/agent/jsonExtraction.test.mjs` — extractor tests.
- Modify: `apps/shell/src/lib/agent/taskExecution.ts` — role-based gates, applicability-aware final-report gate, drop dead stub.
- Create: `apps/shell/src/lib/agent/taskExecution.test.mjs` — gate tests.
- Modify: `apps/shell/src/lib/agent/taskExecutionPolicy.ts` — budget helpers accept `role`.
- Modify: `apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs` — extend coverage.
- Modify: `apps/shell/src/lib/agent/prompts/templates.ts` — PLANNER_TEMPLATE prescribes `role` taxonomy.
- Modify: `apps/shell/src/lib/agent/roles/planner.ts` — pass conversation messages, normalize `role`, use robust JSON extractor.
- Modify: `apps/shell/src/lib/agent/chat.ts` — pass conversation through to `generateDynamicTaskPlan` (re-exported helper).
- Modify: `apps/shell/src/components/ChatView.tsx` — supply conversation messages to dynamic planner.
- Modify: `apps/shell/electron/llm.ts` — filter exposed tools per `activeStepRequiredTools`; update final-report budget helper consumer.
- Delete: `apps/shell/src/lib/agent/runtime/toolRouter.ts` — dead code.
- Modify: `apps/shell/src/lib/agent/runtime/taskGraph.ts` — drop unused `decomposeStep`, `replanInsertBefore`.

---

### Task 1: Add `step.role` field

**Files:**
- Modify: `apps/shell/src/types.ts:45-59`

- [ ] **Step 1: Add the `role` field**

In `apps/shell/src/types.ts`, edit the `TaskExecutionStep` interface to add a `role` field after `workflowType`:

```ts
export interface TaskExecutionStep {
  id: string
  title: string
  status: TaskExecutionStepStatus
  requiredTools: string[]
  completionSignals: string[]
  attempts: number
  lastError?: string
  /** DAG dependency graph: list of step IDs that must be 'done' before this step can start. */
  dependsOn?: string[]
  /** Dynamic decomposition: if a task is too large, it can be broken down into subtasks. */
  subtasks?: TaskExecutionStep[]
  /** Specific template workflow type for this step (e.g. 'scaffold', 'debug'). Defaults to 'feature' if omitted. */
  workflowType?: 'scaffold' | 'feature' | 'debug' | 'refactor' | 'research'
  /**
   * Engine behavior tag. Drives completion gates, repair routing, and final-report gating.
   * Independent of `workflowType` (which only selects an executor prompt template).
   * Steps with no `role` use the generic completion gate (any required tool succeeds).
   */
  role?:
    | 'inspect'
    | 'scaffold'
    | 'install'
    | 'feature'
    | 'preview'
    | 'console'
    | 'screenshot'
    | 'repair'
    | 'validate'
    | 'final_report'
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS — adding an optional field is non-breaking.

- [ ] **Step 3: Commit**

```bash
git add apps/shell/src/types.ts
git commit -m "feat(types): add TaskExecutionStep.role for engine behavior dispatch"
```

---

### Task 2: Robust JSON extraction utility

The current planner uses a lazy/greedy regex pair that mangles LLM output containing nested braces or trailing commentary. Build a balanced-brace extractor.

**Files:**
- Create: `apps/shell/src/lib/agent/jsonExtraction.ts`
- Create: `apps/shell/src/lib/agent/jsonExtraction.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `apps/shell/src/lib/agent/jsonExtraction.test.mjs`:

```js
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = new URL('./jsonExtraction.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const tempDir = await mkdtemp(join(tmpdir(), 'ava-json-extract-'))
const compiledPath = join(tempDir, 'jsonExtraction.mjs')
await writeFile(compiledPath, compiled, 'utf8')
const { extractJsonObject } = await import(pathToFileURL(compiledPath).href)
test.after(async () => { await rm(tempDir, { recursive: true, force: true }) })

test('extracts a fenced json block', () => {
  const out = extractJsonObject('Here you go:\n```json\n{ "a": 1 }\n```\nthanks.')
  assert.deepEqual(out, { a: 1 })
})

test('extracts json with nested braces from a fenced block', () => {
  const out = extractJsonObject('```json\n{ "a": { "b": 2 }, "c": [1,2] }\n```')
  assert.deepEqual(out, { a: { b: 2 }, c: [1, 2] })
})

test('extracts the FIRST balanced top-level json from prose with multiple objects', () => {
  const out = extractJsonObject('Plan: { "steps": [{ "id": "x" }] } and also { "garbage": 1 }')
  assert.deepEqual(out, { steps: [{ id: 'x' }] })
})

test('ignores braces that appear inside json strings', () => {
  const out = extractJsonObject('result = { "a": "}{}", "b": 2 }')
  assert.deepEqual(out, { a: '}{}', b: 2 })
})

test('returns null when no balanced object is present', () => {
  assert.equal(extractJsonObject('no json here, just words'), null)
})

test('returns null on truncated json', () => {
  assert.equal(extractJsonObject('{ "a": 1, "b": '), null)
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node apps/shell/src/lib/agent/jsonExtraction.test.mjs`
Expected: FAIL — `jsonExtraction.ts` does not exist.

- [ ] **Step 3: Implement the extractor**

Create `apps/shell/src/lib/agent/jsonExtraction.ts`:

```ts
/**
 * Find the first balanced top-level JSON object in `text` and return it parsed.
 * Handles fenced ```json blocks, nested braces, and braces inside string literals.
 * Returns null if no parseable balanced object is found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = matchFencedJson(text)
  if (fenced) {
    const parsed = tryParse(fenced)
    if (parsed) return parsed
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start)
    if (end === -1) return null
    const parsed = tryParse(text.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}

function matchFencedJson(text: string): string | null {
  const re = /```(?:json)?\s*([\s\S]*?)\s*```/i
  const m = text.match(re)
  return m ? m[1].trim() : null
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node apps/shell/src/lib/agent/jsonExtraction.test.mjs`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/shell/src/lib/agent/jsonExtraction.ts apps/shell/src/lib/agent/jsonExtraction.test.mjs
git commit -m "feat(agent): balanced-brace JSON extractor for planner output"
```

---

### Task 3: Refactor `evaluateStepCompletion` to dispatch on role

Move the special-case logic that currently keys on `step.id === 'repair' | 'validate' | 'final_report'` to dispatch on `step.role`, so dynamic-planner steps get the same treatment.

**Files:**
- Modify: `apps/shell/src/lib/agent/taskExecution.ts:204-269`
- Create: `apps/shell/src/lib/agent/taskExecution.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `apps/shell/src/lib/agent/taskExecution.test.mjs`:

```js
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

// Compile only the parts of taskExecution.ts we need (the helpers under test
// have no DOM or window dependency). The file imports types only from '../../types',
// which transpiles away cleanly with importsNotUsedAsValues:Remove.
const sourcePath = new URL('./taskExecution.ts', import.meta.url)
let source = await readFile(sourcePath, 'utf8')
// Strip side-effect imports that pull in chat.ts (window-dependent).
source = source.replace(/import\s*{[^}]*}\s*from\s*['"]\.\/chat['"]/g, '')
source = source.replace(/import\s*{[^}]*}\s*from\s*['"]\.\/roles\/planner['"]/g, '')
source = source.replace(/import\s*{[^}]*}\s*from\s*['"]\.\/runtime\/taskGraph['"]/g, '')

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText

const tempDir = await mkdtemp(join(tmpdir(), 'ava-task-exec-'))
const compiledPath = join(tempDir, 'taskExecution.mjs')
// Stub the modules we stripped, in case any function still references them.
await writeFile(join(tempDir, 'chat.mjs'), 'export {}', 'utf8')
await writeFile(compiledPath, compiled, 'utf8')

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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node apps/shell/src/lib/agent/taskExecution.test.mjs`
Expected: FAIL — `evaluateStepCompletion` and `finalValidationGateSatisfied` do not yet dispatch on `role`, the `finalValidationGateSatisfied` signature does not accept a plan, and several assertions will mismatch.

- [ ] **Step 3: Update `evaluateStepCompletion` to dispatch on `role`**

In `apps/shell/src/lib/agent/taskExecution.ts`, replace the `evaluateStepCompletion` function (currently at lines 204-269) with:

```ts
export function evaluateStepCompletion(input: {
  plan: TaskExecutionPlan
  step: TaskExecutionStep
  parts: ContentPart[]
  fullContent: string
}): { complete: boolean; blocked?: string; needsRepair?: string } {
  const { plan, step, parts, fullContent } = input
  const role = stepRole(step)

  if (role === 'repair') return { complete: true }

  if (role === 'final_report') {
    if (!finalValidationGateSatisfied(plan.validation, plan)) {
      return {
        complete: false,
        blocked: finalReportBlockedReason(plan),
      }
    }
    return { complete: fullContent.trim().length > 0 }
  }

  if (role === 'validate') {
    const okTools = okToolParts(parts)
    const failedValidate = failedToolParts(parts).filter(p =>
      p.name === 'project.validate' || (p.name === 'shell.run_command' && looksLikeValidationCommand(p.args)),
    )

    if (okTools.some(p =>
      p.name === 'project.validate' || (p.name === 'shell.run_command' && looksLikeValidationCommand(p.args)),
    )) {
      return { complete: true }
    }

    if (failedValidate.length > 0) {
      const errSummary = failedValidate
        .map(p => p.error ?? JSON.stringify(p.result).slice(0, 600))
        .join('\n---\n')
      if (step.attempts >= MAX_VALIDATE_REPAIR_CYCLES) {
        return {
          complete: false,
          blocked: `Validation failed after ${MAX_VALIDATE_REPAIR_CYCLES} repair cycle(s). Build errors:\n${errSummary}`,
        }
      }
      return {
        complete: false,
        needsRepair: `project.validate failed with the following errors — fix them before retrying:\n${errSummary}`,
      }
    }

    if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
      return { complete: false, blocked: `Step "${step.title}" did not call project.validate after ${MAX_STEP_ATTEMPTS} attempt(s).` }
    }
    return { complete: false }
  }

  // Generic step gate.
  const okTools = okToolParts(parts)
  const complete = step.requiredTools.length === 0
    ? fullContent.trim().length > 0
    : okTools.some(part => step.requiredTools.includes(part.name))
  if (complete) return { complete: true }
  if (step.attempts + 1 >= MAX_STEP_ATTEMPTS) {
    return { complete: false, blocked: `Step "${step.title}" did not complete after ${MAX_STEP_ATTEMPTS} attempt(s). Missing tool: ${step.requiredTools.join(' or ')}.` }
  }
  return { complete: false }
}

/**
 * Bridges legacy plans (which keyed off step.id) with the new role taxonomy.
 * Prefers `step.role`. Falls back to id-name matching for the static fallback plan
 * created before this change reached production.
 */
function stepRole(step: TaskExecutionStep): TaskExecutionStep['role'] | undefined {
  if (step.role) return step.role
  switch (step.id) {
    case 'repair': return 'repair'
    case 'validate': return 'validate'
    case 'final_report': return 'final_report'
    case 'check_console': return 'console'
    case 'check_screenshot': return 'screenshot'
    case 'start_preview': return 'preview'
    default: return undefined
  }
}

function finalReportBlockedReason(plan: TaskExecutionPlan): string {
  const missing: string[] = []
  if (planHasRole(plan, 'console') && !plan.validation.consoleChecked) missing.push('console check')
  if (planHasRole(plan, 'screenshot') && !plan.validation.screenshotChecked) missing.push('screenshot check')
  if (planHasRole(plan, 'validate') && !plan.validation.buildChecked) missing.push('validation/build')
  if (missing.length === 0) return 'Final report is blocked.'
  return `Final report is blocked until these checks run: ${missing.join(', ')}.`
}

function planHasRole(plan: TaskExecutionPlan, role: NonNullable<TaskExecutionStep['role']>): boolean {
  return plan.steps.some(s => stepRole(s) === role)
}
```

- [ ] **Step 4: Update `finalValidationGateSatisfied` to be applicability-aware**

Replace the existing function (currently at lines 304-306):

```ts
export function finalValidationGateSatisfied(
  validation: TaskExecutionValidation,
  plan: TaskExecutionPlan,
): boolean {
  const consoleOk = !planHasRole(plan, 'console') || validation.consoleChecked
  const screenshotOk = !planHasRole(plan, 'screenshot') || validation.screenshotChecked
  const buildOk = !planHasRole(plan, 'validate') || validation.buildChecked
  return consoleOk && screenshotOk && buildOk
}
```

- [ ] **Step 5: Update `ChatView.tsx` call site**

In `apps/shell/src/components/ChatView.tsx`, find the only caller of `finalValidationGateSatisfied` (around line 968):

```ts
finalReportAllowed: activeStep?.id === 'final_report' && taskPlan ? finalValidationGateSatisfied(taskPlan.validation) : false,
```

Replace with:

```ts
finalReportAllowed: activeStep && taskPlan && (activeStep.role === 'final_report' || activeStep.id === 'final_report')
  ? finalValidationGateSatisfied(taskPlan.validation, taskPlan)
  : false,
```

- [ ] **Step 6: Run tests**

Run: `node apps/shell/src/lib/agent/taskExecution.test.mjs`
Expected: PASS — all 8 tests.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/shell/src/lib/agent/taskExecution.ts apps/shell/src/lib/agent/taskExecution.test.mjs apps/shell/src/components/ChatView.tsx
git commit -m "refactor(agent): role-based completion gates and applicability-aware final-report"
```

---

### Task 4: Update budget helpers to accept `role`

`toolLoopBudgetForStep` and `finalReportReadBudgetForStep` currently match on `step.id` and `step.title` regexes. Make them prefer `step.role`.

**Files:**
- Modify: `apps/shell/src/lib/agent/taskExecutionPolicy.ts`
- Modify: `apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs` (before the existing `test.after`):

```js
test('budget helper prefers role over title regex', () => {
  // Title that would otherwise match the "inspect" pattern is overridden by role: 'feature'.
  const featureStep = step('arbitrary', 'inspect things', ['file.write_text'])
  featureStep.role = 'feature'
  assert.equal(toolLoopBudgetForStep(featureStep), 30)
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`
Expected: FAIL — helpers ignore `role`.

- [ ] **Step 3: Update helpers**

In `apps/shell/src/lib/agent/taskExecutionPolicy.ts`, add a role table and consult it before falling back to regex:

```ts
const ROLE_BUDGETS: Record<NonNullable<TaskExecutionStep['role']>, number> = {
  inspect: 10,
  scaffold: 30,
  install: 10,
  feature: 30,
  preview: 6,
  console: 6,
  screenshot: 6,
  repair: 16,
  validate: 10,
  final_report: 4,
}

export function toolLoopBudgetForStep(step?: Pick<TaskExecutionStep, 'id' | 'title' | 'role'>, requestedBudget?: number): number {
  if (typeof requestedBudget === 'number' && Number.isFinite(requestedBudget)) {
    return clampBudget(requestedBudget)
  }
  if (!step) return DEFAULT_TOOL_LOOP_BUDGET
  if (step.role && ROLE_BUDGETS[step.role] !== undefined) return clampBudget(ROLE_BUDGETS[step.role])

  const key = `${step.id} ${step.title}`
  const matched = STEP_BUDGETS.find(item => item.pattern.test(key))
  return clampBudget(matched?.budget ?? DEFAULT_TOOL_LOOP_BUDGET)
}

export function finalReportReadBudgetForStep(step?: Pick<TaskExecutionStep, 'id' | 'title' | 'role'>): number | undefined {
  if (!step) return undefined
  if (step.role) return step.role === 'final_report' ? FINAL_REPORT_READ_BUDGET : undefined
  return /final[_-]?report|report/i.test(`${step.id} ${step.title}`) ? FINAL_REPORT_READ_BUDGET : undefined
}
```

The `Pick<>` widened to include `role` will require the import:

```ts
import type { TaskExecutionStep } from '../../types'
```

(already present — no change.)

- [ ] **Step 4: Run tests to verify pass**

Run: `node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`
Expected: PASS — all original tests + 3 new.

- [ ] **Step 5: Commit**

```bash
git add apps/shell/src/lib/agent/taskExecutionPolicy.ts apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs
git commit -m "feat(agent): step.role drives tool-loop and final-report read budgets"
```

---

### Task 5: Tag the static fallback plan with `role` + `workflowType`

The static plan from `createCodingDesignTaskPlan` currently relies on the legacy `stepRole` id-mapping. Set roles explicitly so we can drop the legacy mapping later, and set `workflowType` so each step gets the right executor prompt.

**Files:**
- Modify: `apps/shell/src/lib/agent/taskExecution.ts:30-64, 308-310`

- [ ] **Step 1: Update the `step()` helper signature**

Replace the helper at the bottom of the file (currently lines 308-310):

```ts
function step(
  id: string,
  title: string,
  requiredTools: string[],
  completionSignals: string[],
  role?: TaskExecutionStep['role'],
  workflowType?: TaskExecutionStep['workflowType'],
): TaskExecutionStep {
  return { id, title, status: 'pending', requiredTools, completionSignals, attempts: 0, role, workflowType }
}
```

- [ ] **Step 2: Tag every step in the static fallback plan**

Replace the `steps:` array in `createCodingDesignTaskPlan` (lines 49-60) with:

```ts
    steps: [
      step('inspect_project', 'Inspect project state',
        ['project.map', 'project.detect', 'file.list_dir', 'file.read_text', 'shell.run_command'],
        ['project mapped'], 'inspect', 'research'),
      step('setup_project', 'Initialize or complete project structure',
        ['shell.run_command', 'file.create_dir', 'file.write_text', 'file.read_text'],
        ['project structure ready'], 'scaffold', 'scaffold'),
      step('install_dependencies', 'Install or confirm required dependencies',
        ['shell.run_command', 'project.detect'],
        ['dependencies ready'], 'install', 'scaffold'),
      step('write_core_files', 'Write core app, 3D scene, loader, controls, and styles',
        ['file.write_text', 'file.patch', 'file.read_text'],
        ['core files written'], 'feature', 'feature'),
      step('start_preview', 'Start development server',
        ['devserver.start'],
        ['dev server started'], 'preview', 'research'),
      step('check_console', 'Check browser console',
        ['preview.console'],
        ['console checked'], 'console', 'debug'),
      step('check_screenshot', 'Capture preview screenshot',
        ['preview.screenshot'],
        ['screenshot checked'], 'screenshot', 'research'),
      step('repair', 'Repair detected console, build, or visual issues',
        ['file.patch', 'file.write_text', 'shell.run_command'],
        ['issues repaired'], 'repair', 'debug'),
      step('validate', 'Validate build or typecheck',
        ['project.validate', 'shell.run_command'],
        ['project validated'], 'validate', 'debug'),
      step('final_report', 'Report changed files, validation result, and remaining risks',
        [],
        ['final report written'], 'final_report', 'feature'),
    ],
```

(Note: `setup_project`, `write_core_files`, and `install_dependencies` now include `file.read_text` so the engine doesn't penalize sensible reads — fixes review issue #6 / #9.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 4: Run all agent tests**

Run: `node apps/shell/src/lib/agent/taskExecution.test.mjs && node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs && node apps/shell/src/lib/agent/jsonExtraction.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/shell/src/lib/agent/taskExecution.ts
git commit -m "feat(agent): tag static fallback plan with role and workflowType"
```

---

### Task 6: Update `PLANNER_TEMPLATE` and parse `role` from output

Constrain the planner LLM to populate `role` from the taxonomy, and use the new JSON extractor.

**Files:**
- Modify: `apps/shell/src/lib/agent/prompts/templates.ts:24-38`
- Modify: `apps/shell/src/lib/agent/roles/planner.ts`

- [ ] **Step 1: Update `PLANNER_TEMPLATE`**

In `apps/shell/src/lib/agent/prompts/templates.ts`, replace `PLANNER_TEMPLATE` with:

```ts
export const PLANNER_TEMPLATE = `You are an Orchestrator and Planner Agent.
Your job is to break down the goal into a Directed Acyclic Graph (DAG) of small, executable steps.

Rules:
1. DO NOT write actual implementation code.
2. Break large tasks into steps small enough to fit the provided context budget.
3. Explicitly define dependencies using the "dependsOn" array.
4. If a step requires specific tools, list them in "requiredTools".
5. Assign a workflowType to each step: 'scaffold', 'feature', 'debug', 'refactor', or 'research'.
6. Assign a role to each step from this exact taxonomy:
   - 'inspect'        — read-only project inspection (project.map, file.list_dir, file.read_text)
   - 'scaffold'       — create project structure or boilerplate files
   - 'install'        — install or confirm dependencies
   - 'feature'        — write or edit application source code
   - 'preview'        — start dev server / open preview (devserver.start, preview.open)
   - 'console'        — check browser console for runtime errors (preview.console)
   - 'screenshot'     — capture and inspect a visual screenshot (preview.screenshot)
   - 'repair'         — fix issues surfaced by validation, console, or screenshot
   - 'validate'       — run build/typecheck/test/lint (project.validate or shell.run_command with build/test/lint/tsc)
   - 'final_report'   — produce the wrap-up report. Exactly one final_report step, last.
7. Only include 'preview', 'console', 'screenshot' steps if the project has a runnable frontend; omit them otherwise (backend / library / CLI tasks).
8. Always include exactly one 'validate' step before 'final_report' when any code is written.
9. User clarification is already complete. Do NOT create steps that ask the user more questions.
10. Every step must be executable by Ava with tools or by producing the final report.
11. For small/local context budgets, split implementation into more file-sized tasks and validate after each batch.
12. Do not create a final_report step until inspect, write/edit, preview or validation steps can prove the task status.
13. Use only these tool names in requiredTools: shell.run_command, file.read_text, file.write_text, file.list_dir, file.create_dir, file.stat, file.patch, project.detect, project.map, project.validate, search.ripgrep, devserver.start, devserver.stop, devserver.status, preview.open, preview.console, preview.screenshot.
14. Never use aliases like fs.mkdir, shell.exec, bash, terminal, or npm as tool names; use file.create_dir or shell.run_command.

Output ONLY a JSON object with this shape, no prose before or after:

{ "steps": [ { "id": "...", "title": "...", "role": "...", "workflowType": "...", "dependsOn": [], "requiredTools": [] } ] }`
```

- [ ] **Step 2: Update planner.ts to use the JSON extractor and persist `role`**

In `apps/shell/src/lib/agent/roles/planner.ts`, change the imports at the top:

```ts
import type { ModelProvider, Settings, TaskExecutionPlan, TaskExecutionStep, ProjectAnalysis, Message } from '../../../types'
import { ANALYZE_TEMPLATE, PLANNER_TEMPLATE } from '../prompts/templates'
import { partsToText } from '../chat'
import { normalizeRequiredTools } from '../toolNames'
import { extractJsonObject } from '../jsonExtraction'
```

Replace the JSON match in `runAnalyzePhase` (the two-regex pattern around lines 49-53):

```ts
    const parsed = extractJsonObject(reply.result.fullContent)
    if (!parsed) {
      console.warn('Analyze phase: could not extract JSON from output:', reply.result.fullContent.slice(0, 500))
      return null
    }
    return parsed as unknown as ProjectAnalysis
```

Replace the JSON match in `runPlanPhase` (around lines 89-96):

```ts
    const parsed = extractJsonObject(reply.result.fullContent)
    if (!parsed) {
      console.warn('Plan phase: could not extract JSON from output:', reply.result.fullContent.slice(0, 500))
      return null
    }
    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null
    }
```

Update the step mapping (around lines 105-114) to include `role` and validate it against the taxonomy:

```ts
const VALID_ROLES = new Set([
  'inspect', 'scaffold', 'install', 'feature',
  'preview', 'console', 'screenshot', 'repair',
  'validate', 'final_report',
])

function normalizeRole(value: unknown): TaskExecutionStep['role'] {
  if (typeof value !== 'string') return undefined
  return VALID_ROLES.has(value) ? value as TaskExecutionStep['role'] : undefined
}
```

Then in the `.map(...)` block:

```ts
      steps: (parsed.steps as any[]).map((s: any, idx: number) => ({
        id: s.id || `step_${idx + 1}`,
        title: s.title || `Step ${idx + 1}`,
        status: 'pending',
        requiredTools: normalizeRequiredTools(Array.isArray(s.requiredTools) ? s.requiredTools : []),
        completionSignals: s.completionSignals || ['Done'],
        attempts: 0,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        workflowType: s.workflowType || 'feature',
        role: normalizeRole(s.role),
      })),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/shell/src/lib/agent/prompts/templates.ts apps/shell/src/lib/agent/roles/planner.ts
git commit -m "feat(agent): planner produces and parses step.role; robust JSON extraction"
```

---

### Task 7: Thread conversation history into `runAnalyzePhase`

**Files:**
- Modify: `apps/shell/src/lib/agent/taskExecution.ts:68-119`
- Modify: `apps/shell/src/components/ChatView.tsx:1554-1566`

- [ ] **Step 1: Add `messages` to `generateDynamicTaskPlan` and pass it through**

In `apps/shell/src/lib/agent/taskExecution.ts`, change the `generateDynamicTaskPlan` signature (around line 68) to accept a `messages` array:

```ts
import type { ContentPart, Message, ModelProvider, ProjectAnalysis, Settings, TaskExecutionPlan, TaskExecutionStep, TaskExecutionValidation } from '../../types'

// ...

export async function generateDynamicTaskPlan(input: {
  taskId: string
  goal: string
  workingDirectory?: string
  projectBrief?: any
  providers: ModelProvider[]
  settings: Settings
  analysis?: ProjectAnalysis | null
  skipAnalysis?: boolean
  traits?: string[]
  messages?: Message[]
}): Promise<TaskExecutionPlan> {
```

Then in the body where `runAnalyzePhase` is called:

```ts
  const analysis = input.skipAnalysis
    ? input.analysis ?? null
    : await runAnalyzePhase({
        taskId: input.taskId,
        goal: input.goal,
        workingDirectory: input.workingDirectory,
        providers: input.providers,
        settings: input.settings,
        contextBudget,
        messages: input.messages,
      })
```

- [ ] **Step 2: Update the `ChatView.tsx` call site**

In `apps/shell/src/components/ChatView.tsx`, in the `generateDynamicTaskPlan` call (currently around lines 1554-1566), add `messages`:

```ts
          taskPlan = await generateDynamicTaskPlan({
            taskId: pending.taskId,
            goal: finalGoal,
            workingDirectory,
            projectBrief,
            providers: getEnabledProviders(state.settings),
            settings: state.settings,
            traits: planningTraitsFor(finalGoal, conversation),
            analysis: pending.analysis
              ? { ...pending.analysis, unknowns: [] }
              : null,
            skipAnalysis: true,
            messages: conversation.messages,
          })
```

(Note: `skipAnalysis: true` is the production path — analyze already ran during intake. The `messages` argument matters for any code path that calls `generateDynamicTaskPlan` without `skipAnalysis`, e.g. recovery / replay.)

- [ ] **Step 3: Also pass messages from the intake-time analyze**

Find the intake-time analyze call in `ChatView.tsx` (search for `runAnalyzePhase`). If it does not already receive `messages: conversation.messages`, add it. (Confirm by grepping; if no direct call exists, skip this step — `runAnalyzePhase` is only invoked through `generateDynamicTaskPlan`.)

Run:
```bash
grep -n "runAnalyzePhase" apps/shell/src/components/ChatView.tsx
```

If the result shows direct call sites, supply `messages: conversation.messages` to each.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/shell/src/lib/agent/taskExecution.ts apps/shell/src/components/ChatView.tsx
git commit -m "fix(agent): thread conversation history into runAnalyzePhase"
```

---

### Task 8: Filter exposed tools by `activeStepRequiredTools`

When a step is active, expose only `requiredTools ∪ ALWAYS_ALLOWED_CORE` to the model. The model still sees the catalog but only the relevant slice, so it cannot blow loop budget on irrelevant tools.

**Files:**
- Modify: `apps/shell/electron/llm.ts:272-279, 911-915`

- [ ] **Step 1: Add the always-allowed core set**

In `apps/shell/electron/llm.ts`, near the top constants section (around line 155 where `FINAL_REPORT_READ_TOOL_NAMES` lives), add:

```ts
/**
 * Tools that are always exposed even when a step has a narrow `requiredTools`.
 * Lets the model do safe inspection without burning loop budget on disallowed tools.
 */
const ALWAYS_ALLOWED_CORE_TOOLS = new Set<string>([
  'file.read_text',
  'file.list_dir',
  'project.map',
  'project.detect',
  'search.ripgrep',
])
```

- [ ] **Step 2: Update `listAvailableTools` to filter**

Replace `listAvailableTools` (currently lines 272-279):

```ts
function listAvailableTools(
  currentTask: string,
  activeCommandInvocation?: ToolAuditCommandInvocation,
  forceToolExposure = false,
  activeStepRequiredTools?: string[],
): McpToolDescriptor[] {
  if (!shouldExposeTools(currentTask, activeCommandInvocation, forceToolExposure)) return []
  const all = [...builtInTools.listTools(), ...mcpSupervisor.listAllTools()]
  if (!activeStepRequiredTools || activeStepRequiredTools.length === 0) return all
  const allowed = new Set([...activeStepRequiredTools, ...ALWAYS_ALLOWED_CORE_TOOLS])
  return all.filter(tool => allowed.has(tool.name))
}
```

- [ ] **Step 3: Update the call site in `runToolLoop`**

Find the call (currently around lines 911-915):

```ts
  const tools = listAvailableTools(
    currentTask,
    args.activeCommandInvocation,
    Boolean(args.activeStepRequiredTools?.length),
  )
```

Replace with:

```ts
  const tools = listAvailableTools(
    currentTask,
    args.activeCommandInvocation,
    Boolean(args.activeStepRequiredTools?.length),
    args.activeStepRequiredTools,
  )
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/shell/electron/llm.ts
git commit -m "fix(agent): filter exposed tools by activeStepRequiredTools per step"
```

---

### Task 9: Delete dead code

Remove the always-false `validationHasFailureSignal` stub and its dead-branch caller, the unused `ToolRouter`, and the unused `TaskGraph` mutation methods.

**Files:**
- Modify: `apps/shell/src/lib/agent/taskExecution.ts:339-341` (`validationHasFailureSignal` — deleted in Task 3 already if you replaced the function; otherwise delete now)
- Delete: `apps/shell/src/lib/agent/runtime/toolRouter.ts`
- Modify: `apps/shell/src/lib/agent/runtime/taskGraph.ts`

- [ ] **Step 1: Verify `validationHasFailureSignal` is no longer referenced**

Run:
```bash
grep -rn "validationHasFailureSignal" apps/shell/src
```
Expected: no matches (the Task 3 refactor of `evaluateStepCompletion` removed the only caller).
If matches remain in `taskExecution.ts` itself, delete the function definition.

- [ ] **Step 2: Confirm `ToolRouter` is unused, then delete**

Run:
```bash
grep -rn "ToolRouter\|toolRouter" apps/shell/src apps/shell/electron
```
Expected: matches only inside `runtime/toolRouter.ts` itself.

If clean, delete:
```bash
rm apps/shell/src/lib/agent/runtime/toolRouter.ts
```

- [ ] **Step 3: Confirm `TaskGraph` mutation methods are unused**

Run:
```bash
grep -rn "decomposeStep\|replanInsertBefore\|markStepStatus" apps/shell
```
Expected: matches only inside `taskGraph.ts` itself.

If clean, edit `apps/shell/src/lib/agent/runtime/taskGraph.ts` to remove `markStepStatus`, `decomposeStep`, and `replanInsertBefore` methods. Keep the class with only `constructor`, `getPlan`, and `getNextStep`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/shell/src/lib/agent
git commit -m "chore(agent): remove dead validationHasFailureSignal stub, ToolRouter, unused TaskGraph methods"
```

---

### Task 10: Verification

**Files:** verification tests only.

- [x] **Step 1: Run all agent tests**

Run:
```bash
node apps/shell/src/lib/agent/jsonExtraction.test.mjs && \
node apps/shell/src/lib/agent/taskExecution.test.mjs && \
node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs
```
Expected: PASS for all suites.

- [x] **Step 2: Run typecheck**

Run: `npm run typecheck --workspace=@ava/shell`
Expected: PASS, no new errors vs baseline.

- [x] **Step 3: Run built-in tools smoke test**

Run: `npm run test:builtins`
Expected: PASS.

Additional UI smoke run: `npm run test:e2e`
Expected: PASS for app start, settings, Unit Test pane, preview console/screenshot.

- [ ] **Step 4: Manual coding-task smoke**

Start the app (`npm run dev --workspace=@ava/shell`). In a fresh conversation:

1. Pick a small coding task with a runnable frontend (e.g. "Build a single-file three.js animated cube at D:\\Apps\\TestProject"). Confirm the analyzer produces sensible unknowns, then proceed.
   - Expected: dynamic plan has steps with `role` populated; `TaskGraphWidget` shows them; runs through inspect → scaffold → install → write → preview → console → screenshot → validate → final_report.
2. Pick a backend-only task (e.g. "Write a small Python CLI at D:\\Apps\\TestPy that prints prime numbers up to N").
   - Expected: planner omits `preview`/`console`/`screenshot` roles; final_report runs immediately after `validate` succeeds; no "blocked until console/screenshot" message.
3. Force a build error to verify the validate→repair loop fires (e.g. introduce a bad import then ask Ava to validate).
   - Expected: validate step reports failure, plan rewinds repair, repair step writes a fix, validate re-runs.

- [ ] **Step 5: Final commit (if anything was tweaked during smoke)**

```bash
git status   # confirm tree clean
```

---

## Self-Review Checklist

Before handing off:

- [x] **Spec coverage:** Every issue in the review has a task — #1 (T3, T5, T6), #2 (T3, T4-applicability), #3 (T9), #4 (T7), #5 (T2, T6), #6 (T8), #8 (T9), #9 (T5), #10-misc (T5).
- [x] **No placeholders:** All steps include exact code and exact commands.
- [x] **Type consistency:** `step.role` enum is the same string in `types.ts`, `taskExecution.ts`, `templates.ts`, and `planner.ts` (`'inspect' | 'scaffold' | 'install' | 'feature' | 'preview' | 'console' | 'screenshot' | 'repair' | 'validate' | 'final_report'`). `finalValidationGateSatisfied` signature `(validation, plan)` matches in definition and call site. `toolLoopBudgetForStep` and `finalReportReadBudgetForStep` accept the new role-aware `Pick<TaskExecutionStep, 'id' | 'title' | 'role'>`.
- [x] **Out-of-scope flagged:** Cross-step context loss (`taskRoundSummary` summarization) is explicitly deferred — needs a separate spec.

---
