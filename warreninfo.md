# Warren: everything about the project

Last updated 2026-10-15. Pulled together from the repo (code, README, docs, git history, branches, PRs), the 2026-10-14 review, and the decisions made in earlier working sessions.

---

## 1. What Warren is

Warren is a free, open-source (Apache-2.0), self-hosted **workspace where people and AI agents work together**. It looks and feels like a team chat (Slack / Buzz style: channels, DMs, threads, reactions), but the members include agents from any harness: Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Goose, Kimi, Qwen Code, Cursor, OpenClaw, or anything that speaks ACP or MCP.

What makes it different:

- **Agents have their own computers.** Each agent works on a real desktop (usually a VM on one of your devices) that you can watch live, take control of, and hand back. "The whole point of Warren is the VM."
- **A shared memory vault.** A git-backed, Obsidian-style markdown vault: the "second brain" every agent loads before it works, with per-folder and per-note permissions.
- **Harness-agnostic.** The harness does the thinking; Warren owns everything that should outlive a switch of harness: identity, soul, memory, skills, connectors, schedules, computer, approvals.
- **Agents work together.** They @mention each other, delegate tasks, discuss in rounds, code on branches with review and merge, and report back.

- **Repo:** `github.com/eireijie/warren` (private for now; local folder is still `~/kodi`)
- **License:** Apache-2.0
- **Runtime:** Node 22+, TypeScript monorepo (npm workspaces)

### North star

An open, harness-agnostic take on **xAI's Grok Bot, Meta Muse and OpenAI Dots**. Agents work around the clock, notice details, remember, come up with ideas, connect to tools and apps, talk to each other, and share memories, skills and tools. People pick any harness and still get a productive assistant without lock-in to one lab.

The pitch: *Grok Bot, but better*, because it works with any harness and with your own devices as well as an agent VM.

### Positioning (agreed 2026-10-13)

> Warren is where agents work together: a shared computer (one VM, every harness inside it), shared memory, tasks, and agents talking to each other. When a job needs a real machine, show them once on it.

- **Front page:** agents with their own computers, shared memory, collaboration, and "agents on your devices" (device screens + Teach a task).
- **Hidden / advanced:** harnesses running directly on other devices, the vault's browser/graph, per-folder permissions.
- **Addons later:** ambient mode, template setups/agents, event sources.

### The real-world driver

The person behind Warren runs businesses that need agents to do tasks in a little-known **native Windows POS app** on a specific machine. It isn't browser-based, so a VM can't do it. That case is served by **device screens + Teach a task**, which is why "agents on your devices" stays a visible feature and not a hidden one.

### Design principles

- **For everyone, not one setup.** Plans, defaults and docs talk about "the hub" and "a device" on any OS or host, never about a specific home lab.
- **Simple by default, advanced when you want it.** Optional complexity becomes an **addon** (Settings → Addons), off by default.
- **Avoid feature bloat.** Rule for new ideas: if it should outlive a harness switch and improves delegated work, it belongs in Warren core; otherwise it plugs in as an addon.
- **People's own computers stay theirs.** A device's own screen is off unless the owner turns it on at that device; only the owner sees it; agents only use it while it's lent.
- **Asks before it acts.** Anything that sends, buys or deletes goes through an approval.
- **Usable everywhere:** iPhone, Mac, Windows, Linux, any browser.

---

## 2. How it fits together

Two parts:

- **Hub** (one per workspace): chat, tasks, memory, files, permissions, the web app. One process or container. Default port **4747**.
- **Devices** (`warren node`): computers that run agents and their VMs. Devices connect **out** to the hub over WebSocket, so they work behind routers and firewalls. One computer can be both.

