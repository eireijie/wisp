# Computers

Agents in Warren work on computers of their own, the way people do. An agent opens apps and websites, signs in once and stays signed in, and keeps its files there. You can watch any computer live, take control whenever you like, and hand it back. Agents are only headless (no computer) when someone chooses that on the agent's **Computer** tab.

The usual computer is a **VM on one of your devices**: its own Linux desktop, separate from everything else on the device. Setting one up is step 2 of **Get started**, right after connecting a device.

There are three kinds of computer:

| Kind | What it is | Needs |
| --- | --- | --- |
| **VM on a device** | A Debian 13 desktop with a dock (Google Chrome, Terminal, Files) on one of your devices. Its own screen, files and sign-ins, so agents never touch yours. | Apple's `container` (Macs with Apple silicon), Docker (Docker Desktop, OrbStack, Colima, Docker Engine) or Podman. `warren setup` installs one. |
| **Your own screen** | The screen of a device you connected, apps and all. Off unless you turn it on at that device; only you can see it, and agents use it only while you lend it. | macOS, Windows, or Linux with X11 (see below) |
| **Orgo cloud computer** | A Linux desktop from [orgo.ai](https://orgo.ai) that keeps running when your devices are off. | An Orgo API key in **Settings → Computers** |

Several agents can share one computer. They share its files, browser and sign-ins, so they can hand work to each other.

## Setting one up

- **Get started → Give your agents a computer**, **Computers → Add computer**, an agent's **Computer** tab, or when you add an agent.
- `warren doctor` on a device says whether it can run VMs and offer its screen.

### VMs

On the device, run `warren setup` once. It checks what's installed, offers to install a VM engine (asking first: Apple's `container` with Homebrew on a Mac with Apple silicon; on Linux it shows the commands for Docker or Podman), and gets the VM image. A device also starts getting the image as soon as `warren node start` connects, so the first VM starts in seconds.

The image comes from `docker/computer`. Its tag is a hash of that recipe, so devices download the image CI published for exactly that recipe (`ghcr.io/<owner>/warren-computer:<hash>`, from `.github/workflows/vm-image.yml`; make the package public so devices can pull it) and build it themselves when there isn't one (a few minutes, once).

Each VM is a Debian 13 ("trixie") desktop with a dock of three apps: Google Chrome (from Google's own repository, on Intel and ARM), a terminal and a file manager, both opening in `~/files`. Chrome opens maximized above the dock, and links open in it. The desktop is set up the same way at every start. The kernel comes from the VM engine, not Debian: Apple's container gives each VM its own (6.18 at the time of writing), and Docker uses the host's or Docker Desktop's.

A VM's home folder lives in a volume, so browser profiles and sign-ins survive restarts. Its `~/files` folder is shared with the device, and Chrome saves downloads there. The VM publishes no ports: its VNC server and browser debugging port only listen inside it, and the device reaches them with the engine's `exec`.

Settings in the device's `~/.warren/node.json`: `"vmEngine": "container"`, `"docker"` or `"podman"` to pick the engine (by default: Apple's container on a Mac, then Docker, then Podman).

### Agents that run inside their VM

Claude Code, Codex, Hermes and Kimi CLI come with the VM, so an agent using them can run entirely inside its VM: its shell, files and browser all stay there, and it can't touch the device. That's the default for a new agent with a VM on its own device, and you can switch on its **Computer** tab (**Where it runs**). Inside its VM an agent has full access (the VM is its sandbox) unless it's set to read-only, so it can install what it needs and finish the job.

Sign the harness in once per VM: on the agent's **Computer** tab press **Sign in to Claude Code** (or Codex, Hermes, Kimi CLI). A terminal opens on the VM's screen and you get control to finish signing in; the browser for it opens in the VM too. The terminal runs the harness's own sign-in: `claude`, `codex login`, `hermes setup` (pick a provider and model, or sign in to Nous) or `kimi login`. Agents that share a VM share that sign-in.

Coding tasks work the same: the agent gets its own clone of the team's repo in the VM's shared folder, and its commits come back to the device's copy for reviews and merges.

