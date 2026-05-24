# AGENTS.md instructions for apps/daemon

`apps/daemon` is the Ava Core Runtime boundary.

Keep UI/window/tray/Electron wrapper behavior in `apps/shell`.
Keep agent execution, model/provider runtime, tool dispatch, MCP supervision, process registry, plugin runtime, environment drivers, logs, and task recovery behind this daemon boundary.

This first phase is a facade over the existing Electron runtime files so Ava stays working while the core is extracted incrementally.