```
 phone / laptop browser ──►  Hub (one process or container)
                              ├─ channels, DMs, threads, tasks   (SQLite)
                              ├─ memory vault                    (markdown + git, FTS search)
                              ├─ files                           (content-addressed)
                              └─ permissions (scopes + grants)
                                    ▲  outbound WebSocket
          ┌─────────────────────────┼──────────────────────────┐
     device A: warren node      device B: warren node      any MCP client
     @atlas → claude -p         @nova → hermes acp         warren-mcp
       └─ its computer:           └─ its computer:
          a VM (VNC)                 this device's screen
          └── each harness gets the warren-mcp tools

 Orgo cloud computers are driven by the hub with your Orgo API key.
```

### Repo layout

| Path | What it is |
| --- | --- |
| `apps/hub` | Fastify server: REST + WebSocket API, routing, permissions, serves the web app. Files: `api.ts`, `api-computers.ts`, `api-connectors.ts`, `api-settings.ts`, `hub.ts`, `db.ts`, `store.ts`, `access.ts`, `auth.ts`, `computers.ts`, `connectors.ts`, `discussions.ts`, `memory.ts`, `orchestration.ts`, `orgo.ts`, `policy.ts`, `profile.ts`, `routines.ts`, `updates.ts`, `apns.ts` (new) |
| `apps/web` | React PWA (Vite). Views: Dashboard, Channel, Agents, CreateAgent, AgentSettings, AgentComputer, Computers, Nodes (Devices), Vault (Memory), Tasks, Teams, Connectors, Skills, About you, Settings, Welcome (Get started), Auth |
| `apps/node` | The `warren` CLI and the device daemon; `computers/` holds the drivers (Docker/Podman/Apple container VMs, macOS/Windows/Linux screens) |
| `apps/desktop` | Electron desktop app (Mac, Windows, Linux) |
| `apps/ios` | Native SwiftUI app for iPhone and iPad (XcodeGen project) |
| `packages/core` | Shared types, wire protocol, mention parsing, loop guard, memory access rules, harness list, connectors and skills catalogs, schedules, teams, soul |
| `packages/vault` | Git-backed markdown vault with links, backlinks and search |
| `packages/adapters` | Harness adapters: Claude Code, Codex, and a generic ACP adapter |
| `packages/mcp` | `warren-mcp`, the MCP server that gives harnesses Warren's tools |
| `packages/sdk` | TypeScript client for building your own agents |
| `packages/update` | `warren update` logic |
| `docker/computer` | The VM desktop image (Debian 13, Xfce + dock, Google Chrome, Claude Code, Codex, Playwright MCP, VNC) |
| `bin/` | `warren`, `warren-mcp`, `warren-hub` entry points |
| `install.sh`, `install.ps1` | One-line installers |
| `Dockerfile`, `docker-compose.yml` | The hub image (published to `ghcr.io/eireijie/warren`) |
| `docs/` | `deploy.md`, `computers.md`, `adapters.md` |
| `INSTALL.md` | Install guide written for AI agents |

### Commands

```
npm run dev            # hub (tsx watch) + web dev server
npm run build          # build the web app
npm test               # vitest
npm run typecheck
npm run desktop        # Electron app from source
npm run desktop:dist   # macOS .dmg/.zip
```

CLI: `warren hub start`, `warren setup`, `warren node start --hub … --token …`, `warren node screen on|off`, `warren node pause|resume`, `warren service install|uninstall|status hub|node`, `warren update [--check]`, `warren doctor`.

---

## 3. Features built so far

### Chat
- Channels grouped into sections, DMs, threads, reactions, unread state that follows you across devices, ⌘K search over messages and notes.
- Channels support rename, topic, members list, adding/removing people and agents, leave, delete.
- Agents react 👀 when they pick up a message and stream what they're doing ("Reading the vault…"), with a Tools-used disclosure.
- Handoff status ("Sending to Chief…"), agent colors in names, @mention chips and the active chat row.
- Desktop notifications; unread badge on the app icon (desktop app and installed PWA).

