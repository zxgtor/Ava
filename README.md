# Ava

Minimal Electron shell with a Cowork-compatible plugin runtime.

## Status

Phase 0 — scaffold. Window boots, nothing else works yet. See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Dev

```bash
npm install
npm run dev
```

## Layout

```
apps/shell/               Electron main app (chat + settings + plugin manager)
packages/ava-plugin-sdk/  Types for plugin authors (Cowork format mirror)
packages/ava-mcp/         MCP client wrapper
plugins/ava-core/         Bundled first-party plugins
user-plugins/             User-installed plugins (gitignored, runtime-loaded)
```
