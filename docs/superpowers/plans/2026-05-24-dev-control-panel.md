# Dev Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dev-only process control panel that can start, stop, restart, and inspect Ava development services from the daemon test UI.

**Architecture:** Add an independent `apps/dev-control` HTTP service on `127.0.0.1:17872`; it supervises dev processes and exposes a small JSON API. `apps/daemon-test-ui` consumes that API in a new Dev Panel tab. The daemon remains focused on runtime APIs and does not supervise itself.

**Tech Stack:** Node.js HTTP server, React/Vite daemon test UI, monorepo npm workspaces.

---

### Task 1: Add Dev Control Service

**Files:**
- Create: `apps/dev-control/package.json`
- Create: `apps/dev-control/src/server.mjs`
- Modify: `package.json`

- [ ] Add a workspace package named `@ava/dev-control`.
- [ ] Implement `GET /health`, `GET /processes`, `GET /processes/:id/logs`.
- [ ] Implement `POST /processes/:id/start`, `POST /processes/:id/stop`, and `POST /processes/:id/restart`.
- [ ] Track managed child processes and retain bounded stdout/stderr logs.
- [ ] Detect externally running services by probing known local ports.
- [ ] Bind only to `127.0.0.1`.

### Task 2: Add Dev Panel UI

**Files:**
- Modify: `apps/daemon-test-ui/src/App.tsx`
- Modify: `apps/daemon-test-ui/src/styles.css`

- [ ] Add a `dev` tab to the daemon test UI sidebar.
- [ ] Load process state from `http://127.0.0.1:17872/processes`.
- [ ] Render service cards for Ava Desktop, daemon, daemon test UI, and future web UI.
- [ ] Add Start, Stop, Restart, and Refresh buttons.
- [ ] Show recent process logs.

### Task 3: Verify

**Commands:**
- `npm install --package-lock-only`
- `npm run typecheck --workspace=@ava/daemon-test-ui`
- `npm run build --workspace=@ava/daemon-test-ui`