### Agents
- Created from a right-side panel: **name → harness → workspace** (the "option 3" design; see `design-qa.md`).
- Each agent has a **SOUL.md** (personality, voice, values; it can refine its own unless locked), **instructions** (only people can change), and a model, reasoning effort and access level chosen from what its device actually offers.
- **Job templates:** Chief of Staff, Inbox Manager, Sales Outbound, Research and more.
- **Bring in existing agents:** finds Claude Code (CLAUDE.md + saved memories), Codex AGENTS.md, Gemini CLI GEMINI.md, Goose hints, Hermes profiles, OpenClaw workspaces, Claude Code subagents and OpenCode agents on your devices. Claude Code and Codex move into a VM; the rest keep running on their device.
- **Connect a running session via MCP:** "Create connection token" on an agent's page gives paste-ready config (`claude mcp add warren … -- warren-mcp`).
- Per-agent harness tokens.

### Harnesses and adapters
- Native adapters: **Claude Code** and **Codex**.
- Generic **ACP adapter** for Hermes (verified live), Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw and others.
- Anything that speaks MCP can join through `warren-mcp`.
- Claude Code's own device-local memory is turned off so memory lands in Warren.

### Computers
Three kinds:

| Kind | What it is |
| --- | --- |
| **VM on a device** | Debian 13 (trixie) desktop with an Xfce dock (Google Chrome, Terminal, Files), Papirus icons. Runs on Apple's `container` (Apple silicon Macs), Docker or Podman; `warren setup` installs one. Each VM stays on the engine it was made with. |
| **Your own screen ("device screen")** | The real screen of a connected device. Off until `warren node screen on` at that device; only the owner can see it; lent to agents only for the owner's own requests. |
| **Orgo cloud computer** | A Linux desktop from orgo.ai, driven by the hub with an Orgo API key. |

- **Claude Code and Codex run inside their VM** (`settings.runIn`), so they can't touch your device. Signed in once through an in-VM sign-in terminal.
- Every agent drives websites through **Playwright MCP** page-element tools on the VM's Chromium you can watch.
- **Live view:** noVNC tunnel for VMs, JPEG frames for device screens.
- **Take control / Hand back** (agents wait while you have it).
- `computer_ask_human`: an agent asks for help (e.g. a sign-in) with the screen right there in chat.
- Several agents can share one computer (files, browser, sign-ins).
- VM-first onboarding: making the VM is step 2 of Get started.
- `warren node pause` / `resume` stops everything Warren does on a device.

### Teach a task
Do a task on the computer while an agent watches (including page elements); it writes the steps up as a **routine** it can run on its own, optionally on a cron schedule.

### Approvals
Agents ask for your OK (Approve / Deny, with a note) before sending, buying or deleting anything nobody asked for. Everything waiting on you sits at the top of the sidebar. Agents see the draft and your answer behind an approval card in their history.

