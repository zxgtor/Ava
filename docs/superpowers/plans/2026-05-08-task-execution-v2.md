# Task Execution v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep large coding/design tasks inside Ava's task engine with step-bound dynamic tool loop budgets.

**Architecture:** Add small, testable task execution policy helpers, then thread their decisions through `ChatView`, `sendChat`, `preload`, and `llm.ts`. The runtime remains TypeScript/Electron; LangGraph is only a comparison model, not a dependency.

**Tech Stack:** TypeScript 5.7, Electron main/renderer IPC, Node built-in test runner for policy tests, existing Ava task plan types.

---

### Task 1: Task execution policy helpers

**Files:**
- Create: `apps/shell/src/lib/agent/taskExecutionPolicy.ts`
- Test: `apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`

- [x] **Step 1: Write failing tests**

Create tests for step-aware loop budgets, final-report read budgets, and large-task generic-loop blocking.

- [x] **Step 2: Run tests and verify failure**

Run: `node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`
Expected: fails because `taskExecutionPolicy.ts` does not exist.

- [x] **Step 3: Implement policy helpers**

Add:
- `toolLoopBudgetForStep(step)`
- `finalReportReadBudgetForStep(step)`
- `shouldBlockLargeTaskWithoutPlan(input)`

- [x] **Step 4: Run tests and verify pass**

Run: `node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`
Expected: pass.

### Task 2: Wire dynamic loop budget through IPC

**Files:**
- Modify: `apps/shell/electron/llm.ts`
- Modify: `apps/shell/electron/preload.ts`
- Modify: `apps/shell/src/lib/agent/chat.ts`

- [x] **Step 1: Add `activeStepToolLoopBudget` and `finalReportReadBudget` to stream args**
- [x] **Step 2: Replace fixed `MAX_TOOL_LOOP` loop bound with per-request budget capped at 50**
- [x] **Step 3: Enforce final-report read/list budget in `runToolLoop`**
- [x] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`

### Task 3: Keep large tasks inside the task engine

**Files:**
- Modify: `apps/shell/src/components/ChatView.tsx`
- Modify: `apps/shell/src/lib/agent/taskExecution.ts`

- [x] **Step 1: Detect large task without matching plan before streaming**
- [x] **Step 2: Create or recover a fallback plan instead of silently dropping to generic tool loop**
- [x] **Step 3: Stop blocked/completed plans from running tools outside a step**
- [x] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=@ava/shell`

### Task 4: Verification

**Files:**
- Modify only files touched above if verification reveals issues.

- [x] **Step 1: Run policy tests**

Run: `node apps/shell/src/lib/agent/taskExecutionPolicy.test.mjs`

- [x] **Step 2: Run typecheck**

Run: `npm run typecheck --workspace=@ava/shell`

- [x] **Step 3: Run built-in smoke tests**

Run: `npm run test:builtins`
