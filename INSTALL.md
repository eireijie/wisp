# Installing Warren (a guide for AI agents)

This guide is written for an AI agent installing Warren for someone, though people can follow it too. Read it all before starting. [README.md](README.md) explains what Warren is; [docs/deploy.md](docs/deploy.md) and [docs/computers.md](docs/computers.md) have more detail.

Warren has two parts:

- **The hub:** one always-on server. It holds the workspace (chats, agents, memory, files) and serves the web app. A workspace has exactly one hub.
- **Devices:** computers that run agents and give them computers (VMs in Docker; a device's own screen only if its owner turns it on there with `warren node screen on`). Each device connects out to the hub, so it works behind routers. The hub's machine can be a device too.

Every machine gets its own git checkout of Warren and runs it from there. Updates later are `warren update` or a button in the app.

## Ground rules

- **Never ask for passwords, API keys or GitHub credentials in chat.** When something needs a sign-in (GitHub, Tailscale, a harness like Claude Code), start the browser flow and ask the person to approve it there.
- **The one secret you may be given** is a device token (`wr_node_…`). It only lets one device join the workspace, and deleting the device in Warren revokes it.
- **The person creates the workspace and their account themselves** in the browser. Don't do it for them.
- **Don't change security settings yourself** (macOS Privacy & Security, firewalls). Tell the person exactly what to change.
- **Don't touch anything unrelated** on the machine: other containers, VMs, services or users.
- **Finish with a report:** what you did, the URL, what's left for the person, and anything in this guide that was wrong or unclear.

## 1. Requirements

| | Hub | Device |
| --- | --- | --- |
| OS | Linux (Debian 12 or Ubuntu 24.04 recommended), macOS, or Docker | macOS, Windows, or Linux |
| Node.js | 22 or newer | 22 or newer |
| git | yes | yes |
| Docker | no | only to offer VMs to agents (Docker Engine, Docker Desktop, OrbStack, Colima, or Podman) |
| Harnesses | no | at least one agent CLI installed and signed in: `claude`, `codex`, `hermes`, `gemini`, `opencode`, `goose`, … |
| Resources | 1 CPU, 1 GB RAM, a few GB of disk | 0.5–2 GB RAM per running agent; about 1 GB per VM |

Install Node 22: Debian/Ubuntu `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`; macOS `brew install node@22` (and put it on `PATH`); Windows `winget install OpenJS.NodeJS.LTS` and Git with `winget install Git.Git`.

### On a Proxmox host

Put the hub in its own unprivileged LXC: Debian 12, 2 cores, 4 GB RAM, 24 GB disk, starts on boot, with `nesting=1,keyctl=1` so Docker works inside it (it can then also be a device that runs VMs). To use Tailscale inside it, add to `/etc/pve/lxc/<id>.conf` before starting it:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Use `pvesh get /cluster/nextid` for a free ID, `pvesm status` for storage that allows containers, and the node's existing Debian 12 template (`pveam list <storage>`). Run commands inside it with `pct exec <id> -- …`.

## 2. Get the code

- **Linux hub:** create a user to run Warren (`useradd -m -s /bin/bash warren`, and add it to the `docker` group if Docker is installed), clone to `/opt/warren` owned by that user, and keep data in `/var/lib/warren`.
- **Device:** clone to `~/warren` as the person who signed in to the harnesses (not root).

```bash
git clone https://github.com/eireijie/warren.git <folder>
```

**If the repository is private:** a server should get a **read-only deploy key**, not someone's GitHub login.
1. As the user that runs Warren, run `ssh-keygen -t ed25519 -N "" -f ~/.ssh/warren_deploy`.
2. Point git at it: add `Host github.com` / `IdentityFile ~/.ssh/warren_deploy` / `IdentitiesOnly yes` to `~/.ssh/config`, and run `ssh-keyscan github.com >> ~/.ssh/known_hosts`.
3. Add the public key to the repo. If `gh` is signed in somewhere with access, run `gh repo deploy-key add <file.pub> --repo eireijie/warren`. Otherwise show the person the key and the page to add it on (repository → Settings → Deploy keys, read-only).
4. Clone with `git@github.com:eireijie/warren.git`.

On a personal computer, `gh auth login --web` (the person approves in the browser) is fine instead.

Then, inside the folder:

```bash
npm ci                 # install scripts for better-sqlite3, esbuild and fsevents are expected
```

## 3. Install the hub

```bash
npm run build
```

Run it as a service. On Linux, `/etc/systemd/system/warren.service`:

```ini
[Unit]
Description=Warren hub
After=network-online.target
Wants=network-online.target

[Service]
User=warren
WorkingDirectory=/opt/warren
Environment=WARREN_DATA_DIR=/var/lib/warren PORT=4747
ExecStart=/usr/bin/node bin/warren-hub.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

Run `systemctl daemon-reload && systemctl enable --now warren`, then check `curl -s localhost:4747/healthz` prints `{"ok":true}`.

**HTTPS (needed to install the app on a phone):** if the person uses Tailscale, install it (`curl -fsSL https://tailscale.com/install.sh | sh`) and run `tailscale up --hostname warren`. That prints a login link: give it to the person to approve. Then run `tailscale serve --bg 4747`; the hub is at `https://warren.<tailnet>.ts.net`. The first visit takes up to a minute while the certificate is issued. Other options are in [docs/deploy.md](docs/deploy.md#reaching-it-from-your-phone).

**Then hand over to the person:** give them the hub's URL and ask them to:
1. Create the workspace and their account.
2. Go to **Devices → Add device** for each device, which gives a token.

## 4. Install a device

You need the hub's URL and a device token from **Devices → Add device**.

```bash
npm link                      # optional: puts `warren` on PATH; otherwise use `node bin/warren.mjs`
warren doctor                 # harnesses found, whether agents can use this screen, whether VMs work
warren node start --hub <hub URL> --token <token> --name "<device name>"
```

Wait for `connected to … as "<name>"`, then stop it. The hub, token and name are saved to `~/.warren/node.json`. If the hub runs on the same machine, `http://127.0.0.1:4747` works as the hub URL.

Keep it running with the system's service manager. The exact steps for macOS (LaunchAgent), Linux (systemd) and Windows (a scheduled task at sign-in, not a service) are in [docs/deploy.md → Keeping a device connected](docs/deploy.md#keeping-a-device-connected). Two things go wrong most often:

- **macOS:** launchd starts programs with a minimal `PATH`, so write the person's `PATH` into the LaunchAgent, or `warren node` won't find `claude`, `codex` and the rest.
- **Screen access:** a device's own screen is off by default. Only if the person wants to use it from Warren (and lend it to agents) do they run `warren node screen on`, and macOS then needs **Screen Recording** and **Accessibility** for whatever runs `warren node`. `warren doctor` prints exactly what to add. Tell the person; don't run it or change it yourself.

**VMs:** if the device has Docker, build the desktop image now so the first VM starts quickly. Run `docker build -t warren-computer:<N> docker/computer`, where `<N>` is the number in `IMAGE` in `apps/node/src/computers/docker.ts`. Agents get VMs from **Computers → Add computer → VM** in the app.

## 5. Check and report

- **Hub:** the service is active, `/healthz` answers, and the URL loads in a browser.
- **Device:** the device shows **online** in **Devices**, with its version, and `warren doctor` lists the harnesses you expect.
- **Report:** tell the person what's left for them, such as creating the workspace, granting screen permissions, signing in to harnesses, or adding agents in **Agents → Add agent**.

## Starting over

To remove Warren from a machine:
1. Stop and remove its service (`systemctl disable --now warren warren-node`; `launchctl bootout gui/$(id -u)/ai.warren.node`; or `Unregister-ScheduledTask -TaskName "Warren node"`).
2. Delete the checkout, and `~/.warren` on devices.
3. On a hub, delete the data folder (`/var/lib/warren`) as well. **That deletes the workspace**, so only do it when the person asked for it.
4. Delete a removed device in the app under **Devices**.

## Updating later

`warren update` in the folder, or **Settings → Updates** and the **Update** button on each device. See [README → Updating](README.md#updating).