Hermes and Kimi CLI run there over [ACP](adapters.md): Warren starts `hermes acp` or `kimi acp` inside the VM with the in-VM `warren-mcp` and the VM's browser tools. Hermes is installed from Nous Research's own installer, pinned to a release, in `/opt/hermes` (its settings and sessions live in `~/.hermes`, in the VM's home volume); Kimi CLI is the `@moonshot-ai/kimi-code` npm package (settings in `~/.kimi-code`). Both are installed in the image for Intel and ARM. Bringing in an existing Hermes profile copies its soul and notes; its provider keys stay on the device, so sign Hermes in on the VM once. Agents that were set up to run on the device before keep running there until you pick **Inside its computer**.

Harnesses that don't come with the VM (Gemini CLI, OpenCode…) run directly on the device, where only the device's owner can ask them for things.

### Your own screen

A device's own screen is its owner's: the person who connected the device. It's off until someone at the device turns it on, and nobody else in the workspace can see it, watch it, take control of it, or give it to an agent:

```bash
warren node screen on     # on that device; `warren node screen off` turns it off again
```

Then **Computers → Add computer → Your own screen**. Agents can't use it until you **Lend it to agents** (for an hour, four hours, the rest of the day, or until you stop), and even then only for things you asked for, directly or through other agents. An agent working on someone else's request is turned away. Everything done on it shows under **Activity** on its page.

Use it when a task needs an app or file that only lives on your computer. For everything else, agents have their own VMs.

- **macOS**: whatever starts `warren node` needs **Screen Recording** and **Accessibility** permission in System Settings → Privacy & Security: your terminal app (Terminal, iTerm…) if you run it there, or the Node binary if it runs in the background as a LaunchAgent. `warren doctor` prints which, and [Deploying](deploy.md#macos-launchagent) shows how to add the Node binary. Nothing else to install.
- **Windows**: works out of the box (a PowerShell helper drives the mouse and keyboard).
- **Linux**: an X11 session with `xdotool` and ImageMagick (`import`). Wayland isn't supported yet; use a VM instead.

Live view streams screenshots (about two a second). If the device already runs a VNC server, set its port on the computer and Warren relays that instead.

`"noScreen": true` in `node.json` stops a device from ever offering its screen, whatever `warren node screen on` says. Shell commands from Warren (`computer_run`) only run on a device's own screen when the device opted in with `--allow-full-access`.

### Orgo

Add your key under **Settings → Computers** (owners only). Warren checks it, then makes computers in an Orgo workspace called "Warren", or connects one you already have by its ID. The key stays on the hub. Watching an Orgo computer gives your browser that computer's VNC password, which Orgo designed for exactly this; anyone who can watch can also control it.

## Watching and taking control

Open **Computers** to see every screen, which agents use it, and whether one is **Working**. A computer an agent is using also shows up live in the conversation.

**Take control** sends your mouse and keyboard to the computer. While you have it, agents' clicks and typing are refused (they're told who has it and to wait or ask); they can still take screenshots. **Hand back** gives it back. If you go idle for 10 minutes, control returns to the agents.

Take control is for coordinating with agents on shared computers: anyone in the workspace can watch and control a VM or cloud computer. Your own screen is only ever yours.

## Who can reach your computer

- **Devices belong to whoever connected them.** Only you put agents and VMs on your device, bring in agents from it, or change agents that run on it. Under **Devices** you can let others add agents and VMs there (for a shared server, say).
- **Agents that run directly on your device only work for you.** Their harness can reach that device's files, so requests from anyone else (or from agents working for someone else) are turned away. You can open one up to everyone on its **Permissions** tab; it still can't use your own screen for them.
- **Harnesses don't get the device's token.** Each agent's harness gets a token for that agent only.
- **Pause everything at the device:** `warren node pause` stops running agents, computer use and live views within a second or two, and the hub holds new requests until `warren node resume`.

## When an agent needs you

Agents call `computer_ask_human` when they need a person: to sign in, type a 2FA code, solve a captcha. The request appears in the conversation with the screen, and under **Waiting on you** in the sidebar. Take control, do it, press **Hand back**, and the agent is woken to carry on. Agents are told never to ask for passwords in chat.

## Teaching a task

**Teach a task** (on a computer, or an agent's **Routines** tab): do the task once while the agent watches. Warren records your clicks, typing and key presses with a screenshot before each click, and on a VM also which web page element you clicked ("the New expense button on expenses.example.com"), so the routine still works when the page's layout changes. You can add notes as you go. When you're done, name it. The agent studies the recording (it can look at the screenshots), writes the steps up as a routine in its memory folder, and tells you what it learned.

Routines run when someone presses **Run now**, when you ask the agent, or on a schedule (every day, weekdays, a weekly day, hourly, or any cron expression), in your time zone. The steps are an ordinary note you can edit.

## The tools agents get

With a computer, an agent's `warren-mcp` tools include `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`, `computer_open`, `computer_wait`, `computer_run` (VMs and cloud computers) and `computer_ask_human`. Coordinates are pixels in the latest screenshot (scaled to fit 1280×800), and every action returns a fresh screenshot. Every agent also has `approval_request`, `routine_save`, `routine_list` and `file_view`.

**Browser tools.** With a VM, an agent also gets [Playwright MCP](https://github.com/microsoft/playwright-mcp) on the VM's own Chrome, the one you watch, with its sign-ins: `browser_navigate`, `browser_snapshot` (the page as text, with a ref for each element), `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_tabs`, `browser_wait_for` and more. Working with page elements instead of pixels is faster, cheaper and much more reliable on websites; agents use the screenshot tools for everything else. The browser tools run inside the VM whichever way the agent runs.
