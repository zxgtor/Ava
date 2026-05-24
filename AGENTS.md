# Ava Architecture Direction

Ava is not a simple tool-calling chatbot. Ava should be designed as an AI runtime with:

- Planner
- Memory
- Capability Router
- Environment Drivers
- Event Bus
- Automation Runtime
- Model Router

## Important Rule

Do not treat Windows MCP as just another tool.

Windows MCP should be abstracted as part of the Windows Environment Driver.

The planner should not call low-level screenshot, OCR, mouse, keyboard, or coordinate APIs directly.

Instead, expose semantic environment APIs:

- observe()
- query_state()
- act()
- subscribe_events()
- verify_result()

## Execution Priority

Prefer deterministic interfaces before vision:

1. API
2. MCP
3. Accessibility
4. CLI
5. DOM
6. Vision/OCR fallback

## Windows Driver

The Windows Driver may internally use:

- Windows MCP
- screen capture
- OCR
- accessibility tree
- UI grounding
- mouse/keyboard input
- PowerShell/CLI
- process/window tracking

But Ava Core should only depend on the abstract Environment Driver interface.