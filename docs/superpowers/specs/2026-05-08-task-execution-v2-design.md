# Task Execution v2 Design

Date: 2026-05-08
Status: Draft

## Goal

Make large coding/design tasks stay inside Ava's task engine from start to finish.

The current failure mode is not just `MAX_TOOL_LOOP = 10`. The deeper issue is that a large task can lose its `TaskExecutionPlan` binding and fall back to the generic tool loop. Once that happens, the model may keep reading, writing, or inspecting until the hard loop limit stops it.

Task Execution v2 keeps Ava's current TypeScript runtime. It does not switch to LangGraph. LangGraph is only used as a comparison point for missing runtime guarantees: typed state, checkpoints, controlled transitions, retry policy, and observability.

## Non-Goals

- Do not replace Ava runtime with LangGraph.
- Do not add a Python sidecar.
- Do not redesign the UI.
- Do not solve every planning problem in this pass.
- Do not simply raise the global loop limit.

## Core Rules

1. Large tasks must always have a `TaskExecutionPlan`.
   - Coding/design/app/site/3D/long-running tasks must not execute as a plain chat tool loop.
   - If dynamic planning fails, Ava must create the fallback coding/design plan.
   - If no valid plan exists, Ava blocks execution instead of free-running tools.

2. `taskId`, plan, step, and stream must stay bound.
   - `activeTaskPlan.taskId !== activeTaskId` must not silently discard the plan.
   - Ava should recover a compatible plan by goal and working directory when possible.
   - If recovery is impossible, Ava must re-plan or ask the user, not continue as generic tool-use.

3. Retry and continue must resume the same plan.
   - Completed, skipped, failed, validation state, current step, and attempts must persist.
   - Retry should continue from the current file state.
   - Retry must not restart the task from the original user prompt unless the user explicitly asks.

4. No active step means no unbounded tools.
   - If the plan is completed, only final reporting is allowed.
   - If the plan is blocked, Ava must stop and surface the blocker.
   - If the plan is missing, Ava must stop or create a plan before tool execution.

5. Final report must not become another investigation phase.
   - It should primarily use accumulated tool results, changed files, validation output, and task plan state.
   - It may use a small number of read/list calls to verify details.
   - After the final-report read budget is spent, Ava must produce the report.

## Dynamic Tool Loop Budget

Replace the fixed global `MAX_TOOL_LOOP = 10` behavior with a step-aware budget.

The budget is not permission to freestyle. It is the maximum number of model-tool rounds allowed for the current task step.

Suggested defaults:

| Step type | Budget |
|---|---:|
| inspect/project map | 8-12 |
| scaffold/write files | 20-40 |
| install dependencies | 6-12 |
| start preview/server | 4-8 |
| console/screenshot check | 4-8 |
| repair | 12-20 |
| validate | 6-12 |
| final report | 3-5 |

Hard cap: 50 rounds per step.

If a step reaches its budget:

- Ava records the recent tool calls and step state.
- Ava does not continue the same step blindly.
- Ava either marks the step blocked, skips only when policy allows it, or asks for user direction.

## Step Completion Gate

Every tool call must be associated with the active step.

A step completes only when one of these is true:

- A required tool succeeds.
- A step-specific completion signal is detected.
- A validator confirms the expected state.
- The step has no required tools and visible final content is produced.

For large tasks, successful tool calls should usually return control to the task engine instead of letting the same LLM run continue indefinitely.

## Plan Recovery

When a stream starts:

1. Load the conversation's `activeTaskPlan`.
2. If its `taskId` matches `activeTaskId`, use it.
3. If it does not match, search recent conversation task plans or messages for the same working directory and compatible goal.
4. If compatible, rebind the plan to the active task or resume it under the existing task id.
5. If not compatible, create a new fallback plan or block execution.

Silent fallback to plain tool loop is forbidden for large tasks.

## Final Report Policy

Final report input should include:

- task goal
- completed/skipped/failed steps
- changed files from tool audit where available
- validation results
- preview/console/screenshot status
- remaining risks

Allowed final-report tools:

- `file.read_text`
- `file.list_dir`
- `git.diff`
- `project.validate` only if validation was not already run

Default final-report read/list budget: 3.

## Observability

Add step-level trace data to complement existing tool audit logs:

- `taskId`
- `streamId`
- `stepId`
- step title
- step attempt
- loop budget
- loop count used
- stop reason
- completion decision
- recent tool summary

This should make future failures explain whether the model looped, the step gate failed, or plan binding was lost.

## Acceptance Criteria

- A large task cannot execute tools unless a `TaskExecutionPlan` exists.
- A task with mismatched `activeTaskPlan.taskId` no longer silently drops into generic tool loop.
- Tool loop budget is derived from the active step, with a hard cap.
- Final report cannot spend more than its read/list budget.
- Retry/continue resumes the same task plan state.
- When stopping, Ava reports the exact step, budget, recent tools, and recovery option.
- Existing small chat/tool requests still work without requiring a task plan.

## Implementation Notes

Likely files:

- `apps/shell/src/components/ChatView.tsx`
- `apps/shell/src/lib/agent/chat.ts`
- `apps/shell/src/lib/agent/taskExecution.ts`
- `apps/shell/electron/llm.ts`
- `apps/shell/electron/services/toolAuditLog.ts`
- `apps/shell/src/types.ts`

The safest first implementation is conservative:

1. Detect and block large-task generic tool execution.
2. Add step-aware loop budget.
3. Add final-report read budget.
4. Add plan recovery.
5. Add step trace fields.

