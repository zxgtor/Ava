# Daemon Core Extraction

## Goal

Move Ava's agent runtime toward an Open Design style boundary without breaking the current Electron app.

The target shape is:

- `apps/shell`: desktop UI, windows, tray, Electron IPC wrapper.
- `apps/daemon`: Ava Core Runtime.
- `packages/contracts`: shared DTOs and stream event contracts in a later phase.

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

`/mcp/servers` intentionally reports an unattached runtime for now. The MCP
supervisor still runs inside Electron main until a later migration moves the
runtime services behind the daemon boundary.

## Next Safe Steps

1. Move pure/shared runtime types into `packages/contracts`.
2. Move provider/model adapters from `apps/shell/electron/adapters` into `apps/daemon/src/adapters`.
3. Move pure services one by one into `apps/daemon/src/services`.
4. Keep Electron-specific services, such as window/DWM behavior, in `apps/shell`.
5. Replace renderer-to-Electron agent IPC with renderer-to-daemon API/SSE after the core can be imported independently.
