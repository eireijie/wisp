# Computers

Agents in Warren work on computers of their own, the way people do. An agent opens apps and websites, signs in once and stays signed in, and keeps its files there. You can watch any computer live, take control whenever you like, and hand it back. Agents are only headless (no computer) when someone chooses that on the agent's **Computer** tab.

The usual computer is a **VM on one of your devices**: its own Linux desktop, separate from everything else on the device. Setting one up is step 2 of **Get started**, right after connecting a device.

There are three kinds of computer:

| Kind | What it is | Needs |
| --- | --- | --- |
| **VM on a device** | A Debian 13 desktop with a dock (Google Chrome, Terminal, Files) on one of your devices. Its own screen, files and sign-ins, so agents never touch yours. | Apple's `container` (Macs with Apple silicon), Docker (Docker Desktop, OrbStack, Colima, Docker Engine) or Podman. `warren setup` installs one. |
| **Your own screen** | The screen of a device you connected, apps and all. Off unless you turn it on at that device; only you can see it, it opens with a code you pick there, and agents use it only while you lend it. | macOS, Windows, or Linux with X11 (see below) |
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

Turning it on asks you to pick a **code**: a 6-digit PIN or a password (8 characters or more). Opening the screen from Warren needs it, and so does lending it to agents or approving an agent's request to borrow it. So someone who gets into your Warren account still can't see or use your computer. The code is checked on the device, which keeps only a hash of it. The hub passes it along and never saves it. After 5 wrong codes in a row the device stops taking codes for 15 minutes (twice as long each time after that, up to a day), even after a restart, and you get a notification. One code entry opens the screen for a day at most.

```bash
warren node screen code        # pick a new code (only at the device)
warren node screen code off    # no code: your Warren sign-in alone opens the screen
```

In the desktop app it's the menu bar menu: **Let Me Use This Screen from Warren** asks for a code when there isn't one, and **Change Screen Code…** picks a new one.

Then **Computers → Add computer → Your own screen**. Agents can't use it until you **Lend it to agents** (for an hour, four hours, the rest of the day, or until you stop), and even then only for things you asked for, directly or through other agents. Or an agent can ask for it mid-task, and you approve just that ([below](#borrowing-your-device-mid-task)). An agent working on someone else's request is turned away. Everything done on it shows under **Activity** on its page.

Use it when a task needs an app or file that only lives on your computer. For everything else, agents have their own VMs.

- **macOS**: whatever starts `warren node` needs **Screen Recording** and **Accessibility** permission in System Settings → Privacy & Security: your terminal app (Terminal, iTerm…) if you run it there, or the Node binary if it runs in the background as a LaunchAgent. `warren doctor` prints which, and [Deploying](deploy.md#macos-launchagent) shows how to add the Node binary. Nothing else to install.
- **Windows**: works out of the box (a PowerShell helper drives the mouse and keyboard).
- **Linux**: an X11 session with `xdotool` and ImageMagick (`import`). Wayland isn't supported yet; use a VM instead.

Live view streams screenshots (about two a second), unless you turn on **Remote Desktop**.

### Remote Desktop

`warren node screen on` offers it, or run `warren node screen remote` any time. It sets up a real VNC server for the screen, so live view is smooth instead of a few pictures a second:

- **Linux (X11)**: installs `x11vnc` with your package manager (it shows the command and asks; sudo asks for your password), and `warren node` keeps it running while the screen is on.
- **Windows**: installs TightVNC with `winget` as a Windows service (Windows asks for permission once). If TightVNC is already installed with its own settings, Warren leaves it alone.
- **macOS**: not yet, because Screen Sharing can't be made to listen on the Mac alone. Live view uses screenshots, and the code still protects the screen.

The server only listens on the device itself (127.0.0.1), on port 5931, and gets a random password that never leaves the device. Warren's device program signs in with it and relays the connection to the hub, and only after your code checks out. `warren node screen remote off` goes back to screenshots (the VNC server stays installed; Warren just stops running and using it). `warren doctor` shows whether it's answering.

If the device already runs a VNC server of its own, you can set its port on the computer instead, and Warren relays that.

`"noScreen": true` in `node.json` stops a device from ever offering its screen, whatever `warren node screen on` says. Shell commands from Warren (`computer_run`) only run on a device's own screen when the device opted in with `--allow-full-access`.

### Borrowing your device mid-task

An agent works on its own VM and asks for your device only when a task needs it, say a Windows POS app that exists only on the shop PC. The agent calls `device_request` ("I need the shop PC to enter today's sales in the POS") and you get an **Approve / Deny** card in your chat with that agent (and a push notification, like any approval). You pick how long it gets: 15 minutes, 1 hour, or until it hands the device back (never more than 12 hours).

- **Only the device's owner can say yes**, with the screen's code if it has one. Nobody else in the workspace can approve it, and an agent can't approve its own request.
- **The screen has to be on.** If `warren node screen on` was never run at the device, the agent is told the owner has to turn it on there; Warren can't do that remotely. A device that is paused (`warren node pause`) or offline can't be asked either, and pausing during a loan stops the agent at once.
- **One agent, one loan, a screen and no shell.** Only the agent you approved can use the device; other agents are turned away, and `computer_run` is refused on a borrowed device. This works even if the agent is doing a task for someone else, because you decided. The loan is separate from **Lend it to agents**, which lets agents use the screen for things you ask them.
- **It always ends.** When the time is up, when the agent calls `device_return`, when you press **Take back**, when you press **Stop lending it**, or when the screen is turned off at the device. The agent is told in the conversation it was working in (except when it handed the device back itself), and the loan can't outlive its limit: every use is checked against it, whether or not anything has cleaned up yet. Taking control and handing back works as before and leaves the loan alone; agents wait while you have control.

While a device is on loan, its page and its card on **Computers** say "Lent to @hermes until 3:40 PM" with a **Take back** button. Everything the agent does shows under **Activity**.

**How an agent picks which computer.** Its own computer stays the default: every `computer_*` tool acts on it, borrowed device or not. To act on the device, the agent adds `computer: "<device name>"` to the tool call (`computer_screenshot`, `computer_click`, …). Leaving it out never touches your device, and naming a device it isn't borrowing is refused. Agents without a computer of their own can borrow too; they have to pass `computer` every time. Agents that were set up as headless can't borrow.

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

With a computer, an agent's `warren-mcp` tools include `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`, `computer_open`, `computer_wait`, `computer_run` (VMs and cloud computers) and `computer_ask_human`. Coordinates are pixels in the latest screenshot (scaled to fit 1280×800), and every action returns a fresh screenshot. Every computer tool takes an optional `computer` (the name of a device the agent is borrowing). Every agent also has `device_list`, `device_request` and `device_return` (see [Borrowing your device mid-task](#borrowing-your-device-mid-task)), `approval_request`, `routine_save`, `routine_list` and `file_view`.

**Browser tools.** With a VM, an agent also gets [Playwright MCP](https://github.com/microsoft/playwright-mcp) on the VM's own Chrome, the one you watch, with its sign-ins: `browser_navigate`, `browser_snapshot` (the page as text, with a ref for each element), `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_tabs`, `browser_wait_for` and more. Working with page elements instead of pixels is faster, cheaper and much more reliable on websites; agents use the screenshot tools for everything else. The browser tools run inside the VM whichever way the agent runs.
