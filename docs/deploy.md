# Deploying Warren

Warren is one process (the hub) plus any number of devices that run agents. The hub is light: well under 1 GB of RAM. Agents are heavier, because each run starts a harness like Claude Code or Codex.

## The installer

On a personal computer or a small server, the installer is the quickest way. It clones Warren to `~/warren`, installs it, and keeps the hub running with the system's service manager:

```bash
curl -fsSL https://raw.githubusercontent.com/eireijie/warren/main/install.sh | bash -s -- --hub-server
```

On Windows: `irm https://raw.githubusercontent.com/eireijie/warren/main/install.ps1 | iex`. The hub serves the same scripts at `/install.sh` and `/install.ps1`, which is what **Devices → Add device** uses.

## Docker

```bash
docker run -d --name warren -p 4747:4747 -v warren-data:/data --restart unless-stopped ghcr.io/eireijie/warren
```

Or, in a checkout, `docker compose up -d` (add `--build` to build the image from source).

Data is stored in `/data` in the container (`./data` with the compose file):

| Path | Contents |
| --- | --- |
| `data/warren.db` | SQLite: users, channels, messages, agents, tasks |
| `data/vault/` | The memory vault: a git repository of markdown files |
| `data/files/` | Uploaded files, stored by content hash |

Back up the whole folder. The vault is also a normal git repo, so you can `git clone` it to another machine or push it to a private remote.

## Proxmox (LXC)

A good split for a home lab:

- **Hub:** a small Debian 12 LXC (1 vCPU, 1 GB RAM, 8 GB disk). Put `data/` on fast storage and back it up to a bigger disk.
- **Agent devices:** one or more LXCs or VMs on your strongest node, with Node 22, git, and the harness CLIs (`claude`, `codex`) installed and logged in. Give them RAM; each running agent can use 0.5–2 GB.

Hub LXC, either with Docker (enable `nesting=1` on the container) or directly with Node:

```bash
apt-get update && apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
git clone https://github.com/eireijie/warren /opt/warren && cd /opt/warren
npm ci && npm run build
WARREN_DATA_DIR=/var/lib/warren npm start
```

To keep it running, create `/etc/systemd/system/warren.service`:

```ini
[Unit]
Description=Warren hub
After=network-online.target

[Service]
WorkingDirectory=/opt/warren
Environment=WARREN_DATA_DIR=/var/lib/warren PORT=4747
ExecStart=/usr/bin/node bin/warren-hub.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now warren
```

## Keeping a device connected

`warren node start` stays connected and reconnects by itself when the hub restarts or the network drops, but it stops when you close its terminal or restart the computer. To have the system start it from then on, run this from a terminal where your agent CLIs work, as the person who signed in to them (not root):

```bash
warren service install node --hub <hub URL> --token <token> --name <name>   # later runs: warren service install node
warren service status
warren service uninstall node
```

It writes and starts the service described below for your system, with that terminal's `PATH`, and waits until the device connects. `warren service install hub` does the same for a hub. The rest of this section is what it does, if you'd rather set it up yourself.

### macOS (LaunchAgent)

Run this inside the warren repo, from a terminal where your agent CLIs work. It saves that terminal's `PATH` into the LaunchAgent, because launchd otherwise starts programs with a minimal `PATH` and `warren node` wouldn't find `claude`, `codex` or the others.

```bash
mkdir -p ~/.warren
cat > ~/Library/LaunchAgents/ai.warren.node.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.warren.node</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string><string>$(pwd)/bin/warren.mjs</string><string>node</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.warren/node.log</string>
  <key>StandardErrorPath</key><string>$HOME/.warren/node.log</string>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.warren.node.plist
tail ~/.warren/node.log
```

Restart it with `launchctl kickstart -k gui/$(id -u)/ai.warren.node`, and remove it with `launchctl bootout gui/$(id -u)/ai.warren.node`. If you install a new harness later, run the snippet again so its folder is on the saved `PATH`.

