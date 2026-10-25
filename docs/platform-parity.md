# Wisp on every platform: what each app has (2026-10-25)

## How each app is built

| App | What it is | What that means for features |
|---|---|---|
| **Web** (`apps/web`) | The full React app, served by the hub | The reference: every feature lives here |
| **Desktop** (`apps/desktop`) | Electron window that loads the hub's web app, plus a tray, local hub, this-computer-as-device, screen code, desk buddy, auto-update | Has every web feature; a few break inside Electron (below) |
| **Android** (`apps/android`) | Native pairing screen, then a WebView of the hub's web app (phone layout) | Has every web feature; nothing native beyond pairing, file picker, mic |
| **iPhone** (`apps/ios`) | Fully native SwiftUI app | Has a lot already; many web features still missing (below) |

## Desktop: web features that break inside Electron

| Feature | Problem |
|---|---|
| Push notifications (Settings → Notifications) | Electron has no Web Push service, so turning it on fails |
| Open in Obsidian | `obsidian://` links are blocked by the window's navigation lock |
| Voice "browser" listening engine | Chromium in Electron has no Google speech key, so it errors |

## Android: missing

| Feature | Problem |
|---|---|
| Push notifications | None. iPhone has APNs; Android has no FCM, so nothing arrives while the app is closed |

## iPhone: missing compared with web

| Area | Missing on iPhone |
|---|---|
| Chat | `/` slash-command menu; adding reactions; pinning messages; note on approve/deny; live streaming replies; per-chat drafts |
| DM controls | Access level chip (read only / edit files / full); context ring with compact |
| Search | Global search across messages, notes, channels, agents (`/api/search`) |
| Inbox | What agents are doing, tasks to check, recent conversations, setup readiness card |
| Agents | Permissions page (access level, shared folders); Connect (MCP token for outside agents); import an agent from a device; assign an existing computer and where the harness runs; personality history and templates; agent voice |
| Computers | Add a computer (VM / Orgo); rename, start, stop, remove; save screenshot; remote files (browse, download, upload, new folder); details and activity log; teach a task |
| Memory | Graph view; activity feed; who-wrote-what (blame); view as an agent; recent changes on the memory home |
| Marketplace | Hub skill store; "On your devices" (bring in apps and skills found on devices); try a skill |
| Settings | Recently changed with Undo + ask an agent to change a setting; workspace lead; Harnesses page; Access (Tailscale / Cloudflare); Devices page (connected MCP apps); approve computers asking to join + join codes; connected OAuth apps per agent; color theme and text size; Help page |
| Voice | Voice calls with agents |

## Not counted as gaps

- Desktop-only by nature: tray, setup window, local hub engine, this computer as a device, screen code, auto-update, desk buddy window, Dock badge.
- Phone-only by nature: QR pairing, APNs, Quick Look, paste to/copy from the phone.
- Pairing a phone from a phone, and first-account setup on the phone (done on a computer).
- Screen lending, which the Wisp branch removed on purpose.
