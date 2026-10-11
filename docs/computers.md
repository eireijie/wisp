# Computers

Agents in Warren work on computers, the way people do. An agent opens apps and websites, signs in once and stays signed in, and keeps its files there. You can watch any computer live, take control whenever you like, and hand it back. Agents are only headless (no computer) when someone chooses that on the agent's **Computer** tab.

There are three kinds of computer:

| Kind | What it is | Needs |
| --- | --- | --- |
| **VM on a device** | A Linux desktop (Xfce, Chromium, a terminal) in a Docker container on one of your devices. Its own screen, so agents never touch yours. | Docker (Docker Desktop, OrbStack, Colima, Docker Engine) or Podman on that device |
| **A device's own screen** | The device that runs `warren node`, apps and all. Best on a spare computer. | macOS, Windows, or Linux with X11 (see below) |
| **Orgo cloud computer** | A Linux desktop from [orgo.ai](https://orgo.ai) that keeps running when your devices are off. | An Orgo API key in **Settings → Computers** |

Several agents can share one computer. They share its files, browser and sign-ins, so they can hand work to each other.

## Setting one up

- **Computers → Add computer**, or on an agent's **Computer** tab, or when you add an agent.
- `warren doctor` on a device says whether it can offer its screen and run VMs.

### VMs

The first VM on a device builds the `warren-computer` image from `docker/computer` (a few minutes). After that a VM starts in seconds. Its home folder lives in a Docker volume, so browser profiles and sign-ins survive restarts. Its `~/files` folder is shared with the device: when the agent's harness runs on the same device, that folder is its working folder, and Chromium saves downloads there.

The VM publishes no ports. Its VNC server only listens inside the container; the device reaches it with `docker exec … socat` and relays it to the hub.

Settings in the device's `~/.warren/node.json`: `"vmEngine": "podman"` to use Podman.

### A device's own screen

- **macOS**: the app that runs `warren node` (Terminal, iTerm…) needs **Screen Recording** and **Accessibility** permission in System Settings → Privacy & Security. Nothing else to install.
- **Windows**: works out of the box (a PowerShell helper drives the mouse and keyboard).
- **Linux**: an X11 session with `xdotool` and ImageMagick (`import`). Wayland isn't supported yet; use a VM instead.

Live view streams screenshots (about two a second). If the device already runs a VNC server, set its port on the computer and Warren relays that instead.

`"noScreen": true` in `node.json` stops a device from ever offering its screen. Shell commands from Warren (`computer_run`) only run on a device's screen computer when the device opted in with `--allow-full-access`.

### Orgo

Add your key under **Settings → Computers** (owners only). Warren checks it, then makes computers in an Orgo workspace called "Warren", or connects one you already have by its ID. The key stays on the hub. Watching an Orgo computer gives your browser that computer's VNC password, which Orgo designed for exactly this; anyone who can watch can also control it.

## Watching and taking control

Open **Computers** to see every screen, which agents use it, and whether one is **Working**. A computer an agent is using also shows up live in the conversation.

**Take control** sends your mouse and keyboard to the computer. While you have it, agents' clicks and typing are refused (they're told who has it and to wait or ask); they can still take screenshots. **Hand back** gives it back. If you go idle for 10 minutes, control returns to the agents.

Take control is for coordinating with agents, not a security boundary: anyone in the workspace who can open a computer can control it.

## When an agent needs you

Agents call `computer_ask_human` when they need a person: to sign in, type a 2FA code, solve a captcha. The request appears in the conversation with the screen, and under **Waiting on you** in the sidebar. Take control, do it, press **Hand back**, and the agent is woken to carry on. Agents are told never to ask for passwords in chat.

## Teaching a task

**Teach a task** (on a computer, or an agent's **Routines** tab): do the task once while the agent watches. Warren records your clicks, typing and key presses with a screenshot before each click, and you can add notes as you go. When you're done, name it. The agent studies the recording (it can look at the screenshots), writes the steps up as a routine in its memory folder, and tells you what it learned.

Routines run when someone presses **Run now**, when you ask the agent, or on a schedule (every day, weekdays, a weekly day, hourly, or any cron expression), in your time zone. The steps are an ordinary note you can edit.

## The tools agents get

With a computer, an agent's `warren-mcp` tools include `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`, `computer_open`, `computer_wait`, `computer_run` (VMs and cloud computers) and `computer_ask_human`. Coordinates are pixels in the latest screenshot (scaled to fit 1280×800), and every action returns a fresh screenshot. Every agent also has `approval_request`, `routine_save`, `routine_list` and `file_view`.