**Screen permission:** for agents to use this Mac's own screen, macOS has to allow whatever started `warren node`. In a terminal, that's the terminal app. As a LaunchAgent, it's the Node binary itself: in System Settings → Privacy & Security → **Accessibility** and **Screen Recording**, press **+**, press ⌘⇧G, and paste the path that `realpath "$(command -v node)"` prints (for example `/opt/homebrew/Cellar/node@22/22.x.y/bin/node`). Then restart the LaunchAgent. That path changes when Node is upgraded, so grant it again after an upgrade. `warren doctor` prints the exact path to use.

### Linux (systemd)

A server or container, with no screen for agents to use:

```ini
# /etc/systemd/system/warren-node.service
[Unit]
Description=Warren device
After=network-online.target
Wants=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/warren
ExecStart=/usr/bin/node bin/warren.mjs node start
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now warren-node
```

On a desktop where agents should use your screen, make it a user service instead (`~/.config/systemd/user/warren-node.service`, without `User=`, and with `Environment=DISPLAY=:0`), and start it with `systemctl --user enable --now warren-node`. A system service can't reach your desktop session.

### Windows (Task Scheduler)

Use a task that starts when you sign in, not a Windows service: services run outside your desktop session, so agents couldn't see or use your screen. In PowerShell:

```powershell
$warren = (Get-Command warren.cmd).Source
$log = "$env:USERPROFILE\.warren\node.log"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command & '$warren' node start *>> '$log'"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Warren node" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "Warren node"
```

Stop it with `Stop-ScheduledTask -TaskName "Warren node"`, and remove it with `Unregister-ScheduledTask -TaskName "Warren node"`.

## Updating

Every hub and device runs from a git checkout of Warren, so updating means getting the latest commits. Use **Settings → Updates** and the **Update** button on each device in **Devices**, or run `warren update` (or `node bin/warren.mjs update`) inside the checkout. It fast-forwards to what's on GitHub, runs `npm install` only if dependencies changed, rebuilds the web app if the checkout serves one, and then the hub and devices running from that folder restart themselves. Devices wait until no agent is running.

The restart works the same under systemd, launchd, Task Scheduler or a plain terminal: `warren-hub` and `warren node start` run the real process as a child and start it again after an update, so the services above need no changes. The user that runs Warren needs to be able to write to the checkout and to `git pull` from where it was cloned (for a private repository, a read-only deploy key works).

A hub in Docker can't update itself: pull the new image and recreate the container (`docker compose pull && docker compose up -d`, or `docker pull ghcr.io/eireijie/warren` and `docker run` again with the same volume).

## Reaching it from your phone

The PWA needs HTTPS to install on iPhone and to use notifications. Pick one:

- **Tailscale (private, easiest):** install Tailscale on the hub, then run `tailscale serve --bg 4747`. Open `https://<hub>.<tailnet>.ts.net` on any device in your tailnet.
- **Your own domain:** put Caddy or nginx in front of port 4747. Caddy example: `warren.example.com { reverse_proxy localhost:4747 }`. WebSockets (`/ws`, `/ws/node`) must be proxied too; Caddy does that automatically.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:4747`.

On iPhone: open the URL in Safari → Share → **Add to Home Screen**.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4747` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `WARREN_DATA_DIR` | `./data` | Database, vault and files |
| `WARREN_WEB_DIR` | `apps/web/dist` | Built web app to serve |

Device daemon (`warren node start`): `--hub`, `--token`, `--name`, `--dir` (default `~/.warren`), `--allow-full-access`. Settings are saved to `~/.warren/node.json`. At the device: `warren node screen on|off` offers its own screen to you (off by default), and `warren node pause` / `warren node resume` stop and restart everything Warren does there.

Each agent's model, reasoning effort and access level are set in Warren (agent → **Model**). The device reports which models its harnesses offer, so the list always matches what's installed. Access levels map to each harness's own controls:

| Access | Claude Code | Codex |
| --- | --- | --- |
| Read only | `--permission-mode plan` | `sandbox_mode = "read-only"` |
| Can edit files (default) | `--permission-mode acceptEdits` | `sandbox_mode = "workspace-write"` |
| Full access | `--permission-mode bypassPermissions` | `sandbox_mode = "danger-full-access"` |

**Full access only works on devices started with `--allow-full-access`.** The device owner opts in, not the hub; without it, agents set to full access run with edit access and say so in the channel.

Agents work in `~/.warren/agents/<handle>/` on their device.
