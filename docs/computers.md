# Computers

Agents in Wisp work on computers of their own, the way people do. An agent opens apps and websites, signs in once and stays signed in, and keeps its files there. You can watch any computer live, take control whenever you like, and hand it back. Agents are only headless (no computer) when someone chooses that on the agent's **Computer** tab.

The usual computer is a **VM on one of your devices**: its own Linux desktop, separate from everything else on the device. Setting one up is step 2 of **Get started**, right after connecting a device.

There are three kinds of computer:

| Kind | What it is | Needs |
| --- | --- | --- |
| **VM on a device** | A Debian 13 desktop with a dock (Google Chrome, Terminal, Files) on one of your devices. Its own screen, files and sign-ins, so agents never touch yours. | Apple's `container` (Macs with Apple silicon), Docker (Docker Desktop, OrbStack, Colima, Docker Engine) or Podman. `wisp setup` installs one. |
| **Your own screen** | The screen of a device you connected, apps and all. Off unless you turn it on at that device; only you can see it, it opens with a code you pick there, and only agents that run on that device can use it. | macOS, Windows, or Linux with X11 (see below) |
| **Orgo cloud computer** | A Linux desktop from [orgo.ai](https://orgo.ai) that keeps running when your devices are off. | An Orgo API key in **Settings → Computers** |

Several agents can share one computer. They share its files, browser and sign-ins, so they can hand work to each other.

## Setting one up

- **Get started → Give your agents a computer**, **Computers → Add computer**, an agent's **Computer** tab, or when you add an agent.
- `wisp doctor` on a device says whether it can run VMs and offer its screen.

### VMs

On the device, run `wisp setup` once. It checks what's installed, offers to install a VM engine (asking first: Apple's `container` with Homebrew on a Mac with Apple silicon; on Linux it shows the commands for Docker or Podman), and gets the VM image. A device also starts getting the image as soon as `wisp node start` connects, so the first VM starts in seconds.

The image comes from `docker/computer`. Its tag is a hash of that recipe, so devices download the image CI published for exactly that recipe (`ghcr.io/<owner>/wisp-computer:<hash>`, from `.github/workflows/vm-image.yml`; make the package public so devices can pull it) and build it themselves when there isn't one (a few minutes, once).

Each VM is a Debian 13 ("trixie") desktop with a dock of three apps: Google Chrome (from Google's own repository, on Intel and ARM), a terminal and a file manager, both opening in `~/files`. Chrome opens maximized above the dock, and links open in it. The desktop is set up the same way at every start. The kernel comes from the VM engine, not Debian: Apple's container gives each VM its own (6.18 at the time of writing), and Docker uses the host's or Docker Desktop's.

A VM's home folder lives in a volume, so browser profiles and sign-ins survive restarts. Its `~/files` folder is shared with the device, and Chrome saves downloads there. The VM publishes no ports: its VNC server and browser debugging port only listen inside it, and the device reaches them with the engine's `exec`.

Settings in the device's `~/.wisp/node.json`: `"vmEngine": "container"`, `"docker"` or `"podman"` to pick the engine (by default: Apple's container on a Mac, then Docker, then Podman).

### Agents that run inside their VM

Claude Code, Codex, Hermes and Kimi CLI come with the VM, so an agent using them can run entirely inside its VM: its shell, files and browser all stay there, and it can't touch the device. That's the default for a new agent with a VM on its own device, and you can switch on its **Computer** tab (**Where it runs**). Inside its VM an agent has full access (the VM is its sandbox) unless it's set to read-only, so it can install what it needs and finish the job.

Sign the harness in once per VM: on the agent's **Computer** tab press **Sign in to Claude Code** (or Codex, Hermes, Kimi CLI). A terminal opens on the VM's screen and you get control to finish signing in; the browser for it opens in the VM too. The terminal runs the harness's own sign-in: `claude`, `codex login`, `hermes setup` (pick a provider and model, or sign in to Nous) or `kimi login`. Agents that share a VM share that sign-in.

Coding tasks work the same: the agent gets its own clone of the team's repo in the VM's shared folder, and its commits come back to the device's copy for reviews and merges.

