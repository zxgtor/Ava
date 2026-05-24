# Windows Environment Driver

Ava should treat Windows MCP as an environment-level driver, not as a normal planner tool.

## Why Windows MCP Is Environment-Level

Windows MCP controls the user's operating environment: screen state, windows, input, UI observation, and eventually accessibility/OCR/grounding. These capabilities are different from ordinary task tools such as `file.read_text` or `git.diff`.

If the planner sees low-level Windows MCP tools directly, it can overfit to brittle details such as coordinates, screenshots, mouse movements, or OCR text. That makes tasks harder to resume, verify, and repair.

The core runtime should depend on a semantic environment interface instead:

- `observe()`
- `queryState()`
- `act()`
- `subscribeEvents()`
- `verifyResult()`

The Windows driver may internally use Windows MCP, accessibility, screen capture, OCR, UI grounding, PowerShell, process/window tracking, and mouse/keyboard input. Ava Core should not depend on those details.

## Why Planner Should Use Semantic Actions

The planner should express intent, not mechanics. For example:

- Prefer: "open the target app", "click the primary Save button", "verify the page loaded".
- Avoid: "move mouse to x=513 y=778", "OCR the whole screen", "click the third detected rectangle".

Semantic actions are easier to validate and retry. They also allow the driver to choose the best deterministic route for the current environment: API first, then MCP/accessibility/CLI/DOM, and only then vision.

## Why Vision/OCR Is Fallback

Vision and OCR are useful when deterministic interfaces are missing, but they are noisy and expensive. They can misread text, miss hidden state, and break under different DPI/theme/window layout.

Ava should prefer deterministic paths in this order:

1. App/API
2. Environment driver semantic APIs
3. Accessibility tree
4. CLI/PowerShell
5. DOM
6. Vision/OCR fallback

## Current Implementation

The first implementation keeps behavior unchanged and only adds the abstraction boundary:

- `EnvironmentDriver` defines the stable driver interface.
- `WindowsEnvironmentDriver` implements that interface.
- Existing `windows-mcp.*` calls are routed through `WindowsEnvironmentDriver.act()`.
- Non-Windows MCP tools still use `mcpSupervisor` directly.
- The planner and task business logic are not changed yet.

## TODO

- TODO: Add semantic Windows actions on top of low-level Windows MCP calls.
- TODO: Integrate OCR as a fallback observation source.
- TODO: Integrate UI grounding for visual fallback actions.
- TODO: Integrate accessibility tree observation and targeted element actions.
- TODO: Integrate Windows/process/window event stream via `subscribeEvents()`.
- TODO: Add stronger `verifyResult()` implementations that re-observe the environment after actions.
