# Hub join implementation report

**Built**

- Advertises `_wisp._tcp` with `bonjour-service`, the actual listening port, a stable ID in the data directory, and the specified TXT fields; refreshes the workspace name and withdraws the service on shutdown.
- Implements unauthenticated computer join requests, six-digit codes, ten-minute expiry, per-peer limits, secret-protected polling, owner approval/denial, and one-time delivery of the existing device record/token kind.
- Publishes `join_request` and `join_request_done` through the existing event stream to owners of the matching workspace; lists pending requests without secrets.
- Persists hashed, multi-use, 24-hour device invites; serves `/join/:secret` with the invite and a shell-quoted installer command.
- Shares reachable-address filtering between pairing, reach listings, and invite selection; phone pairing routes and credentials retain their existing flow.
- Defaults new accounts and previously unset experience preferences in newly created workspaces to Simple; preserves an explicit Advanced choice.
- Rewrites the hub-served installer for `join [invite]`, with a Bash wrapper that also works through `sh -s join`; recognizes native join support without injecting a second implementation.
- Adds a managed Cloudflare tunnel option beside the existing Tailscale API, with private credential storage, startup restoration, shutdown cleanup, connection/error status, and ingress hostname discovery.

**Files**

| Area | Files |
| --- | --- |
| Discovery | `src/discovery.ts`, `src/main.ts`, root `package.json` and `package-lock.json` |
| Joins and invites | `src/join.ts`, `src/api.ts`, `src/db.ts`, `packages/core/src/protocol.ts` (shared event types only) |
| Reach and lifecycle | `src/reachable-addresses.ts`, `src/pairing.ts`, `src/reach.ts`, `src/api-reach.ts`, `src/hub.ts`, `src/app.ts` |
| Simple defaults | `src/store.ts`, `src/api-orgs.ts` |
| Tests | `test/join.test.ts`, `test/cloudflare.test.ts`, `test/discovery.test.ts`, `test/reachable-addresses.test.ts`, `test/install.test.ts`, `test/settings.test.ts` |

Paths without a prefix are relative to `apps/hub`.

**Validation**

- Ran `npm ci` before implementation because dependencies were absent.
- `npx vitest run apps/hub/test --maxWorkers 2 --exclude '.claude/**'`: **38 files, 362 tests passed**.
- After the final discovery cleanup and reach-address response adjustments, `npx vitest run apps/hub/test/cloudflare.test.ts apps/hub/test/discovery.test.ts apps/hub/test/reach.test.ts --exclude '.claude/**'`: **3 files, 12 tests passed**.
- `npm run typecheck`: **passed**, including the web TypeScript project.
- Real main-entry smoke check with a temporary data directory and an ephemeral listening port: **started with mDNS and shut down cleanly on SIGTERM**.
- `git diff --check`: **passed**.
- The initial full run exposed an old preference assertion that omitted the new Simple default; it was updated. A subsequent unrestricted parallel run timed out in an existing connector test; the full run with two workers passed.

**Integration details and assumptions**

- The role model contains `owner`, `member`, and `guest`; `owner` provides the contract's owner/admin permissions.
- LAN joins without an invite target the first workspace, matching the advertised name; invites target the workspace that issued them.
- Pending requests live in memory and must be recreated after a restart; invite hashes and expirations survive restarts.
- Requests carrying forwarding headers require an invite even when their socket peer is local, preventing a public reverse proxy from unintentionally granting LAN access.
- `POST /api/reach/cloudflare` accepts `{ "action": "start", "token": "…", "url": "https://optional-origin.example" }` or `{ "action": "stop" }`; it requires an owner. Poll `GET /api/reach` for `cloudflare: { state, url, error }`. The optional URL is an override; otherwise the origin is discovered from cloudflared's structured ingress messages for this Wisp's local HTTP service.
- Cloudflare assumes `cloudflared` is installed and the remotely configured tunnel routes a domain to `http://127.0.0.1:4747` (or the configured hub port). The binary can be selected with `WARREN_CLOUDFLARED`. Credentials are passed through `TUNNEL_TOKEN` and persisted in the data directory with mode `0600`; they are absent from API status responses and process arguments. See [Cloudflare run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).
- **Desktop follow-up:** the tray's Copy address implementation is outside this run's ownership. It can consume the new ordered `addresses` array from authenticated `GET /api/reach`, which uses the shared filtering and places the active HTTPS origin first, or integrate `apps/hub/src/reachable-addresses.ts`. No desktop files were changed here.
- No live Cloudflare credentials were available; its process lifecycle and output handling were tested with injected processes. The startup smoke test exercised real mDNS startup/cleanup, rather than discovery from a second physical device.
- The root installer, `/mcp` routes, and `packages/mcp` were not modified. `JOIN-SPEC.md` was not committed. No changes were pushed.
