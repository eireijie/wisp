# Wisp on every platform (2026-10-25)

## How each app is built

| App | What it is | Where its features come from |
|---|---|---|
| **Web** (`apps/web`) | The full React app, served by the hub | The reference: every feature lives here |
| **Desktop** (`apps/desktop`) | Electron window that loads the hub's web app, plus a tray, local hub, this computer as a device, screen code, desk buddy, auto-update | The web app, plus desktop-only extras |
| **Android** (`apps/android`) | Native pairing screen, then a WebView of the hub's web app (phone layout), plus native push | The web app |
| **iPhone** (`apps/ios`) | Fully native SwiftUI app | Its own screens, built to match the web |

## What was missing, and what fills it now

### Desktop

| Feature | Was | Now |
|---|---|---|
| Notifications | Web Push fails in Electron | Web Push isn't offered; notifications arrive while Wisp runs in the menu bar, and clicking one brings the window back |
| Open in Obsidian | `obsidian://` blocked by the window | Handed to the Obsidian app |
| Voice listening | Browser engine errors in Electron | Not offered; OpenAI listening is used instead |

### Android

| Feature | Was | Now |
|---|---|---|
| Push notifications | None | FCM, sent by the hub alongside APNs. The hub owner brings their own Firebase project (see `docs/deploy.md`); with none, the app stays quiet |

### iPhone

| Area | Added |
|---|---|
| Chat | `/` command menu; pin and unpin; a note on approve/deny; live streaming replies; per-chat drafts; a new chat after 2.5 quiet hours with a dated divider and "Continue this chat"; right-click / press-and-hold menu with quick reactions; swipe right to open a thread |
| DM controls | Access chip (read only / edit files / full); context ring with Compact |
| Search | Search messages, notes, teams and agents from the Chats tab |
| Inbox | What agents are doing, new replies, recent chats, tasks to check, setup card, allowance |
| Help | Help screen from You |
| Agents | Permissions; Connect (MCP token) and invite an outside agent; import from a device; computer and where the harness runs; personality history and template; connected apps; voice |
| Computers | Add, rename, start, stop, remove; save screenshot; files; clipboard and open a link; details and activity; hand back with a note; teach a task |
| Memory | Home with recent changes and most linked; graph; activity; who wrote what; view as an agent; properties and connected notes; folder picker; journal |
| Marketplace | One Marketplace (All / Apps / Skills / On your devices / Installed); hub skill store; bring in from devices; try a skill; trust labels |
| Settings | Ask an agent + recently changed with Undo; workspace lead; Harnesses; Access (Tailscale / Cloudflare); Devices and connected MCP apps; approve computers asking to join + join link; color theme, text size, reduce motion; memory rules |
| Voice | Voice calls with agents; mic and speaker test |

## Still different on purpose

- Desktop only: tray, setup window, local hub, this computer as a device, screen code, auto-update, desk buddy window, Dock badge, open a harness's settings file.
- Phone only: QR pairing, APNs/FCM, Quick Look, paste to and copy from the phone.
- Not on phones: pairing a phone, first-account setup (both done on a computer).
- Screen lending: removed from Wisp on purpose.

## Small gaps left

- iPhone: no composer model picker (the agent page has one); search lands on the chat or thread, not the exact message; teach records single taps only; calls pause when Wisp goes to the background.
- Android: no per-kind notification switches or launcher badge yet.
- Nobody pushes "finished task" notifications yet (iPhone shows a local one while open).
