# Desktop join handoff

## Built

- Welcome with the one-piece ghost, white background, dark primary buttons, Start Wisp and Join my Wisp, plus Other ways revealing Hetzner and Docker instructions.
- Start reuses the existing local startup/device path and opens `#/welcome/intro` for web onboarding.
- Join lists `_wisp._tcp` services after a four-second Bonjour scan in the main process, accepts invite links or ordinary addresses, requests approval, shows the spaced six-digit code, and polls every two seconds.
- Waiting handles approval, denial, expiry, cancellation and temporary connection failures; join secrets and device credentials never reach the renderer.
- Approval saves the existing desktop/node configuration and connects through the existing device startup path, restarting an installed service or starting the app-managed device without creating another device record.
- The tray's former Copy Server Address action is now Copy Wisp Address and filters container/VM interfaces, link-local addresses and non-Tailscale `utun` addresses.
- Packaged runtime dependencies include `bonjour-service`, loaded from Resources/warren in built apps.

## Files

- `src/setup.html`: screens, styling, discovery list and waiting interactions.
- `src/main.cjs`, `src/preload.cjs`: trusted setup IPC, approval persistence, startup and tray integration.
- `src/join.cjs`: invite parsing, Bonjour lifecycle and main-process join client.
- `src/addresses.cjs`: filtered reachable addresses.
- `package.json`, `scripts/bundle-warren.mjs`: discovery dependency and runtime packaging.
- `test/addresses.test.ts`, `test/join.test.ts`, `test/main.test.ts`, `test/setup.test.ts`: helper, HTTP protocol, IPC, service restart and renderer coverage.

## Verification

- Initial `npm ci`: passed before dependency changes.
- `npx vitest run apps/desktop/test --exclude '.claude/**'`: 106 tests passed across 10 files.
- `npm run typecheck`: passed.
- `node --check` on modified/new CJS modules and the bundling script: passed.
- `git diff --check`: passed.
- Live Bonjour publish/browse smoke test: discovered the test Wisp and closed successfully.
- Electron rendered Welcome, Join and waiting screenshots with a mock setup preload: visually checked.
- Final `npm ci --dry-run --ignore-scripts`: reports the missing new dependency in the root lockfile, as expected until the integration action below.

## Integration action and assumptions

- **Refresh root `package-lock.json` after combining the parallel runs**, using `npm install --package-lock-only`; it must record desktop's `bonjour-service` dependency and its transitive dependencies before `npm ci` can pass again. Root files are outside this run's ownership and were left untouched.
- Approval uses the origin that successfully accepted the join request, rather than switching to a potentially unreachable `hubUrl` such as the owner's localhost.
- Protocol expiry values are ISO timestamps, matching existing hub API conventions.
- Scoped IPv6 link-local addresses are also excluded because browser URLs cannot use them reliably; LAN IPv4 and IPv6 ULA/global addresses remain available.
- The shared protocol issues a device credential, not a web account session, so web sign-in remains the existing behavior.
- Combined hub/web end-to-end approval and signed release packaging were not run; those depend on the other parallel changes and release tooling.
- Only `apps/desktop/**` changed; `JOIN-SPEC.md` was neither changed nor committed, and nothing was pushed.
