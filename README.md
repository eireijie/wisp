# Warren

**A workspace where people and AI agents work together.** Chat with Claude Code, Codex, Hermes, Gemini CLI and other agents in Slack-style channels. Each agent gets its own computer that you can watch and take over, they hand work to each other, and they share an Obsidian-style memory vault.

Free and open source (Apache-2.0). Self-hosted: your messages, memory and files stay on your server.

- **Agents from any harness.** Claude Code and Codex have their own adapters; Hermes, Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw and any other agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) run through one ACP adapter, and a device can add its own. Anything that speaks MCP can join through `warren-mcp`.
- **Agents with computers.** Agents aren't headless unless you choose that: each one works on a computer, opening apps and websites, signing in once and keeping its files. A computer is a VM on one of your devices (a Linux desktop; `warren setup` installs what it needs, like Apple's `container` on a Mac) or an [Orgo](https://orgo.ai) cloud computer. Claude Code and Codex agents run entirely inside their VM, so they can't touch your device, and every agent works websites through page-element browser tools (Playwright MCP) on the browser you watch. Your own screen stays yours: it's off unless you turn it on at the device, only you can see it, and you can lend it to agents for a while. Several agents can share one. Watch any of them live, **Take control** whenever you like (agents wait), and **Hand back**. When an agent needs you to sign in somewhere, it asks with the screen right there in chat.
- **Show it once.** **Teach a task**: do it on the computer while an agent watches, and it writes the steps up as a routine it can run on its own, on a schedule if you like.
- **Asks before it acts.** Agents ask for your OK (Approve / Deny, with a note) before sending, buying or deleting anything nobody asked for. Everything waiting on you sits at the top of the sidebar.
- **Bring in agents you already have.** Warren finds your Claude Code setup (CLAUDE.md and the memories it saved), Codex's AGENTS.md, Gemini CLI's GEMINI.md, Goose hints, Hermes profiles, OpenClaw workspaces, Claude Code subagents and OpenCode agents on your devices, and brings them in with their soul, instructions and notes, one at a time or all at once (right in **Get started**, too). Claude Code and Codex move into a VM; the rest keep running on their device. Or start from a job: Chief of Staff, Inbox Manager, Sales Outbound, Research and more.
- **Hand off work in one step.** **New task** (top of the sidebar): say what needs doing, pick an agent, a team, or **Let Warren pick** (your boss agent or a team lead routes it), attach files, done. **Tasks** shows everything by where it stands, To do, Working, Waiting on you and Done, and anything an agent needs from you (an OK, a sign-in) is pulled out so it never sits unseen.
- **Any device.** Agents run on whatever computer you assign them: a laptop, a home server, a VM. Devices connect *out* to the hub, so they work behind routers and firewalls.
- **A real memory vault.** Plain markdown with `[[wikilinks]]`, backlinks, tags, search, a graph view, and full git history for every edit. Each agent has a private folder and everyone shares `shared/`. Make your own folders and set who can read or edit each folder or note, and which agents load a note every time they work. Open the same folder in Obsidian.
- **Agents you can shape.** Each agent has a `SOUL.md` (personality, voice, values; it can refine its own unless you lock it), instructions for its job (only people can change those), and a model, reasoning effort and access level picked from what its device actually offers.
- **A second brain every agent shares.** Agents save what they learn about you (preferences, plans, what you did, small details) as they go, and every agent loads it before it works. You see all of it on **About you**, with which agent saved it and from which conversation, and can fix or delete anything.
- **Teams, like a small company.** Put agents on teams with a lead, roles and a shared memory pool, and have teams report to a boss agent. Ask the boss for anything, or go straight to a team's lead. Agents can also work on their own.
- **Agents that collaborate.** Agents @mention each other, delegate tasks (`task_delegate`), pass files, and report back, and you see it happen ("Sending to Chief…"). They can talk a topic through in rounds before starting (`discussion_start`), with the decision saved to the team's memory. Coding teams get a branch per task, a review, and a merge. A loop guard keeps them from pinging each other forever.
- **Feels like a team chat.** Channels grouped into sections, DMs, threads, reactions, unread state that follows you across devices, ⌘K to search everything, and agents that react 👀 when they pick up your message and show what they're doing while they work.
- **Works everywhere.** The web app is an installable PWA: iPhone (Add to Home Screen, with a bottom tab bar), Android, Mac, Windows and Linux.

## Quick start

Having an AI agent install it? Point it at [INSTALL.md](INSTALL.md), a step-by-step guide written for agents.

Requirements: Node 22+ and git. `npm install` runs install scripts for three dependencies, which is expected: better-sqlite3 downloads a prebuilt SQLite, and esbuild and fsevents fetch the binary for your platform.

```bash
git clone https://github.com/<you>/warren && cd warren
npm install
npm run build
npm start
```

Open http://localhost:4747 and create your workspace. Data lives in `./data` (set `WARREN_DATA_DIR` to change it).

Or with Docker:

```bash
docker compose up -d
```

### Connect a device and add agents

1. In Warren, go to **Devices → Add device** and copy the command.
2. On the computer that should host your agents:

   ```bash
   npm install && npm link          # once, inside the warren repo: installs `warren` and `warren-mcp`
   warren setup                     # gets it ready to run your agents' VMs (asks before installing anything)
   warren node start --hub http://your-hub:4747 --token <token> --name my-laptop
   ```

   It stays connected until you close the terminal. To start it automatically at login and keep it running, see [Keeping a device connected](docs/deploy.md#keeping-a-device-connected) (macOS, Linux and Windows).

3. **Get started** walks you through the rest: create your agents' computer (a VM on that device), add an agent (Claude Code and Codex run inside the VM; sign them in there once), and give it a first task on the web. Or go to **Agents → Add agent**, or bring in an agent that already lives on the device.
4. Say `@atlas what's in our memory about the launch?` in `#general`, and open **Computers** to watch it work.

See [Computers](docs/computers.md) for VMs, your own screen, Orgo, taking control, teaching tasks, and who can reach your computer.

### Updating

Owners update from the app: **Settings → Updates** shows what's new and has an **Update hub** button, and **Devices** has an **Update** button for each device. Or run this inside the warren folder on any hub or device:

```bash
warren update            # pull, install what changed, rebuild the web app on a hub, restart
warren update --check    # only show what's new
```

The hub and any device running from that folder restart themselves with the new version; a device waits until its agents finish what they're doing. Updates stop if files in the folder were changed by hand, and if installing fails, Warren goes back to the version it was on. A hub running in Docker updates with `git pull && docker compose up -d --build`.

### Bring in an agent that's already running (MCP)

On an agent's page, choose **Create connection token**. Warren shows ready-to-paste config for Claude Code, Codex and generic MCP clients, for example:

```bash
claude mcp add warren --env WARREN_URL=http://your-hub:4747 --env WARREN_TOKEN=<token> -- warren-mcp
```

That session can now chat in channels, delegate tasks, and read and write memory as that agent.

## How it fits together

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
          a Docker VM (VNC)          this device's screen
          └── each harness gets the warren-mcp tools (chat, tasks, memory, files, computer use)

 Orgo cloud computers are driven by the hub with your Orgo API key.
```

| Package | What it is |
| --- | --- |
| `apps/hub` | Fastify server: REST + WebSocket API, routing, permissions, serves the web app |
| `apps/web` | React PWA |
| `apps/node` | `warren` CLI and device daemon |
| `packages/core` | Shared types, wire protocol, mention parsing, loop guard, memory access rules |
| `packages/vault` | Git-backed markdown vault with links, backlinks and search |
| `packages/adapters` | Harness adapters: Claude Code, Codex, and any ACP agent |
| `packages/mcp` | `warren-mcp` MCP server (chat, reactions, tasks, memory, files, computer use, approvals, routines) |
| `docker/computer` | The Linux desktop image VMs run (Xfce, Chromium, xdotool, VNC) |
| `packages/sdk` | TypeScript client for building your own agents |

### Memory permissions

Every folder and note can have its own access rules. Use the share button on a folder or note in **Memory**, or **Settings → Memory access**.

| Default | Can read and write |
| --- | --- |
| Every agent | `shared/`, its own `agents/<id>/`, the pool of each team it's on (`teams/<name>/`), and what's saved about people (`people/<id>/`) |
| A team's boss | The pools of the teams that report to it, all the way down |
| Owners | Everything, always (they also manage who has access) |
| Members | Everything except other people's `people/` folders (folders can be closed to them) |
| Guests | Read `shared/` |

- **Rules:** a rule gives an agent, a role on a team (e.g. reviewers on `web`), a team, all agents, a person, all members or guests one of *no access*, *can read*, *can edit* or *can manage* (people only).
- **Inheritance:** a rule on a folder covers everything inside it. A rule closer to the note wins, so you can open `Projects/` to all agents and still close `Projects/secret/`. At the same folder, a rule for one agent beats one for its role, which beats one for its team, which beats one for all agents.
- **Your own folders:** new top-level folders like `Projects/` start out visible to people only, until you share them with agents.
- **Load at startup:** agents get the note, or the notes in that folder, in their prompt every time they work.
- **Agent sharing:** agents can share notes and folders they can edit with another agent, read-only, using `memory_share`. Shares show up in Settings and can be removed, and an agent's share never overrides a rule a person set.
- **View as:** owners can see memory exactly as an agent sees it with **View as** in Memory.

Agents can write `me/notes.md` as shorthand for their own folder.

### What agents know when they start

Every run's prompt is built fresh, in layers:

1. Its soul and instructions.
2. **About the person it's working with:** every preference, active plans, the last week of what they did, and the details most related to the message. Agents add to this with `memory_remember`; Claude Code's own device-local memory is turned off so everything lands here, where you can see it.
3. **Its teams:** its role, the lead, teammates and their roles, the team brief (`README.md` in the pool) and recent decisions.
4. **For a boss:** each team below it, with its open tasks and recent decisions.
5. Notes people pinned for it with **Load at startup**.
6. Notes related to the message.

Agents connected through `warren-mcp` get the same when their session starts, and can refresh it with `memory_context`. In **Memory**, **Activity** shows who changed what, and each note shows who wrote each line.

### Teams, discussions and coding together

- **Teams** (sidebar → Teams) have a channel (`#team-<name>`), a memory pool, members with roles, and optionally an agent they report to. You build each team on its chart: drag agents in from the list, draw a line from one card to another to say who reports to whom, and click a card to give it a role. Whoever sits alone at the top is the lead. A role's notes go into that member's prompt, and each agent is told who it reports to and who reports to it.
- **Discussions** (composer **+** → Start a discussion, a team's **Discuss** button, or `discussion_start`): in round 1 everyone answers on their own, then they respond to each other; then the moderator writes the decision, which is saved to `teams/<name>/decisions/`, and hands out tasks.
- **Coding:** give a team a repo (a git URL, or a path on the agents' device). Tasks handed out in the team's channel get a branch like `warren/nova/add-login-xxxxx`, and the assignee works in its own checkout of it. When it's done, the team's reviewer (or lead) gets a review task with a read-only checkout and merges with `branch_merge`. Merges never touch a checkout with uncommitted changes.

## Docs

- [Deploying](docs/deploy.md): Docker, a Proxmox LXC, reaching it from your phone with Tailscale or a domain
- [Computers](docs/computers.md): VMs, your own screen, Orgo, live view, taking control, teaching tasks, who can reach your computer
- [Adding a harness](docs/adapters.md)
- [Contributing](CONTRIBUTING.md)

## Status and roadmap

v0.1 covers the hub, chat, agents on devices, delegation, files and the memory vault. Next up:

- Connectors: one MCP gateway for GitHub, Slack, Gmail and others, granted per agent
- A shared skills library synced into each harness
- A nightly tidy-up of memory (summaries, duplicates, finished plans)
- Linking existing folders from disk into the vault
- Honcho and Hindsight memory backends next to the vault
- Windows and macOS VMs on a device
- Invites, passkeys and OIDC sign-in; web push notifications

## License

[Apache-2.0](LICENSE)
