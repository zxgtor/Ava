# Feature Test Planner

Use this skill when the user wants to test an Ava feature manually and needs a concrete message to send plus expected results.

## Output Format

When asked to test a feature, respond with exactly these sections:

1. `Test ID`
   - Use a short stable id: `feature-name.short-case`.
   - Example: `agent-loop.project-map`.

2. `Message To Send`
   - Provide one copyable message.
   - The message must start with `[AVA-FEATURE-TEST:<test-id>]`.
   - The message must be specific enough that the expected behavior can be verified from the response and tool calls.

3. `Expected Result`
   - List the exact observable result.
   - Include required tool names if the feature depends on tools.
   - Include what should not happen.

4. `How To Check`
   - Tell the user that Ava will log this run automatically in dev mode.
   - Log file: `apps/shell/.ava-unit-test-workspace/unit-test-results.jsonl`.
   - Tell the user to say "check feature test log" after running the message.

## Test Message Rules

- Keep each test message focused on one feature.
- Prefer small deterministic checks before large workflow tests.
- If a feature needs an Active Folder, say so in the message.
- If the expected result requires a tool, say "must call <tool-name>" in the message.
- Do not ask the model to judge itself. Make the expected result externally checkable from tool blocks, files, logs, or visible UI state.

## Logging Contract

When the user sends a message beginning with `[AVA-FEATURE-TEST:<test-id>]`, Ava records:

- `id`: `feature-test:<test-id>`
- `kind`: `feature`
- `name`: `<test-id>`
- `request`: the exact user message
- `status`: `passed` only if the assistant run completed without app-level error; this is not the final correctness verdict
- `toolCalls`: tool names, statuses, args, and errors
- `fullContent`: visible assistant response
- `stopReason`: if the LLM stopped due to output/tool/server limits

The correctness verdict is made by comparing this log with the `Expected Result`.
