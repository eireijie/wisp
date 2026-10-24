# Deploying Wisp

Wisp is one process (the hub) plus any number of devices that run agents. The hub is light: well under 1 GB of RAM. Agents are heavier, because each run starts a harness like Claude Code or Codex.

## Coming from Warren?

Wisp was called Warren. Updating automatically moves `~/.warren` to `~/.wisp` on first start (if the new folder doesn't exist), leaves a compatibility symlink at the old path, and replaces the old services with Wisp services while keeping their settings. Run `wisp migrate` to do the move and service migration by hand; it is safe to run again.

Existing `WARREN_*` environment variables still work when the matching `WISP_*` variable is unset, and `warren://` pairing links still open. New pairing links use `wisp://`. The iPhone and Android apps have new app IDs, so they install as new apps and need pairing again.

## The installer

On a personal computer or a small server, the installer is the quickest way. It clones Wisp to `~/wisp`, installs it, and keeps the hub running with the system's service manager:

```bash
curl -fsSL https://raw.githubusercontent.com/eireijie/wisp/main/install.sh | bash -s -- --hub-server
```

On Windows: `irm https://raw.githubusercontent.com/eireijie/wisp/main/install.ps1 | iex`. The hub serves the same scripts at `/install.sh` and `/install.ps1`, which is what **Devices → Add device** uses.

## Docker

```bash
docker run -d --name wisp -p 4747:4747 -v wisp-data:/data --restart unless-stopped ghcr.io/eireijie/wisp
```

Or, in a checkout, `docker compose up -d` (add `--build` to build the image from source).

Data is stored in `/data` in the container (`./data` with the compose file):

| Path | Contents |
| --- | --- |
| `data/wisp.db` | SQLite: users, channels, messages, agents, tasks |
| `data/vault/` | The memory vault: a git repository of markdown files (unless you [chose another folder](#memory-and-obsidian)) |
| `data/files/` | Uploaded files, stored by content hash |

Back up the whole folder, and the memory folder too if you moved it. The vault is a normal git repo, so you can also back it up with `git`, or use it from another computer with [Obsidian](#memory-and-obsidian).

## Run Wisp in the cloud

To keep Wisp running when your computers are off, put it on a server you rent. The Wisp project doesn't host anything or take payment for it. The server is in **your own** cloud account, and the provider bills you directly.

### From the desktop app (Hetzner)

On first run (or **Create or Join Another Server…** in the menu bar), choose **Create one in your cloud account**:

1. In the [Hetzner Console](https://console.hetzner.com), open a project, go to **Security → API tokens → Generate API token**, choose **Read & Write**, and paste it into Wisp.
2. Pick a location and a size. The prices come straight from Hetzner's API each time, per month, including the IPv4 address. Hetzner bills by the hour, up to that monthly price. Wisp suggests the cheapest size with 4 GB of memory, which fits the hub plus a couple of agent computers.
3. Enter your name, email and password for the new Wisp, then **Create server**.

The app creates an Ubuntu 24.04 server named `wisp-xxxxxx` (labelled `managed-by=wisp`) with [`docker/cloud-init.yaml`](../docker/cloud-init.yaml) as its first-boot script. It waits until Wisp answers over HTTPS (usually 3–5 minutes), makes your account, and opens it, signed in. If the server doesn't come up in time, the app offers to delete it.

**Where the token goes:** only to `api.hetzner.cloud`. It's held in the setup window's memory while the server is created and is never written to disk. It's gone once the window moves on to your Wisp. The app keeps only which server it made (id, name, IP) in its `desktop.json`. You can delete the token in Hetzner afterwards. Wisp doesn't need it again.

**To stop paying,** delete the server in the Hetzner Console. Back up `/opt/wisp/data` first if you want to keep anything.

### What the server runs

[`docker/cloud-init.yaml`](../docker/cloud-init.yaml) installs Docker and runs two containers from `/opt/wisp/compose.yaml`: the hub (`ghcr.io/eireijie/wisp`, data in `/opt/wisp/data`) and [Caddy](https://caddyserver.com) on ports 80 and 443. HTTPS works without a domain:

- `https://<server IP>`, with a Let's Encrypt certificate for the IP address itself. These come only on Let's Encrypt's six-day "shortlived" profile, and Caddy renews them automatically.
- `https://<ip-with-dashes>.sslip.io` as a second address, for example `https://203-0-113-7.sslip.io`. [sslip.io](https://sslip.io) answers any such name with the IP inside it. All sslip.io names share Let's Encrypt's weekly limit, so it's only the fallback.

The address is in `/opt/wisp/url` and in the login message. The hub image is pulled again every night (`/etc/cron.daily/wisp-update`), so the server keeps itself up to date. To use your own domain, point it at the server and add it as another site in `/opt/wisp/Caddyfile`, then run `docker compose restart caddy`.

**Nobody else can claim it.** A brand-new hub lets the first visitor make the owner account, and a public IP is found by scanners within minutes. So the app puts a random setup key in the script. Until the first account exists, Caddy refuses `POST /api/setup` without that key, and only the app has it. If the app is closed before it finishes, the key is in `/opt/wisp/setup-key` on the server:

```bash
curl -X POST https://<server IP>/api/setup -H "X-Wisp-Setup-Key: $(cat /opt/wisp/setup-key)" \
  -H "content-type: application/json" -d '{"name":"You","email":"you@example.com","password":"at least 8 characters"}'
```

### By hand, at any provider

Paste [`docker/cloud-init.yaml`](../docker/cloud-init.yaml) into the "user data" or "cloud config" box when you create an Ubuntu 24.04 or Debian server: Hetzner, DigitalOcean, Vultr, Linode, OVH and so on. Left as it is, with the placeholder key, there's no setup key, so open `https://<server IP>` and make your account straight away.

### Why these providers and not others

| | Hetzner Cloud | DigitalOcean |
| --- | --- | --- |
| In the app | Yes: paste an API token | Not yet. Use the script by hand |
| Smallest size that fits | 2 vCPU / 4 GB shared (CX23, or CAX11 on Arm), a few euros a month. Hetzner changed its prices twice in 2026, so the app shows them live from the API | A 2 GB Basic Droplet, roughly twice Hetzner's price |
| API | `POST /v1/servers` with `user_data` (up to 32 KiB) | `POST /v2/droplets` with `user_data` (up to 64 KiB) |
| Connecting without a token | No OAuth for third-party apps | OAuth: a "Connect DigitalOcean" button would work once the Wisp project registers an OAuth app. Its docs now describe PKCE for desktop apps, but recent reports say the token exchange still wants a client secret. Needs testing before we build on it |

Both give you a whole virtual machine, so Docker runs normally. That's all agent computers need: on a Linux device they're Docker containers from `docker/computer`, with no nested virtualization. To run agents on the cloud server itself, connect it as a device (`curl -fsSL <your Wisp>/install.sh | bash -s -- --hub <URL> --token <TOKEN>` (use the command from **Devices → Add device**) there, then sign in to your agent CLIs).

Platforms like Railway or Render run *your container* but not Docker *inside* it, so the hub would run there but agent computers couldn't. They also need a paid volume for the database and vault. A plain VPS is simpler and cheaper.

## Memory and Obsidian

Memory is a folder of markdown notes in a git repository. Obsidian is where people browse and edit it; Wisp's Memory page is for search, Activity and permissions.

**Choosing the folder.** The default is `<data>/vault`. Set `WISP_VAULT_DIR=/path/to/folder` (or, as an owner, **Settings → Memory → Use a different folder**, which takes effect after a restart) to keep memory somewhere else, such as an existing Obsidian vault.

- A folder that isn't a git repo gets `git init` and its notes are committed ("Start tracking this folder"). A folder that already is one keeps its history. `.obsidian/` and `.trash/` are added to `.gitignore` and are never committed, indexed or modified. Links (symlinks) are not followed.
- Wisp refuses `/`, your home folder, and any folder that contains its own data directory.
- When the folder changes, an earlier vault is carried over once on the next start: an empty folder gets a full copy including git history; a folder that already has notes only gets the files it doesn't have (never overwriting, and without the old `.git`). The earlier folder is never touched or deleted. Settings → Memory says where it is.
- In Docker, point `WISP_VAULT_DIR` at a path inside a volume you mount (for example `-v ~/Obsidian/Wisp:/vault -e WISP_VAULT_DIR=/vault`), and run the container as a user that can write to it.

**Edits on the same machine.** Wisp watches the folder (with a 30 second re-scan as a backup), commits outside edits as "Edited in Obsidian", and re-indexes only what changed. Settings → Memory and **Refresh** in Memory also trigger a scan.

**Syncing from another computer.** The hub serves the vault's git repository over HTTP at `/git/vault.git`, using git's own `git http-backend` (so `git` must be installed on the hub, as it already must be). People create a token in **Settings → Memory** and use it as the password (any user name). Then:

```bash
git clone "https://wisp:TOKEN@your-hub.example.com/git/vault.git" "Wisp memory"
```

Open that folder in Obsidian and install the community **Git** plugin to pull and push on a schedule. Use https (or a private network such as Tailscale) when the hub isn't on your own network; the token is sent with every request.

How it's kept safe:

- Every request needs a sync token (stored hashed; revoke it in Settings). A normal sign-in token doesn't work here, and a sync token doesn't work for the API.
- A clone includes all history and git can't hide single folders. So only people who can read every note that has ever existed may clone or pull: owners always, members unless a rule (or another person's private folder) hides something from them, never guests. This is checked on every request, so a rule that hides a note cuts that person off from syncing.
- Reads are served from a separate bare repository that borrows the vault's objects; the vault folder itself is never exposed.
- A push is first received into a throwaway repository (fast-forward only, objects checked with `fsck`, no deletes, only the vault's branch). Every changed file is then checked against the person's edit rights, and hidden paths (like `.obsidian`), symlinks and submodules are refused. Only then is it fast-forwarded into the vault, while nothing else changes the vault. If the check fails, the push is rejected with a reason and nothing is applied.
- Pushed commits keep the git author the person's computer gave them, but Activity, history and "who wrote what" show their Wisp name.
- Wisp commits outside edits before judging a push, so if you edited the vault on the hub's machine at the same moment, the plugin asks you to pull first.

## Proxmox (LXC)

A good split for a home lab:

- **Hub:** a small Debian 12 LXC (1 vCPU, 1 GB RAM, 8 GB disk). Put `data/` on fast storage and back it up to a bigger disk.
- **Agent devices:** one or more LXCs or VMs on your strongest node, with Node 22, git, and the harness CLIs (`claude`, `codex`) installed and logged in. Give them RAM; each running agent can use 0.5–2 GB.

Hub LXC, either with Docker (enable `nesting=1` on the container) or directly with Node:

```bash
apt-get update && apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
git clone https://github.com/eireijie/wisp /opt/wisp && cd /opt/wisp
npm ci && npm run build
WISP_DATA_DIR=/var/lib/wisp npm start
```

To keep it running, create `/etc/systemd/system/wisp.service`:

```ini
[Unit]
Description=Wisp hub
After=network-online.target

[Service]
WorkingDirectory=/opt/wisp
Environment=WISP_DATA_DIR=/var/lib/wisp PORT=4747
ExecStart=/usr/bin/node bin/wisp-hub.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now wisp
```

## Keeping a device connected

`wisp node start` stays connected and reconnects by itself when the hub restarts or the network drops, but it stops when you close its terminal or restart the computer. To have the system start it from then on, run this from a terminal where your agent CLIs work, as the person who signed in to them (not root):

```bash
wisp service install node --hub <hub URL> --token <token> --name <name>   # later runs: wisp service install node
wisp service status
wisp service uninstall node
```

It writes and starts the service described below for your system, with that terminal's `PATH`, and waits until the device connects. `wisp service install hub` does the same for a hub. The rest of this section is what it does, if you'd rather set it up yourself.

### macOS (LaunchAgent)

Run this inside the wisp repo, from a terminal where your agent CLIs work. It saves that terminal's `PATH` into the LaunchAgent, because launchd otherwise starts programs with a minimal `PATH` and `wisp node` wouldn't find `claude`, `codex` or the others.

```bash
mkdir -p ~/.wisp
cat > ~/Library/LaunchAgents/ai.wisp.node.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.wisp.node</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string><string>$(pwd)/bin/wisp.mjs</string><string>node</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.wisp/node.log</string>
  <key>StandardErrorPath</key><string>$HOME/.wisp/node.log</string>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.wisp.node.plist
tail ~/.wisp/node.log
```

Restart it with `launchctl kickstart -k gui/$(id -u)/ai.wisp.node`, and remove it with `launchctl bootout gui/$(id -u)/ai.wisp.node`. If you install a new harness later, run the snippet again so its folder is on the saved `PATH`.

**Screen permission:** for agents to use this Mac's own screen, macOS has to allow whatever started `wisp node`. In a terminal, that's the terminal app. As a LaunchAgent, it's the Node binary itself: in System Settings → Privacy & Security → **Accessibility** and **Screen Recording**, press **+**, press ⌘⇧G, and paste the path that `realpath "$(command -v node)"` prints (for example `/opt/homebrew/Cellar/node@22/22.x.y/bin/node`). Then restart the LaunchAgent. That path changes when Node is upgraded, so grant it again after an upgrade. `wisp doctor` prints the exact path to use.

### Linux (systemd)

A server or container, with no screen for agents to use:

```ini
# /etc/systemd/system/wisp-node.service
[Unit]
Description=Wisp device
After=network-online.target
Wants=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/wisp
ExecStart=/usr/bin/node bin/wisp.mjs node start
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now wisp-node
```

On a desktop where agents should use your screen, make it a user service instead (`~/.config/systemd/user/wisp-node.service`, without `User=`, and with `Environment=DISPLAY=:0`), and start it with `systemctl --user enable --now wisp-node`. A system service can't reach your desktop session.

### Windows (Task Scheduler)

Use a task that starts when you sign in, not a Windows service: services run outside your desktop session, so agents couldn't see or use your screen. In PowerShell:

```powershell
$wisp = (Get-Command wisp.cmd).Source
$log = "$env:USERPROFILE\.wisp\node.log"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command & '$wisp' node start *>> '$log'"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Wisp node" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "Wisp node"
```

Stop it with `Stop-ScheduledTask -TaskName "Wisp node"`, and remove it with `Unregister-ScheduledTask -TaskName "Wisp node"`.

## Updating

For source installs, the hub and devices run from a git checkout of Wisp, so updating means getting the latest commits. Built desktop apps carry a staged runtime and update through the desktop app's **Check for Updates…** menu. Use **Settings → Advanced → About** and the **Update** button on each device in **Devices**, or run `wisp update` (or `node bin/wisp.mjs update`) inside the checkout. It fast-forwards to what's on GitHub, runs `npm install` only if dependencies changed, rebuilds the web app if the checkout serves one, and then the hub and devices running from that folder restart themselves. Devices wait until no agent is running.

The restart works the same under systemd, launchd, Task Scheduler or a plain terminal: `wisp-hub` and `wisp node start` run the real process as a child and start it again after an update, so the services above need no changes. The user that runs Wisp needs to be able to write to the checkout and to `git pull` from where it was cloned (for a private repository, a read-only deploy key works).

A hub in Docker can't update itself: pull the new image and recreate the container (`docker compose pull && docker compose up -d`, or `docker pull ghcr.io/eireijie/wisp` and `docker run` again with the same volume).

## Reaching it from your phone

**Tailscale is built in.** Setup's first step, **Use Wisp from anywhere**, and **Settings → Access** walk the owner through it with buttons: install Tailscale on the computer running Wisp, sign in, then **Turn on the address**, which runs `tailscale serve` for the hub and gives it `https://<computer>.<tailnet>.ts.net`. From then on every link Wisp hands out (invites, devices joining, install commands, phone pairing) uses that address. **Let people without Tailscale in** turns on Tailscale Funnel for the same address, for a friend who isn't on your tailnet. On Linux, if Tailscale refuses Wisp's changes, run `sudo tailscale set --operator=$USER` once. A hub in Docker can't see Tailscale on its host; use one of the other ways below.

The Wisp apps for iPhone and Android pair with your hub by QR code: in Wisp on a computer, open **Settings → Mobile → Start pairing** and scan the code with the app. The code carries Wisp's Tailscale address when it's on, then the address you opened Wisp at plus the hub machine's Wi-Fi and Tailscale addresses, and the phone uses the first one it can reach.

The PWA needs HTTPS to install on iPhone and to use notifications. Pick one:

- **Tailscale (private, easiest):** use Settings → Access (above), or by hand: install Tailscale on the hub, then run `tailscale serve --bg 4747`. Open `https://<hub>.<tailnet>.ts.net` on any device in your tailnet.
- **Your own domain:** put Caddy or nginx in front of port 4747. Caddy example: `wisp.example.com { reverse_proxy localhost:4747 }`. WebSockets (`/ws`, `/ws/node`) must be proxied too; Caddy does that automatically.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:4747`.

On iPhone: open the URL in Safari → Share → **Add to Home Screen**.

## Push notifications for the iOS app

Wisp's iPhone app can tell you about agent replies, @mentions, approval requests and agents that need you on their computer while it's closed. That goes through Apple's push service (APNs), and **you bring your own Apple developer account**: a hub only sends pushes to apps signed by the same team as its key. It's optional; without a key everything else works and the app just doesn't notify while closed.

1. In [Apple Developer → Certificates, IDs & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list), click **+**, tick **Apple Push Notifications service (APNs)**, and download the `.p8` file (Apple lets you download it once). Note its **Key ID** and your **Team ID** (top right of the page).
2. Build the app with that team (see [apps/ios/README.md](../apps/ios/README.md)). If you change the bundle ID from `ai.wisp.ios`, the app tells the hub its own, so nothing else changes.
3. Give the hub the key, either way:
   - **Environment variables** (they win if set): `WISP_APNS_KEY_ID`, `WISP_APNS_TEAM_ID`, and `WISP_APNS_KEY_FILE=/path/to/AuthKey_XXXXXXXXXX.p8` (or the file's contents in `WISP_APNS_KEY`, with `\n` for newlines, handy in Docker). Restart the hub.
   - **Or as an owner, from the API:** `PUT /api/settings/push` with `{"keyId": "...", "teamId": "...", "key": "<contents of the .p8>"}`. `GET` shows what's set (never the key) and `DELETE` removes it.
4. On the phone, the app asks for permission the first time you send a message (or tap **You → Notifications → Turn on**). Send yourself a test with `POST /api/me/push/test`.

One key covers both of Apple's push servers: builds run from Xcode get development tokens and builds from TestFlight or the App Store get production ones, and the app tells the hub which it has. The hub keeps an HTTP/2 connection open to `api.push.apple.com` (or `api.sandbox.push.apple.com`), so it needs outbound HTTPS to Apple; nothing has to reach the hub from outside.

A phone stops getting pushes when you sign out of the app (or end that sign-in in Settings), or when Apple says the app was deleted. The app's badge is your unread count.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4747` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `WISP_DATA_DIR` | `./data` | Database, vault and files |
| `WISP_VAULT_DIR` | `<data>/vault` | Folder for the memory vault, e.g. an existing Obsidian vault. Overrides the choice in Settings → Memory. In Docker it must be inside a mounted volume |
| `WISP_WEB_DIR` | `apps/web/dist` | Built web app to serve |
| `WISP_APNS_KEY_ID` | | iOS push: your APNs key's 10-character Key ID |
| `WISP_APNS_TEAM_ID` | | iOS push: your Apple developer Team ID |
| `WISP_APNS_KEY_FILE` | | iOS push: path to the `.p8` key file (or put its contents in `WISP_APNS_KEY`) |
| `WISP_APNS_TOPIC` | `ai.wisp.ios` | iOS push: the app's bundle ID, if you changed it |
| `WISP_APNS_ENV` | `production` | iOS push: `sandbox` for builds run from Xcode |

Device daemon (`wisp node start`): `--hub`, `--token`, `--name`, `--dir` (default `~/.wisp`), `--allow-full-access`. Settings are saved to `~/.wisp/node.json`. At the device: `wisp node screen on|off` offers its own screen to you (off by default), and `wisp node pause` / `wisp node resume` stop and restart everything Wisp does there.

Each agent's model, reasoning effort and access level are set in Wisp (agent → **Model**). The device reports which models its harnesses offer, so the list always matches what's installed. Access levels map to each harness's own controls:

| Access | Claude Code | Codex |
| --- | --- | --- |
| Read only | `--permission-mode plan` | `sandbox_mode = "read-only"` |
| Can edit files (default) | `--permission-mode acceptEdits` | `sandbox_mode = "workspace-write"` |
| Full access | `--permission-mode bypassPermissions` | `sandbox_mode = "danger-full-access"` |

**For harnesses running directly on a device, full access requires `--allow-full-access`.** The device owner opts in, not the hub; without it, agents set to full access run with edit access and say so in the channel. Harnesses running inside a VM have full access there unless set to read only.

Agents work in `~/.wisp/agents/<handle>/` on their device, the folder shared with their VM, or a task's checkout when working on a repository task.
