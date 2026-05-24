# Daemon Core Extraction

## Goal

Move Ava's agent runtime toward an Open Design style boundary without breaking the current Electron app.

The target shape is:

- `apps/shell`: desktop UI, windows, tray, Electron IPC wrapper.
- `apps/daemon`: Ava Core Runtime.
- `packages/contracts`: shared DTOs and stream event contracts.
- `packages/client-sdk`: stable daemon client for desktop, web, and mobile.

## Phase 1: Facade Boundary

This phase adds `apps/daemon` as the public import boundary for core runtime features while keeping the implementation in the existing Electron files.

Electron main now imports runtime features from `@ava/daemon`:

- `streamChat()`
- `abortStream()`
- `builtInTools`
- `mcpSupervisor`
- `pluginManager`
- `toolAuditLog`
- runtime/environment driver types

The implementation is still re-exported from `apps/shell/electron/**`. This keeps Ava working and gives the next migration steps a stable import seam.

## What This Does Not Change Yet

- No SSE API migration.
- No renderer IPC rewrite.
- No storage migration.
- No physical relocation of `llm.ts` or service implementations yet.

## Phase 2: Standalone Daemon Skeleton

This phase adds a separate local daemon process without moving business logic
out of Electron yet.

Run only the daemon:

```bash
npm run daemon:dev
```

Run the daemon and the current Electron shell together:

```bash
npm run start:with-daemon
```

The daemon listens on `127.0.0.1:17871` by default. Override with
`AVA_DAEMON_HOST` and `AVA_DAEMON_PORT`.

Available endpoints:

- `GET /health`
- `GET /runtime/status`
- `GET /mcp/servers`
- `GET /chat/stream`
- `POST /chat/stream`

`/mcp/servers` intentionally reports an unattached runtime for now. The MCP
supervisor still runs inside Electron main until a later migration moves the
runtime services behind the daemon boundary.

`/chat/stream` returns Server-Sent Events using the shared `@ava/contracts`
event names. It is a mock stream in this phase and does not call providers,
tools, MCP, or the current agent loop yet.

Electron main has an optional daemon client seam. Set
`AVA_CHAT_RUNTIME=daemon` or `AVA_USE_DAEMON_CHAT=1` to route
`ava:llm:stream` through the daemon SSE endpoint. By default, shell still uses
the existing in-process `streamChat()` runtime.

When `AVA_CHAT_RUNTIME=daemon` is set, Electron main also starts an embedded
daemon server with the real `streamChat()` runtime attached. This lets the
current shell test the daemon boundary before the runtime is fully moved into a
separate Node process. Do not also start `npm run daemon:dev` on the same port
for this test; that standalone daemon intentionally remains mock-only.

Dev test flow:

```bash
set AVA_CHAT_RUNTIME=daemon
npm start
```

Then open `Unit Test -> Daemon` and run `daemon.chat.runtime`.

## Phase 3: Standalone Node Runtime Smoke

The daemon can now also start as a Node process with the real `streamChat()`
runtime attached:

```bash
npm run daemon:runtime
```

This command builds `apps/daemon/src/runtimeMain.ts` into
`apps/daemon/out/runtimeMain.cjs` and starts `/chat/stream` with the current
agent runtime attached. `GET /runtime/status` should return
`runtimeAttached: true`.

The standalone runtime still receives provider settings and selected model
context from the shell request via `metadata.streamChatArgs`. It is not yet a
fully independent daemon with its own provider config loader or model router.

## Phase 4: Renderer Uses Node Daemon By Default

Electron shell now treats the Node daemon as the default runtime path. On app
startup, shell checks `GET /runtime/status`; if no attached daemon is available,
it starts `npm run daemon:runtime` in the project root and waits for
`runtimeAttached: true`.

Renderer chat calls now connect directly to daemon HTTP/SSE from preload:

```text
renderer -> preload -> daemon /chat/stream -> preload event tunnel -> renderer listeners
```

Electron IPC remains as a fallback path if the direct daemon connection cannot
be opened before any SSE event is received.

Renderer direct chat requests no longer send provider config, tool-format map,
or plugin states in `metadata.streamChatArgs`. They send only messages and
execution options. The daemon loads settings from its own storage, applies the
primary model chain, filters enabled providers, and injects daemon-owned
`modelToolFormatMap` and `pluginStates` before calling `streamChat()`.

Disable this path only for debugging:

```bash
set AVA_CHAT_RUNTIME=local
npm start
```

In daemon mode, these Electron IPC handlers proxy to daemon HTTP APIs:

- settings load/save
- chat streaming
- MCP list/restart
- plugin list/commands/marketplace/install/update/uninstall
- tool audit list/clear
- Unit Test context and Unit Test result log

Daemon chat streaming tunnels the original `ava:llm:*` runtime events back to
the shell, so tool blocks, part updates, status, reasoning deltas, and text
chunks continue to render through the existing UI listeners.

Disable direct renderer streaming only for debugging:

```bash
set AVA_RENDERER_DAEMON_STREAM=off
npm start
```

## Phase 5: Runtime Services Physically Live In Daemon

The runtime implementation files have been moved under `apps/daemon/src`:

- `llm.ts`
- provider adapters
- storage
- built-in tools
- MCP supervisor
- plugin manager
- tool runtime
- process registry
- runtime environment
- capability router/stats
- tool audit/result/error helpers
- Windows environment driver abstraction

The old `apps/shell/electron/**` paths are compatibility wrappers only. This
keeps existing Electron imports and tests working while making daemon the owner
of the agent runtime code.

## Next Safe Steps

1. Move non-chat renderer APIs from Electron IPC proxies to direct daemon APIs where appropriate.
2. Move MCP status push events from Electron `webContents` wiring to daemon event subscriptions.
3. Keep Electron-specific services, such as window/DWM behavior, dialogs, tray, and auto-updater, in `apps/shell`.

## Current API Boundary

Daemon now exposes stable HTTP/SSE/WebSocket transport:

- HTTP JSON: `/health`, `/runtime/status`, settings, MCP, plugin, tool-audit, and dev unit-test endpoints.
- SSE: `POST /chat/stream`.
- WebSocket: `/chat/ws`.

Desktop preload uses `@ava/client-sdk` for direct daemon chat streaming. Future
web/mobile clients should use the same SDK instead of calling shell IPC or
daemon internals.
