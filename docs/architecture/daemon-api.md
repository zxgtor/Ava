# Ava Daemon API

`apps/daemon` is the runtime boundary for desktop, web, and mobile clients.
Clients should use `@ava/client-sdk` instead of importing shell or daemon
implementation files directly.

## Package Boundary

- `apps/daemon`: owns runtime services, model routing, MCP supervision, tools, and HTTP/SSE/WebSocket transport.
- `apps/shell`: owns Electron windows, tray, native app lifecycle, and preload bridging.
- `packages/contracts`: owns stable DTO and event types.
- `packages/client-sdk`: owns daemon client access for desktop, web, and mobile.

`apps/daemon` must not import from `apps/shell` or Electron.

## HTTP API

- `GET /health`
- `GET /runtime/status`
- `GET /settings/load`
- `POST /settings/save`
- `GET /mcp/servers`
- `POST /mcp/restart`
- `POST /plugins/list`
- `POST /plugins/list-commands`
- `POST /plugins/marketplace`
- `POST /plugins/install-git`
- `POST /plugins/install-folder`
- `POST /plugins/install-zip`
- `POST /plugins/uninstall`
- `POST /plugins/update`
- `GET /tool-audit/list`
- `POST /tool-audit/clear`
- `POST /dev/unit-test-context`
- `POST /dev/unit-test-results/append`
- `GET /dev/unit-test-results/read`
- `POST /dev/unit-test-results/clear`
- `POST /chat/stream`

HTTP JSON APIs return either `{ "ok": true, "result": ... }` or
`{ "ok": false, "error": "..." }`, except `/health` and `/runtime/status`,
which return daemon status directly for cheap liveness checks.

## SSE API

`POST /chat/stream` streams `AvaChatStreamEvent` frames as Server-Sent Events.
This is the default chat runtime path used by the desktop preload bridge.

## WebSocket API

`/chat/ws` accepts one JSON `AvaDaemonChatRequest` message after connection and
then streams JSON `AvaChatStreamEvent` messages until `chat.run.completed` or
`chat.run.failed`.

This exists for future web/mobile runtimes that prefer bidirectional transport.
The current desktop app still defaults to SSE because it is simpler and easier
to proxy through preload.

## Client Rule

All first-party clients should depend on `@ava/client-sdk`. They should not:

- Import runtime services directly.
- Depend on Electron IPC for agent runtime behavior.
- Send provider config when daemon-owned model routing is enabled.
