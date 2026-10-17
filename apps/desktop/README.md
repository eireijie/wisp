# Warren desktop

Warren in its own window on Mac, Windows and Linux, plus the things only an app on your computer can do:

- **Create or join, the first time it opens.** **Create a server** runs Warren on this computer (it keeps going from the menu bar after you close the window; **Copy Server Address** in the menu gives others the address to join). **Join a server** asks for an address, tests it (can this computer reach it, and is it a Warren), then opens it. If `warren service install hub` already runs one, the app uses that.
- **This computer becomes a device when you sign in**, unless you untick it during setup. If `warren service install node` runs the device here, the app points that service at the new server instead.
- **This computer as a device, in one click.** Menu bar → **Connect This Computer for Agents…** adds the device for the person signed in and starts it, with no token to copy. From the same menu you can let yourself use this screen from Warren and pause agents here (the same settings as `warren node screen on|off` and `warren node pause|resume`).
- **Unread messages on the Dock icon**, desktop notifications, and a Go menu (⌘1–4) for the main pages.
- **It updates itself.** A few seconds after it starts, and every six hours, the app looks for a newer `desktop-v*` release on GitHub, downloads this computer's build in the background, checks it against the digest GitHub publishes, and installs it when you choose **Restart to Update** in the menu bar or the next time you quit. Turn it off with **Update Automatically** in the menu bar menu; **Check for Updates…** is in the Warren menu (Help on Windows and Linux). It doesn't need code signing: on a Mac it replaces the app itself (so Warren must be in a folder you can write to, like Applications, not running from the disk image), on Windows it runs the new installer silently, and the AppImage replaces itself. A .deb install updates through apt instead. Logs are in `updates.log` next to the others. To try an update locally, point a built app at your own list of releases with `WARREN_UPDATE_FEED=<url of a JSON array like GitHub's releases API>`.

A built app carries its own copy of Warren (the hub, the device, warren-mcp and the web app) and runs it with the app itself as Node, so it needs nothing else installed; the hub's data lives in `~/.warren/data`. Run from source, it uses this repo and your own Node.js 22+. It uses your login shell's PATH, so the device finds `claude`, `codex` and your VM engine the same way it does in Terminal. Logs are in **Help → Show Logs**.

## Run it from source

```bash
npm install
npm run desktop
```

## Desk buddy

After you sign in, your lead (or first) agent appears as a small ghost on the desktop. Drag it anywhere; Warren remembers its position. Use the tray's **Desk buddy** submenu to choose another agent or turn it off; the agent choice is saved for each hub.

The buddy uses your agent's appearance and live work mood. New messages, completed tasks you handed off, and approval requests appear in short, named bubbles. Bubbles hide after eight seconds unless hovered. Click one to open its conversation, or click the ghost to poke it and open Warren. Transparent space around it lets clicks through. It sleeps when the hub disconnects and respects reduced motion.

Run `npm run build` to update the hub's web UI, then `npm run desktop`. A remote hub must also serve the updated web UI. Linux uses a lightweight cursor check for click-through; always-on-top and workspace behavior depend on the window manager.

## Release it

Push a tag like `desktop-v0.2.0`. [.github/workflows/desktop-release.yml](../../.github/workflows/desktop-release.yml) builds the Mac (Apple silicon and Intel), Windows, Linux and Android apps with that version and attaches them to a GitHub release marked latest. The files keep the same names in every release (`Warren-mac-arm64.dmg`, `Warren-mac-arm64.zip`, `Warren-win-x64.exe`, `Warren-linux-x86_64.AppImage`, `Warren-linux-amd64.deb`, `Warren-android.apk`), so `https://github.com/eireijie/warren/releases/latest/download/<name>` always links the newest. Installed apps find the release and update themselves. Releases and updates only work for other people once the repository is public.

## Build the app

```bash
npm run desktop:dist          # macOS Warren-mac-arm64.dmg and .zip in apps/desktop/dist
npm run dist:win -w @warren/desktop
npm run dist:linux -w @warren/desktop
```

Each build first runs `npm run bundle -w @warren/desktop`, which builds the web app and stages Warren with its production dependencies in `build/warren-runtime` (better-sqlite3 13, whose Node-API prebuilds load in Electron). Builds are signed ad hoc (scripts/after-sign.cjs) unless electron-builder finds a signing identity (`CSC_LINK` / `CSC_KEY_PASSWORD`, and `APPLE_ID` etc. for notarizing). Unsigned Mac builds open with right-click → Open the first time.

Icons are drawn from the same ghost as the web app's icon by `swift apps/ios/scripts/icons.swift`.
