# Installing Wisp (a guide for AI agents)

This guide is written for an AI agent installing Wisp for someone, though people can follow it too. Read it all before starting. [README.md](README.md) explains what Wisp is; [docs/deploy.md](docs/deploy.md) and [docs/computers.md](docs/computers.md) have more detail.

Coming from Warren? Updating moves `~/.warren` to `~/.wisp` and replaces old services; `wisp migrate` does it by hand. See [the migration notes](docs/deploy.md#coming-from-warren) for compatibility and phone pairing.

Wisp has two parts:

- **The hub:** one always-on server. It holds the workspace (chats, agents, memory, files) and serves the web app. A workspace has exactly one hub.
- **Devices:** computers that run agents and give them computers (VMs in Docker; a device's own screen only if its owner turns it on there with `wisp node screen on`). Each device connects out to the hub, so it works behind routers. The hub's machine can be a device too.

Every machine gets its own git checkout of Wisp and runs it from there. Updates later are `wisp update` or a button in the app.

**The short way.** On a personal computer, the installer does steps 2–4 below for you. It doesn't use sudo and asks before installing anything:

```bash
# the hub, on macOS or Linux (Windows: irm https://raw.githubusercontent.com/eireijie/wisp/main/install.ps1 | iex)
curl -fsSL https://raw.githubusercontent.com/eireijie/wisp/main/install.sh | bash -s -- --hub-server
# a device, with the token the person got from Devices → Add device
curl -fsSL <hub URL>/install.sh | bash -s -- --hub <hub URL> --token <token> --name "<device name>"
```

It clones to `~/wisp` (`--dir` to change it), installs dependencies, links `wisp` into `~/.local/bin`, and runs `wisp service install hub|node`, which starts it at login. With `--hub-server` it also runs `wisp service install node --local`, so the hub's own computer becomes the owner's device as soon as they make their account (no token; `--no-device` skips it), prints the computer's Wi-Fi address and opens the browser (`--no-open` skips it). Setup in the browser then starts with Tailscale, so Wisp works from anywhere: a LaunchAgent on macOS, a systemd user service on Linux (or a system service when run as root), a task at sign-in on Windows. On a dedicated Linux server, follow the steps below instead so the hub runs as its own user.

## Ground rules

- **Never ask for passwords, API keys or GitHub credentials in chat.** When something needs a sign-in (GitHub, Tailscale, a harness like Claude Code), start the browser flow and ask the person to approve it there.
- **The one secret you may be given** is a device token (`wr_node_…`). It only lets one device join the workspace, and deleting the device in Wisp revokes it.
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

- **Linux hub:** create a user to run Wisp (`useradd -m -s /bin/bash wisp`, and add it to the `docker` group if Docker is installed), clone to `/opt/wisp` owned by that user, and create its data folder before starting the service: `install -d -o wisp -g wisp /var/lib/wisp`.
- **Device:** clone to `~/wisp` as the person who signed in to the harnesses (not root).

```bash
git clone https://github.com/eireijie/wisp.git <folder>
```

**If you're installing from a private fork:** a server should get a **read-only deploy key**, not someone's GitHub login.
1. As the user that runs Wisp, run `ssh-keygen -t ed25519 -N "" -f ~/.ssh/wisp_deploy`.
2. Point git at it: add `Host github.com` / `IdentityFile ~/.ssh/wisp_deploy` / `IdentitiesOnly yes` to `~/.ssh/config`, and run `ssh-keyscan github.com >> ~/.ssh/known_hosts`.
3. Add the public key to the repo. If `gh` is signed in somewhere with access, run `gh repo deploy-key add <file.pub> --repo eireijie/wisp`. Otherwise show the person the key and the page to add it on (repository → Settings → Deploy keys, read-only).
4. Clone with `git@github.com:eireijie/wisp.git`.

On a personal computer, `gh auth login --web` (the person approves in the browser) is fine instead.

Then, inside the folder:

```bash
npm ci                 # install scripts for better-sqlite3, esbuild and fsevents are expected
```

## 3. Install the hub

```bash
npm run build
```

Run it as a service. On Linux, `/etc/systemd/system/wisp.service`:

```ini
[Unit]
Description=Wisp hub
After=network-online.target
Wants=network-online.target

[Service]
User=wisp
WorkingDirectory=/opt/wisp
Environment=WISP_DATA_DIR=/var/lib/wisp PORT=4747
ExecStart=/usr/bin/node bin/wisp-hub.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

Run `systemctl daemon-reload && systemctl enable --now wisp`, then check `curl -s localhost:4747/healthz` prints `{"ok":true}`.

**HTTPS (needed to install the app on a phone):** if the person uses Tailscale, install it (`curl -fsSL https://tailscale.com/install.sh | sh`) and run `tailscale up --hostname wisp`. That prints a login link: give it to the person to approve. Then run `tailscale serve --bg 4747`; the hub is at `https://wisp.<tailnet>.ts.net`. The first visit takes up to a minute while the certificate is issued. Other options are in [docs/deploy.md](docs/deploy.md#reaching-it-from-your-phone).

**Then hand over to the person:** give them the hub's URL and ask them to:
1. Create the workspace and their account.
2. Go to **Devices → Add device** for each device, which gives a token.

## 4. Install a device

You need the hub's URL and a device token from **Devices → Add device**.

```bash
npm link                      # optional: puts `wisp` on PATH; otherwise use `node bin/wisp.mjs`
wisp setup                  # harnesses, a VM engine, and the VM image (asks before installing anything)
wisp service install node --hub <hub URL> --token <token> --name "<device name>"
```

The last command saves the hub, token and name to `~/.wisp/node.json`, starts the device at login with the system's service manager, and waits until it says `Connected to … as "<name>"`. If the hub runs on the same machine, `http://127.0.0.1:4747` works as the hub URL. Run it from a terminal where the person's harnesses (`claude`, `codex`…) work: it saves that terminal's `PATH` for the service. `wisp service status` shows whether it's running; the log is `~/.wisp/node.log`. The manual steps are in [docs/deploy.md → Keeping a device connected](docs/deploy.md#keeping-a-device-connected). Two things go wrong most often:

- **New harness later:** run `wisp service install node` again so its folder is on the saved `PATH`.
- **Screen access:** a device's own screen is off by default. Only if the person wants to use it from Wisp (and lend it to agents) do they run `wisp node screen on`, and macOS then needs **Screen Recording** and **Accessibility** for whatever runs `wisp node`. `wisp doctor` prints exactly what to add. Tell the person; don't run it or change it yourself.

**VMs:** agents work on VMs on the device, so `wisp setup` matters. It asks before installing a VM engine: ask the person and pass their answer on (or run `wisp setup --yes` once they've agreed). On a Mac with Apple silicon it installs Apple's `container` with Homebrew; on Linux it prints the commands for Docker or Podman, which need `sudo`, so leave those to the person. It then gets the VM image (a download, or a build of a few minutes). In the app, **Get started → Give your agents a computer** creates the first VM.

## 5. Check and report

- **Hub:** the service is active, `/healthz` answers, and the URL loads in a browser.
- **Device:** the device shows **online** in **Devices**, with its version, and `wisp doctor` lists the harnesses you expect.
- **Report:** tell the person what's left for them, such as creating the workspace, creating their agents' computer and first agent in **Get started**, and signing the harness in inside the VM (the agent's **Computer** tab → **Sign in**).

## Starting over

To remove Wisp from a machine:
1. Stop and remove its service: `wisp service uninstall hub` and `wisp service uninstall node` (or, for a service you wrote by hand, `systemctl disable --now wisp wisp-node`).
2. Delete the checkout, and `~/.wisp` on devices.
3. On a hub, delete the data folder (`/var/lib/wisp`) as well. **That deletes the workspace**, so only do it when the person asked for it.
4. Delete a removed device in the app under **Devices**.

## Updating later

`wisp update` in the folder, or **Settings → Advanced → About** and the **Update** button on each device. See [README → Updating](README.md#updating).
