# Contributing to Wisp

Thanks for helping out. Wisp is a TypeScript monorepo using npm workspaces.

```bash
npm install
npm run dev        # hub on :4747 (data in ./data) + web dev server on :5173
npm test           # vitest: core, vault, adapters, hub integration tests
npm run typecheck
```

Open http://localhost:5173 during development; it proxies the API to the hub.

## Where things live

- `apps/hub/src/api.ts`: HTTP and WebSocket routes, permission checks
- `apps/hub/src/hub.ts`: message routing, agent runs, the loop guard, prompt building
- `apps/hub/src/store.ts`: all SQL
- `packages/vault`: the markdown vault (files on disk are the source of truth; the SQLite index can be rebuilt; it also watches the folder for edits made in Obsidian)
- `apps/hub/src/vault-git.ts`, `vault-location.ts`, `api-memory.ts`: the vault served over git for Obsidian's Git plugin, where the vault folder lives, and Settings → Memory's routes
- `packages/adapters`: one file per harness (see [docs/adapters.md](docs/adapters.md))
- `apps/web/src`: React UI (`views/` for screens, `store.ts` for state)

## Guidelines

- Keep the default experience simple; put advanced options one click deeper.
- Every vault change must stay a plain markdown file plus a git commit, so users can always leave with their data.
- New API routes check access through `can()` from `@wisp/core`; agents never see another agent's private scope without a grant.
- Add a test with each fix or feature. Integration tests in `apps/hub/test` start a real hub on a random port.

## Installing and releasing

- `install.sh` and `install.ps1` are what new people run first. The hub serves them at `/install.sh` and `/install.ps1` for **Devices → Add device**, and the Installer workflow runs them on Linux, macOS and Windows. Keep them working without sudo or admin rights.
- `wisp service` (`apps/node/src/service.ts`) keeps a hub or device running with launchd, systemd or Task Scheduler.
- Pushing to `main` publishes the hub image (`ghcr.io/<owner>/wisp:latest`). Pushing a tag like `v0.2.0` also publishes `:0.2.0` and a GitHub release with generated notes.

By contributing you agree your work is licensed under Apache-2.0.
