# Wisp web setup report

All repository changes are inside `apps/web/**`; `JOIN-SPEC.md` was read first and was not changed or committed. Nothing was pushed.

## Built

- Replaced the welcome flow with Getting ready, Make your first agent, Away from home, and Add your phone and other computers, with a four-segment progress bar.
- Added live readiness checks, profile/workspace naming, Atlas by default, detected harness sign-in state, existing harness installation/sign-in controls, and explicit skips.
- Removed the Simple/Advanced question from onboarding and new organization creation; first setup explicitly requests Simple features and saves Simple experience.
- Preserved detected harness accounts on their device while assigning a prepared computer; bundled harnesses can run inside their own computer.
- Shared phone QR pairing and computer download/invite instructions between onboarding and Add a device, with approval rather than copied credentials for new computers.
- Added the global owner/admin approval dialog using the existing event stream, pending-request recovery, formatted six-digit codes, approve/deny actions, and removal after another window decides.
- Added `#/settings/devices`, its device list and Add a device dialog, the Away from home switch, and the “Grok, ChatGPT and Claude” section with the specified copy and connector instructions.
- Connected the external-app switch to Tailscale Funnel; private Serve and local-network HTTPS addresses are not offered as public connector addresses.
- Added connected-app listing/disconnection, hiding the list without an error when `GET /api/mcp/clients` returns 404.
- Used existing CSS tokens and plain lucide line icons; no colored letter tiles.

## Files

Paths below are relative to `apps/web/`.

| Area | Files |
| --- | --- |
| Onboarding and defaults | `src/onboarding.ts`, `src/views/WelcomeView.tsx`, `src/views/AuthScreen.tsx`, `src/components/OrgSwitcher.tsx` |
| Shared device pairing | `src/components/AddDevice.tsx`, `src/views/settings/mobile.tsx`, `src/views/NodesView.tsx` |
| Reach | `src/access.ts`, `src/components/Access.tsx` |
| Join approval and API compatibility | `src/join.ts`, `src/components/JoinApproval.tsx`, `src/App.tsx` |
| Devices settings and routing | `src/views/settings/devices.tsx`, `src/views/SettingsView.tsx`, `src/router.ts` |
| Reused harness sign-in export | `src/views/settings/harnesses.tsx` |
| Tests | `src/join.test.ts`, `src/components/JoinApproval.test.tsx`, `src/components/Access.test.ts`, `src/views/WelcomeView.test.tsx`, `src/views/settings/devices.test.tsx`, `test/onboarding.test.ts`, `test/helper-readiness.test.ts`, `test/settings-nav.test.ts` |
| Report | `JOIN-WEB-REPORT.md` |

## Validation

- `npm ci`: passed; dependencies were initially absent.
- `npx vitest run apps/web --exclude '.claude/**'`: 51 files and 344 tests passed.
- After the final public-address validation change, the reach and Devices settings suites passed again: 10 tests.
- `npm run typecheck`: passed, including root and web TypeScript checks.
- `npm run build -w @warren/web`: passed; Vite reports its standard large-chunk warning.
- `git diff --check`: passed.
- Browser visual inspection was attempted, but this session exposes no browser. No live end-to-end join with the parallel hub implementation was possible here.

## Assumptions and remaining integration

1. Join requests, decisions, invites, and events use the exact routes and payloads in `JOIN-SPEC.md`. Pending requests and MCP clients accept either a plain array or a `{ requests: [...] }` / `{ clients: [...] }` envelope. Unsupported join/invite/pair/reach features degrade gracefully.
2. The spec does not define the Cloudflare API. The web isolates an assumed `POST /api/reach/cloudflare` with `{ token }`, returning the regular reach response, and `DELETE /api/reach/cloudflare` to stop it. Its optional reach field is `cloudflare: { enabled, publicUrl }` (`url` is also accepted). These routes are absent in this checkout and require agreement/support from the hub run; 404 shows a recoverable message.
3. The spec does not define the disconnect method. The web assumes `DELETE /api/mcp/clients/:id`; the hub/MCP implementation must support it.
4. The external-app switch controls public reach, because no independent MCP enable/disable endpoint is specified. Turning Funnel off retains private Serve access; stopping Cloudflare also disables away-from-home access through that tunnel. For a pre-existing public domain, the web cannot disable public exposure: it retains the real On state and directs the owner to disconnect apps. An independent MCP enable/disable API is needed for an independent off switch in that deployment.
5. Background preparation of this computer and its VM engine belongs to the existing device/installer services; the web reports their state. New non-bundled harness installation uses the existing npm-install API; Hermes is offered for automatic use inside a prepared computer where it is bundled.
6. Phone pairing still uses the existing `/api/pair` flow; no phone pairing protocol, `/mcp` implementation, hub code, desktop code, or shared package was changed.