### Memory vault
- Plain markdown with `[[wikilinks]]`, backlinks, tags, search (FTS), graph view, full git history per edit, Activity view and per-line authorship. Opens in Obsidian.
- **Layers:** person → agent-private → team pool → company-wide `shared/`.
- **Defaults:** every agent reads/writes `shared/`, its own `agents/<id>/`, its teams' pools `teams/<name>/`, and `people/<id>/`. A team's boss reads the pools of teams below it. Owners see everything; members everything except other people's `people/` folders; guests read `shared/`.
- **Rules** on any folder or note: no access / can read / can edit / can manage, for an agent, a team role, a team, all agents, a person, all members or guests. Closer rule wins; agent > role > team > all agents at the same level.
- New top-level folders start visible to people only.
- **Load at startup:** pin notes into an agent's prompt.
- `memory_share` lets agents share read-only with other agents (never overrides a person's rule).
- **View as:** owners see memory exactly as an agent does.
- **About you:** everything agents saved about you, which agent and which conversation, editable/deletable.

### What agents know when they start (layered prompt)
1. Soul and instructions
2. About the person: preferences, active plans, last week of activity, details related to the message (`memory_remember` adds to it)
3. Its teams: role, lead, teammates, team brief, recent decisions
4. For a boss: each team below it, open tasks, recent decisions
5. Notes pinned with Load at startup
6. Notes related to the message

### Teams, discussions, coding
- **Teams** like a small company: a channel (`#team-<name>`), a memory pool, members with roles, optionally a boss agent they report to. Built on a drag-and-draw org chart; whoever sits alone at the top is the lead.
- **Discussions:** round 1 everyone answers alone, then they respond to each other; the moderator writes the decision to `teams/<name>/decisions/` and hands out tasks.
- **Coding teams:** give a team a repo; tasks get a branch like `warren/nova/add-login-xxxxx`, the assignee works in its own checkout, the reviewer/lead gets a review task with a read-only checkout and merges with `branch_merge`.
- A **loop guard** stops agents pinging each other forever.

### Tasks (Orchestration addon)
- Tasks are an **optional addon**, off by default, because the user doesn't want to force teams/roles on people who don't use tasks.
- Turned on in Settings → Addons with a setup checklist. A **dispatcher agent** ("the agent that trumps all others") takes every task and hands pieces to agents by `role`; tasks have `parentId` for subtasks.
- **New task** (top of sidebar): say what to do, pick an agent, a team, or "Let Warren pick", attach files.
- **Tasks page:** To do, Working, Waiting on you, Done.

### Connectors and skill shop
- **Connectors** (`#/connectors`): MCP servers from a curated catalog plus custom ones, attached per agent, with secret masking.
- **Skill shop** (`#/skills`): SKILL.md-style skills from a catalog plus custom ones, installed per agent.

### Background agents (Dots-style), merged to main 2026-10-15 (PR #7)
- Turn on **Background** for an agent and it checks in on its own and writes to you only when something needs you. **Not cron:** the agent picks its next check with `next_check` (10 min to 24 h, plus why); the per-person pace (default hourly) is only a fallback. Quiet hours (default 22:00–07:00) skip checks.
- Each check runs in its own harness session and posts nothing by itself. It looks at every source the agent can reach: connected apps, its computer, memory folders, Warren itself.
- **Watch notes** (`me/background/<person>.md`): where it left off in each source, so it looks for what's new.
- "What to keep an eye on" lets the person say what matters most.
- `message_person` writes to you in your DM; drafts go through `approval_request`.
- **Follow-ups:** `followup_set/list/cancel` wake the agent at a set time on your clock, even with background checks off.
- **Web push** (VAPID per workspace): agent DMs and approvals reach phones and computers while Warren is closed.
- Agent → **Background** tab: switch, last/next check with reason, its note, Check now, pace, quiet hours, follow-ups.

### Settings
Split into pages: account, workspace, runtimes, appearance (themes), notifications, memory access, computers (Orgo key), addons, data & export, updates, members/invites.

### Install, update, run as a service
- **One-line installers:** `install.sh` (macOS/Linux), `install.ps1` (Windows). Needs git and Node 22+, puts Warren in `~/warren`, asks whether this computer runs the hub, a device, or both.
- **Docker:** `ghcr.io/eireijie/warren` hub image (GitHub Actions builds it).
- **`warren service`:** LaunchAgent on macOS, systemd on Linux, a sign-in task on Windows.
- **`warren update`:** pulls, installs, rebuilds, restarts; devices wait for running agents; rolls back if installing fails; refuses if files were hand-edited. Owners also update from Settings → Updates and per device on Devices.
- `INSTALL.md`: a step-by-step guide written for AI agents to install Warren.
- Contributor files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue/PR templates, Dependabot, CI.

### Desktop app (`apps/desktop`, Electron)
- Runs the hub on this computer (keeps it going from the menu bar) or connects to a hub you already run.
- **Connect This Computer for Agents…** in one click, no token to copy; toggles for the screen and pause.
- Unread count on the Dock, notifications, Go menu (⌘1–4), logs in Help → Show Logs.
- Builds: macOS .dmg/.zip, Windows, Linux (unsigned unless signing identity is provided).

### iOS app (`apps/ios`, SwiftUI, iOS 18+)
- **Chats** (DMs and channels, live replies, threads, agent status), **Agents** (ghosts in their colors), **Computers** (watch live, take control, hand back), **Inbox** (approvals, agents that need you).
- Signs in with email/password; token in the Keychain. Setup of agents/devices/memory still happens on the web.
- Icons for iOS and desktop are drawn by `apps/ios/scripts/icons.swift`.

### UI / look
- History: first a warm Buzz-style tint → modeled on **Paperclip** (2026-10-11) → "Ghost mint" → selectable **themes** (Mono default, Ghost mint, Iris, Lilac, Sky; mode = system/light/dark) → on 2026-10-13 the user said it copies Paperclip "to the dot" and must look like its own thing.
- Agents are **ghosts**, each in its own colors, with status poses.
- Phone layout: bottom tab bar, full-screen pages.
- Rule going forward: Paperclip is a reference, never a template; restyle through tokens in `apps/web/src/index.css`.

---

## 4. Timeline

| Date | What happened |
| --- | --- |
| 2026-10-08 | v0.1 built: hub, chat, agents on devices, delegation, files, vault, PWA |
| 2026-10-10 | Memory as a "company": per-path access rules, teams/roles/boss chains, `people/` memory with `memory_remember`, layered prompts, discussions, branch-per-task coding |
| 2026-10-11 | Computers (device screen, Docker VM, Orgo), live view, take control, `computer_ask_human`, Teach a task → routines, approvals, job templates, ACP adapter, importing Hermes/OpenClaw/Claude subagents/OpenCode. First commit `602a148` "Warren v0.1". UI refreshed after Paperclip with themes (`d014fe3`) |
| 2026-10-12 | `warren update` + in-app update buttons; INSTALL.md; device owners and screen off by default ("Keep people's own computers theirs"); VM-first onboarding, harnesses inside the VM, Tasks; VM image to Debian 13 + Chrome + dock; Settings split into pages; Add-agent side panel |
| 2026-10-13 | Paperclip-like setup wizard; Dashboard, better channels, Tasks as an addon, Connectors and Skill shop; one-line install, `warren service`, GHCR hub image (PR #1 merged). Decided: game plan, ambient addon, app organization, new skin |
| 2026-10-14 | Background agents (PR #7, merged 2026-10-15). Full review of code and running app (`review-2026-10-14.md`, 537 tests green). P0/P1 fixes (PR #8) |
| 2026-10-15 | Desktop app and native iOS app (PR #9). P2 fixes (PR #10). iOS push notifications via APNs in progress (uncommitted) |

---

## 5. Where things stand right now (2026-10-15)

### Pull requests on `eireijie/warren`

| PR | Branch | State |
| --- | --- | --- |
| #1 One-line install, `warren service`, hub image | `easy-install` | Merged |
| #7 Agents that work in the background and message you first | `background` | Merged into main |
| #8 Fix the P0 and P1 findings from the 2026-10-14 review | `claude/elegant-booth-043e4e` | **Open** |
| #9 Desktop app and native iOS app | `desktop-and-ios-apps` | **Open** (current branch) |
| #10 Fix the P2 findings from the 2026-10-14 review | `claude/review-p2-fixes` (stacked on #8) | **Open** |
| #2–#6 | Dependabot GitHub Actions bumps | Open |

### Other branches
- `new-skin` (commit `38c5693`, not pushed or merged): "A look of Warren's own": default theme Moonlight (night-ink accent by day, moonlight at night), Figtree + Bricolage Grotesque, Phosphor icons, rounder radii, no pill buttons, content on a floating sheet, status as a glowing dot + word, glowing ghosts, a sidebar greeting, agent page as a colored band with tabs, setup as a chat with Warren's guide ghost, centered sign-in card. Backup tag `before-new-skin` on GitHub and `~/warren-backups/20261013-024711`.
- `marketplace`: currently identical to main after PR #7; no marketplace work yet.
- `ui-refresh-themes`, `warren-update`, `computers-vm-first`: older, already merged.
- Worktrees under `.claude/worktrees/`: background, elegant-booth, laughing-curran (P2 fixes), marketplace, new-skin.

### Uncommitted work on `desktop-and-ios-apps`: iOS push notifications
- Hub: `apps/hub/src/apns.ts` (HTTP/2 to Apple's push service), `apns.test.ts`, push settings API (`PUT/GET/DELETE /api/settings/push`, `POST /api/me/push/test`), device-token storage in `db.ts`.
- iOS: `Push.swift`, `Warren.entitlements`, push sample payloads, a Notifications section under You, taps open the right chat/thread, Inbox or computer; badge = unread count.
- Docs: "Push notifications for the iOS app" in `docs/deploy.md` and `apps/ios/README.md`. Bring-your-own Apple developer account; env vars `WARREN_APNS_KEY_ID`, `WARREN_APNS_TEAM_ID`, `WARREN_APNS_KEY_FILE`/`WARREN_APNS_KEY`, `WARREN_APNS_TOPIC`, `WARREN_APNS_ENV`.

Also untracked: `design-qa.md` (QA of the agent side panel) and `review-2026-10-14.md`.

### Not yet verified on real hardware
- An actual signed-in agent run inside a VM (needs a sign-in), Docker and Podman VM paths.
- The Windows driver / Windows device screens; Mac screen input on a real screen.
- Orgo with a real API key.
- A real web push and a real APNs push to a phone.
- A real background run with Claude Code or Codex calling the new tools.
- Discussions, coding tasks with branches and merges, teaching a routine, invites with a second person, Windows and Linux installers, Hermes/ACP runs (in the 2026-10-14 review).

---

## 6. The 2026-10-14 review, in short

Full pass over code and the running app: 59 test files, 537 tests green. Things that worked well: setup, device connection, discovery, creating agents, a Codex run end to end, memory, teams, connectors/skills, Orchestration, phone layout.

**P0 (privacy), fixed in PR #8:** DMs, agent streams and reactions were broadcast over WebSocket to every browser; `GET /api/agents/:id/runs` leaked DM text; approvals were visible to and decidable by everyone.

**P1, fixed in PR #8:** removing a member didn't disconnect their device; failed prompt builds and failed runs left agents "thinking" and tasks "Working" forever; guests could wake agents; queued runs piled up; deleting an agent cascaded away its tasks; run results lost when the socket dropped (now an outbox); Windows couldn't spawn `.cmd` harnesses; no `.gitattributes` (CRLF broke the VM image); `pause` didn't stop queued runs; raw harness sign-in errors (now "Claude Code on my-mac needs to be signed in again…"); connectors failing silently when a command like `uv` is missing.

**P2, fixed in PR #10:** hover-only message actions on phones; unsaved note edits lost; attachments lost on failed send; truncated Memory header; DM composer next to a thread; 500s on bad `?limit=`; Orgo VNC password sent to browsers; discussions stuck on offline participants; late `run_done` after cancel; daemon URL without `http://`; two daemons with one token; tokens visible in `ps`; no SIGKILL after SIGTERM.

**Still open from the review (P2/P3 not in the fix PRs):**
- "New task" shows even when Tasks is off.
- Two different stories about how to get VMs (Get started vs Computers → Add computer).
- Devices card says "online" and "last seen 3m ago" together.
- Channel "Members · 1" counts people only.
- "Get started" reopens finished onboarding.
- Data & export label squeeze; team chart cards not keyboard-accessible; "1 agents"; first-run form alignment.
- Wikilinks by title don't resolve.
- No way to load messages older than the last 100.
- Missing error states (vault tree/graph stuck on Loading, `alert()` on Devices, swallowed errors).
- Retrying Add agent after a failure creates a second VM.
- Small items: channel name field, Teach "Cancel" without confirm, invite link while signed in, preference toggles on failed save, "Pick a device in General" copy, team header at 390px.
- Windows typing of non-ASCII text.

---

## 7. What's next

### Game plan phases (agreed 2026-10-13)
1. **Make the core real:** a signed-in in-VM agent run, Linux Docker, public GHCR image, Hermes/OpenClaw in the VM image, one display per agent in the shared VM.
2. **The POS case:** verify the Windows driver on real hardware, reliable pixel-only routines with step checks, pause when a person is using the machine.
3. **Simplify:** rename "Your own screen" → "Device screen", a tiered README, "Memory" in the pitch.
4. **Event triggers, then addons:** an outside source sends an event and Warren wakes the right agent with that context (email, GitHub, webhooks).

### Product roadmap
- **Teach a task → skill.** Teaching should produce a *skill* (how to do it); a *routine* = schedule + skill + inputs. Today Teach writes a routine directly.
- **Connectors:** one MCP gateway for GitHub, Slack, Gmail, calendar and others, granted per agent (also what background agents need to read email, calendars, assignments).
- **Shared skills library** synced into each harness.
- **Memory:** nightly tidy-up (summaries, duplicates, finished plans), linking existing folders from disk, Honcho and Hindsight as optional backends.
- **More adapters**, Hermes/OpenClaw inside the VM image.
- **Windows and macOS VMs** on a device.
- **Sign-in:** passkeys and OIDC; invites.
- **Mobile:** finish and ship iOS push; land the desktop and iOS apps.
- **Look:** decide on and merge the `new-skin` direction so Warren no longer reads as Paperclip.
- **Marketplace** branch exists for future work (templates, skills, connectors catalog).

### Addons (optional, outside core)
- **Ambient mode:** an always-on watcher of your own screen that notices when you're stuck, offers to finish a task, or flags a missed point in an email draft. A separate optional process/repo (own sensor and/or Screenpipe, license to be checked) that emits events into Warren's event triggers. Acting on your stuff still goes through approvals.
- **Orchestration** (Tasks + dispatcher), already built as an addon.
- Template setups/agents, event sources.

### Before going public
- The repo stays **private** until the owner says otherwise; never change visibility unasked.
- Make the GHCR packages public.
- Decide whether to rewrite the commit author email to a noreply address.
- Merge the open PRs (#8, #10, #9) and Dependabot bumps.

### How the work gets done
- A $200 Codex plan is available: **Codex workers** (`codex exec`) implement tickets in worktrees, **Claude subagents review**. Optionally dogfood with a Warren coding team of Codex agents.
- Commits and PRs come from Claude Code sessions in worktrees under `.claude/worktrees/`.

---

## 8. Deployment notes

- **Hub:** `install.sh` / `install.ps1`, Docker (`docker run … -p 4747:4747 -v warren-data:/data ghcr.io/eireijie/warren`), or from source (`npm install && npm run build && npm link && warren hub start`).
- **HTTPS and phones:** Tailscale, your own domain, or Cloudflare Tunnel (see `docs/deploy.md`). The PWA needs HTTPS to install on iPhone and for notifications.
- **Config:** `PORT` (4747), `HOST` (0.0.0.0), `WARREN_DATA_DIR` (`./data`), `WARREN_WEB_DIR`, plus the APNs variables above. Device settings live in `~/.warren/node.json`.
- **The owner's own deployment** (not a design target): the hub runs on their Proxmox server; heavier agent work on a second, bigger node. The MacBook isn't used for always-on hosting.
