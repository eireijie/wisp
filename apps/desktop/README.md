# Warren desktop

Warren in its own window on Mac, Windows and Linux, plus the things only an app on your computer can do:

- **Run the hub here.** Pick "On this computer" the first time and the app starts the hub for you, keeps it running from the menu bar after you close the window, and stops it when you quit. If `warren service install hub` already runs one, the app uses that.
- **Or connect to a hub you already run** on a home server, a VPS or a Tailscale address.
- **This computer as a device, in one click.** Menu bar → **Connect This Computer for Agents…** adds the device for the person signed in and starts it, with no token to copy. From the same menu you can let yourself use this screen from Warren and pause agents here (the same settings as `warren node screen on|off` and `warren node pause|resume`).
- **Unread messages on the Dock icon**, desktop notifications, and a Go menu (⌘1–4) for the main pages.

The app runs the same `warren` CLI a terminal would, from your Warren folder (the one `install.sh` made in `~/warren`, the folder a `warren service` runs from, or one you choose) with your own Node.js 22+. It uses your login shell's PATH, so the device finds `claude`, `codex` and your VM engine the same way it does in Terminal. Logs are in **Help → Show Logs**.

## Run it from source

```bash
npm install
npm run desktop
```

## Desk buddy

After you sign in, your lead (or first) agent appears as a small ghost on the desktop. Drag it anywhere; Warren remembers its position. Use the tray's **Desk buddy** submenu to choose another agent or turn it off; the agent choice is saved for each hub.

The buddy uses your agent's appearance and live work mood. New messages, completed tasks you handed off, and approval requests appear in short, named bubbles. Bubbles hide after eight seconds unless hovered. Click one to open its conversation, or click the ghost to poke it and open Warren. Transparent space around it lets clicks through. It sleeps when the hub disconnects and respects reduced motion.

Run `npm run build` to update the hub's web UI, then `npm run desktop`. A remote hub must also serve the updated web UI. Linux uses a lightweight cursor check for click-through; always-on-top and workspace behavior depend on the window manager.

## Build the app

```bash
npm run desktop:dist          # macOS .dmg and .zip in apps/desktop/dist
npm run dist:win -w @warren/desktop
npm run dist:linux -w @warren/desktop
```

Builds are unsigned unless electron-builder finds a signing identity (`CSC_LINK` / `CSC_KEY_PASSWORD`, and `APPLE_ID` etc. for notarizing). Unsigned Mac builds open with right-click → Open the first time.

Icons are drawn from the same ghost as the web app's icon by `swift apps/ios/scripts/icons.swift`.
