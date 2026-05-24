# Ava Daemon

Standalone Ava core runtime daemon.

## Install From Packed Artifact

From the monorepo:

```bash
npm run pack:daemon
npm install ./ava-daemon-0.0.1.tgz
```

Run:

```bash
ava-daemon
```

The daemon listens on `127.0.0.1:17871` by default.

Environment overrides:

- `AVA_DAEMON_HOST`
- `AVA_DAEMON_PORT`
- `AVA_USER_DATA_DIR`
- `AVA_PROJECT_ROOT`
- `AVA_RESOURCES_DIR`

## API

- HTTP: `GET /health`, `GET /runtime/status`, settings, MCP, plugins, tool audit, and dev unit-test routes.
- SSE: `POST /chat/stream`
- WebSocket: `/chat/ws`

First-party clients should use `@ava/client-sdk`.
