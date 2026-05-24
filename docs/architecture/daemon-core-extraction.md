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

- No HTTP daemon.
- No SSE API migration.
- No renderer IPC rewrite.
- No storage migration.
- No physical relocation of `llm.ts` or service implementations yet.

## Next Safe Steps

1. Move pure/shared runtime types into `packages/contracts`.
2. Move provider/model adapters from `apps/shell/electron/adapters` into `apps/daemon/src/adapters`.
3. Move pure services one by one into `apps/daemon/src/services`.
4. Keep Electron-specific services, such as window/DWM behavior, in `apps/shell`.
5. Add API/SSE only after the core can be imported independently.