Hermes and Kimi CLI run there over [ACP](adapters.md): Wisp starts `hermes acp` or `kimi acp` inside the VM with the in-VM `wisp-mcp` and the VM's browser tools. Hermes is installed from Nous Research's own installer, pinned to a release, in `/opt/hermes` (its settings and sessions live in `~/.hermes`, in the VM's home volume); Kimi CLI is the `@moonshot-ai/kimi-code` npm package (settings in `~/.kimi-code`). Both are installed in the image for Intel and ARM. Bringing in an existing Hermes profile copies its soul and notes; its provider keys stay on the device, so sign Hermes in on the VM once. Agents that were set up to run on the device before keep running there until you pick **Inside its computer**.

Harnesses that don't come with the VM (Gemini CLI, OpenCode…) run directly on the device, where only the device's owner can ask them for things.

### Your own screen

A device's own screen is its owner's: the person who connected the device. It's off until someone at the device turns it on, and nobody else in the workspace can see it, watch it, take control of it, or give it to an agent:

```bash
wisp node screen on     # on that device; `wisp node screen off` turns it off again
```

Turning it on asks you to pick a **code**: a 6-digit PIN or a password (8 characters or more). Opening the screen from Wisp needs it. So someone who gets into your Wisp account still can't see or use your computer. The code is checked on the device, which keeps only a hash of it. The hub passes it along and never saves it. After 5 wrong codes in a row the device stops taking codes for 15 minutes (twice as long each time after that, up to a day), even after a restart, and you get a notification. One code entry opens the screen for a day at most.

```bash
wisp node screen code        # pick a new code (only at the device)
wisp node screen code off    # no code: your Wisp sign-in alone opens the screen
```

In the desktop app it's the menu bar menu: **Let Me Use This Screen from Wisp** asks for a code when there isn't one, and **Change Screen Code…** picks a new one.

Then **Computers → Add computer → Your own screen**. Only agents that **run on that device** can use it: give one the screen as its computer on its **Computer** tab (Wisp refuses it for an agent that runs anywhere else). Even then it works only on things you asked for, directly or through other agents; an agent working on someone else's request is turned away. Agents on other devices or in VMs can't reach your screen at all. To have an agent work on a computer, run it on that computer. Everything done on it shows under **Activity** on its page.

The code guards the screen from Wisp, not from what already runs on the device: an agent whose harness is running there uses the screen without it while it works.

Use it when a task needs an app or file that only lives on your computer. For everything else, agents have their own VMs.

- **macOS**: whatever starts `wisp node` needs **Screen Recording** and **Accessibility** permission in System Settings → Privacy & Security: your terminal app (Terminal, iTerm…) if you run it there, or the Node binary if it runs in the background as a LaunchAgent. `wisp doctor` prints which, and [Deploying](deploy.md#macos-launchagent) shows how to add the Node binary. Nothing else to install.
- **Windows**: works out of the box (a PowerShell helper drives the mouse and keyboard).
- **Linux**: an X11 session with `xdotool` and ImageMagick (`import`). Wayland isn't supported yet; use a VM instead.

Live view streams screenshots (about two a second), unless you turn on **Remote Desktop**.

### Remote Desktop

`wisp node screen on` offers it, or run `wisp node screen remote` any time. It sets up a real VNC server for the screen, so live view is smooth instead of a few pictures a second:

- **Linux (X11)**: installs `x11vnc` with your package manager (it shows the command and asks; sudo asks for your password), and `wisp node` keeps it running while the screen is on.
- **Windows**: installs TightVNC with `winget` as a Windows service (Windows asks for permission once). If TightVNC is already installed with its own settings, Wisp leaves it alone.
- **macOS**: not yet, because Screen Sharing can't be made to listen on the Mac alone. Live view uses screenshots, and the code still protects the screen.

The server only listens on the device itself (127.0.0.1), on port 5931, and gets a random password that never leaves the device. Wisp's device program signs in with it and relays the connection to the hub, and only after your code checks out. `wisp node screen remote off` goes back to screenshots (the VNC server stays installed; Wisp just stops running and using it). `wisp doctor` shows whether it's answering.

If the device already runs a VNC server of its own, you can set its port on the computer instead, and Wisp relays that.

`"noScreen": true` in `node.json` stops a device from ever offering its screen, whatever `wisp node screen on` says. Shell commands from Wisp (`computer_run`) only run on a device's own screen when the device opted in with `--allow-full-access`.

### A program that only lives on one computer

Say a Windows POS app that exists only on the shop PC. Connect the shop PC as a device, add an agent that runs there, turn its screen on at the PC (`wisp node screen on`), and give the agent that screen as its computer. It works there like it would on a VM, only for things you ask. Agents elsewhere hand it work with `task_delegate` instead of reaching in.

### Orgo

Add your key under **Settings → Computers** (owners only). Wisp checks it, then makes computers in an Orgo workspace called "Wisp", or connects one you already have by its ID. The key stays on the hub. Watching an Orgo computer gives your browser that computer's VNC password, which Orgo designed for exactly this; anyone who can watch can also control it.

## Reaching your devices: the Remote desktop mod

Agents never remote into a person's computer; for that, run an agent on it. Remote desktop is for **you**: reaching your own devices from anywhere. Turn on **Remote desktop** under **Mods**, then on a device:

```bash
wisp node rustdesk        # at that device
```

It installs [RustDesk](https://rustdesk.com), free and open-source remote desktop, after asking (Homebrew on a Mac, winget on Windows, RustDesk's own .deb from its GitHub releases on Debian and Ubuntu; anywhere else, install it yourself and run the command again). Then it opens RustDesk and reads the device's RustDesk ID.

- **The password is yours.** Set a permanent password in RustDesk (**Settings → Security → Use permanent password**) and keep it in your password manager. Wisp never sees or stores it.
- **Only you see the ID.** It shows on the device's page under **Remote desktop**, with **Copy ID** and **Open in RustDesk** (which opens the RustDesk app on the computer or phone you're using). Nobody else in the workspace gets it.
- **On a Mac**, RustDesk asks for Screen Recording and Accessibility in System Settings → Privacy & Security.
- `wisp node rustdesk off` stops showing the ID in Wisp. RustDesk stays installed and works as before. `wisp doctor` shows whether it's set up.

Connections go through RustDesk's own servers, the same as using RustDesk on its own.

**Already use another app?** On the device's page choose **I already use one**, pick the app, and paste what identifies the device in it:

| App | What you paste | Open |
| --- | --- | --- |
| TeamViewer | its ID | opens TeamViewer (`teamviewer10://`, which some TeamViewer versions ignore; Copy always works) |
| AnyDesk | its ID or alias | opens AnyDesk (`anydesk:`) |
| Chrome Remote Desktop | a link (remotedesktop.google.com/access) | opens the page |
| Windows Remote Desktop | the computer's name or address | opens Microsoft's Remote Desktop app on a Mac, iPhone or Android (`rdp://`); on Windows, copy it into Remote Desktop Connection |
| Screen Sharing (Mac), VNC | the computer's name or address | opens Screen Sharing or your VNC viewer (`vnc://`) |
| Another app | its name and an https link | opens the link |

The device notices which of these are installed (or, for VNC and Remote Desktop, answering on it) and lists them first; `wisp doctor` shows them too. Like the RustDesk ID, what you paste is shown to you only, and Wisp never asks for the app's password.

## Watching and taking control

Open **Computers** to see every screen, which agents use it, and whether one is **Working**. A computer an agent is using also shows up live in the conversation.

**Take control** sends your mouse and keyboard to the computer. While you have it, agents' clicks and typing are refused (they're told who has it and to wait or ask); they can still take screenshots. **Hand back** gives it back. If you go idle for 10 minutes, control returns to the agents.

Take control is for coordinating with agents on shared computers: anyone in the workspace can watch and control a VM or cloud computer. Your own screen is only ever yours.

## Who can reach your computer

- **Devices belong to whoever connected them.** Only you put agents and VMs on your device, bring in agents from it, or change agents that run on it. Under **Devices** you can let others add agents and VMs there (for a shared server, say).
- **Agents that run directly on your device only work for you.** Their harness can reach that device's files, so requests from anyone else (or from agents working for someone else) are turned away. You can open one up to everyone on its **Permissions** tab; it still can't use your own screen for them.
- **Harnesses don't get the device's token.** Each agent's harness gets a token for that agent only.
- **Pause everything at the device:** `wisp node pause` stops running agents, computer use and live views within a second or two, and the hub holds new requests until `wisp node resume`.

## When an agent needs you

Agents call `computer_ask_human` when they need a person: to sign in, type a 2FA code, solve a captcha. The request appears in the conversation with the screen, and under **Waiting on you** in the sidebar. Take control, do it, press **Hand back**, and the agent is woken to carry on. Agents are told never to ask for passwords in chat.

## Teaching a task

**Teach a task** (on a computer, or an agent's **Routines** tab): do the task once while the agent watches. Wisp records your clicks, typing and key presses with a screenshot before each click, and on a VM also which web page element you clicked ("the New expense button on expenses.example.com"), so the routine still works when the page's layout changes. You can add notes as you go. When you're done, name it. The agent studies the recording (it can look at the screenshots), writes the steps up as a routine in its memory folder, and tells you what it learned.

Routines run when someone presses **Run now**, when you ask the agent, or on a schedule (every day, weekdays, a weekly day, hourly, or any cron expression), in your time zone. The steps are an ordinary note you can edit.

## The tools agents get

With a computer, an agent's `wisp-mcp` tools include `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`, `computer_open`, `computer_wait`, `computer_run` (VMs and cloud computers) and `computer_ask_human`. Coordinates are pixels in the latest screenshot (scaled to fit 1280×800), and every action returns a fresh screenshot. Every agent also has `approval_request`, `routine_save`, `routine_list` and `file_view`.

**Browser tools.** With a VM, an agent also gets [Playwright MCP](https://github.com/microsoft/playwright-mcp) on the VM's own Chrome, the one you watch, with its sign-ins: `browser_navigate`, `browser_snapshot` (the page as text, with a ref for each element), `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_tabs`, `browser_wait_for` and more. Working with page elements instead of pixels is faster, cheaper and much more reliable on websites; agents use the screenshot tools for everything else. The browser tools run inside the VM whichever way the agent runs.
