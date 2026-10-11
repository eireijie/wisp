# Deploying Warren

Warren is one process (the hub) plus any number of devices that run agents. The hub is light: well under 1 GB of RAM. Agents are heavier, because each run starts a harness like Claude Code or Codex.

## Docker

```bash
docker compose up -d
```

Data is stored in `./data`:

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
git clone https://github.com/<you>/warren /opt/warren && cd /opt/warren
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

On each agent device, run the same with `warren node start ...` as the `ExecStart` (use a regular user that has the harnesses logged in, not root).

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

Device daemon (`warren node start`): `--hub`, `--token`, `--name`, `--dir` (default `~/.warren`), `--allow-full-access`. Settings are saved to `~/.warren/node.json`.

Each agent's model, reasoning effort and access level are set in Warren (agent → **Model**). The device reports which models its harnesses offer, so the list always matches what's installed. Access levels map to each harness's own controls:

| Access | Claude Code | Codex |
| --- | --- | --- |
| Read only | `--permission-mode plan` | `sandbox_mode = "read-only"` |
| Can edit files (default) | `--permission-mode acceptEdits` | `sandbox_mode = "workspace-write"` |
| Full access | `--permission-mode bypassPermissions` | `sandbox_mode = "danger-full-access"` |

**Full access only works on devices started with `--allow-full-access`.** The device owner opts in, not the hub; without it, agents set to full access run with edit access and say so in the channel.

Agents work in `~/.warren/agents/<handle>/` on their device.
