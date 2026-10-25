# Wisp v1 release checklist

Everything the user asked for, gathered from their notes and the commit history on 2026-10-23. Each line gets checked by hand on the real app (not just tests) before the public v1. Mark: ✅ works · 🟡 works with a caveat · ❌ broken · ⬜ not checked yet.

## Hub and web app
- ⬜ First-run setup: create the first account; Tailscale shown as setup step 1 ("Use Wisp from anywhere"); the hub computer becomes a device on its own
- ⬜ Sign in, invites (off by default, owner can turn on), people and roles, organization switcher, per-organization memory
- ⬜ Sidebar: Inbox, Agents, Channels, Computers, Mods, Settings; "More" holds Marketplace; search box doubles as the create menu
- ⬜ Inbox: action cards (approvals, waiting) and the allowance pill
- ⬜ Agents: directory with status; create agent one-screen (defaults / customize / advanced); device asked only when there's a real choice; import agents already on a device (single and bulk)
- ⬜ Agent page: overview, instructions and role, model/effort/fast, computer, background (one sentence with clickable words), routines, skills, permissions, look; leave guard on unsaved edits
- ⬜ Ghosts: look editor; accessories move with the face; moods from real work (working, done, waiting, error, asleep); poke and hover; the pet pill at the top of the DM; ghosts roam the sidebar
- ⬜ Chat: send, edit and delete own messages, attachments (max 20, Send waits for uploads), reactions, pins, @mention autocomplete, streaming replies, Stop a run, activity pill, change cards with Undo, per-conversation drafts
- ⬜ `/` commands: Discord-style popup with the agent rail, each agent's harness commands and skills, `/context` card with Compact
- ⬜ Channels: two-step creation with a required team flow chart; leads read new prompts; sub-threads; "who's working where"; Team tab with More (roles, memory folder, repo, reports to); rename, topic, members, private, archive, delete, star, mute; default answerer
- ⬜ Teams are channels: old Teams migrated on hub start; Lead picker in Settings → Agents; Merge button on finished task cards
- ⬜ Tasks: board, subtasks, delegation, attachments, cancel, approvals, review and branch merge, discussions with rounds and a decision
- ⬜ Routines: schedules with next-run preview, run now, Teach a task by demonstration on a screen
- ⬜ Background agents: one shared allowance (Settings → Usage); the agent paces its own checks; follow-ups; it messages you first in your DM; quiet hours; Check now
- ⬜ Agents change settings and add mods by chat, with an Undo summary ("Recently changed" in Settings)
- ⬜ Memory: browse, search, read, create, edit, delete notes; the native graph; the built-in memory skill; access rules and "view as agent"; About you (profile, plans, journal); history; Obsidian and git sync under Advanced
- ⬜ Computers: a VM per agent; the agent's desk; live screen (VNC and frames); click to take control, agents take it back; clipboard and file exchange; lend your own screen; agents borrow a device mid-task with approval; activity log
- ⬜ Screen code: a screen with a PIN or password asks for it on view, lend and loan approval; wrong tries and the 15-minute lockout; Remote Desktop on Linux and Windows
- ⬜ Devices: add and claim a device; phone pairing by QR with the 6-digit confirm; sharing and roles; runtime inventory, install and refresh; update a device
- ⬜ Marketplace: store layout with real logos; apps from the MCP Registry; skills from OpenAI, Anthropic and the community; Installed; "On your devices" bring-in of skills and connectors; log in to an app once in Wisp
- ⬜ Harness settings: Settings → Harnesses for all ten harnesses; model, plugins, connectors, skills; several accounts per harness and sign-in from Wisp; read-only where a harness can't be edited
- ⬜ Settings: 7 sections; "Ask <agent> to change anything"; appearance themes and text size; notifications and web push; voice provider; Access (Tailscale, Funnel); data export; Mods page with "ask an agent to make one"
- ⬜ Voice calls: hands-free turn-taking, interrupt mid-sentence, on-device voice by default, bring-your-own provider optional
- ⬜ Search and the command palette; Help page; "hub updated, reload" banner
- ⬜ Simple mode: machinery hidden; Advanced shows it

## Desktop app (Electron, apps/desktop)
- ⬜ Create a server on this computer, or join one; this computer becomes a device; the Welcome page hands the claim to the app
- ⬜ Menu bar status lines are honest (hub, this computer, service)
- ⬜ "Let Me Use This Screen from Wisp" asks for a screen code; "Change Screen Code…"
- ⬜ Desk buddy: the ghost floats on the desktop with bubbles when agents finish or need you; follows theme and motion settings; respects muted channels
- ⬜ Cloud server setup in your own Hetzner account; a failed one can be resumed after restart
- ⬜ Updater: finds `desktop-v*` releases, verifies the digest, swaps the app (needs a published release to test end to end)
- ⬜ Notifications and the Dock badge, cleared on logout
- ⬜ Builds for Mac (arm64, Intel), Windows and Linux (AppImage, .deb named with a maintainer)

## iPhone app (apps/ios)
- ⬜ Pair by QR or link; 6-digit confirm on the computer; the phone gets its own session; saved hub recovery
- ⬜ Four tabs: Chats, Agents, Computers, You; rounded Liquid Glass look; animated ghosts
- ⬜ Chat parity: edit and delete messages (live from elsewhere too), attachments and Quick Look, task/routine/discussion/context cards, Stop, mentions, reconnect reloads the open conversation
- ⬜ Channels: create with a team, team editor by touch, sub-threads, who's working where
- ⬜ Agents: create and manage, look editor, background as one sentence, change cards with Undo
- ⬜ Computers: screen view with the code prompt, lend panel, loan approvals with the code
- ⬜ You tab: tasks, memory, about you, connected apps, skills, devices, usage, mods, organization switcher, settings
- ⬜ Push notifications (APNs) reach the phone
- ⬜ Sign-out and organization switch never crash a load in flight

## Android (apps/android)
- ⬜ Pairing screen with the Google code scanner, then the web app in a WebView; sideload APK (debug-signed; a friend tests)

## Website (site/, Astro on Cloudflare Pages)
- ⬜ Builds clean; the rounded, glassy look; download links for Mac, Windows, Linux and Android; `SITE_URL` and `CONTACT_EMAIL` placeholders filled before launch

## Install and docs
- ⬜ `install.sh` and `install.ps1` three-step setup; `uninstall.sh` removes everything; Docker image and compose file; INSTALL.md and README match what the app does
