// Which pages the app trusts: the hub it opened (by exact origin, so hub.example.evil.test isn't
// hub.example) and its own setup page (that one file, not any file: page).
const { pathToFileURL } = require("node:url");

/** Whether `url` is on `origin` exactly. */
function onOrigin(url, origin) {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Whether `url` is the setup page at `file`, whatever its query or hash. */
function isPage(url, file) {
  try {
    const u = new URL(url);
    if (u.protocol !== "file:") return false;
    u.search = "";
    u.hash = "";
    return u.href === pathToFileURL(file).href;
  } catch {
    return false;
  }
}

/** The URL of the IPC sender when it's `win`'s main frame (not an iframe, not another window), else null. */
function mainFrameUrl(e, win) {
  if (!win || win.isDestroyed?.() || e.sender !== win.webContents) return null;
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return null;
  return frame.url || null;
}

/** A device page's "Open" for a remote desktop app (RustDesk, AnyDesk, TeamViewer, Remote Desktop, VNC): opens that app here. */
function isRemoteDesktopLink(url) {
  return /^(rustdesk:\/\/|anydesk:)[A-Za-z0-9@._-]+$|^teamviewer10:\/\/control\?device=\d+$|^rdp:\/\/full%20address=s:[A-Za-z0-9.-]+(:\d+)?$|^vnc:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url);
}

/** The vault's "Open in Obsidian": opens the Obsidian app here on that folder or note. */
function isObsidianLink(url) {
  return /^obsidian:\/\/open\?path=[A-Za-z0-9%._~!*'()-]+$/.test(url);
}

module.exports = { onOrigin, isPage, mainFrameUrl, isRemoteDesktopLink, isObsidianLink };
