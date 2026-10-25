import fs from "node:fs";
import path from "node:path";
import type { RemoteApp } from "@wisp/core";
import { has } from "./computers/driver.ts";
import { listening } from "./computers/remote-desktop.ts";

/**
 * Remote desktop apps already on this device, so its page can suggest the one the person uses:
 * installed apps by where they live, and a VNC or Remote Desktop server by its port answering here.
 */

/** Where each app is installed, by system. */
export function appPaths(platform: string, env: Record<string, string | undefined> = process.env): Partial<Record<RemoteApp, string[]>> {
  if (platform === "darwin") {
    return {
      teamviewer: ["/Applications/TeamViewer.app", "/Applications/TeamViewerHost.app"],
      anydesk: ["/Applications/AnyDesk.app"],
      chrome: ["/Library/PrivilegedHelperTools/org.chromium.chromoting.me2me_host.app"],
    };
  }
  if (platform === "win32") {
    const pf = env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return {
      teamviewer: [path.win32.join(pf, "TeamViewer"), path.win32.join(pf86, "TeamViewer")],
      anydesk: [path.win32.join(pf86, "AnyDesk"), path.win32.join(pf, "AnyDesk")],
      chrome: [path.win32.join(pf86, "Google", "Chrome Remote Desktop"), path.win32.join(pf, "Google", "Chrome Remote Desktop")],
    };
  }
  return { teamviewer: ["/opt/teamviewer"], anydesk: ["/usr/bin/anydesk"], chrome: ["/opt/google/chrome-remote-desktop"] };
}

export async function detectRemoteApps(platform = process.platform): Promise<RemoteApp[]> {
  const found: RemoteApp[] = [];
  for (const [app, paths] of Object.entries(appPaths(platform)) as [RemoteApp, string[]][]) {
    if (paths.some((p) => fs.existsSync(p))) found.push(app);
  }
  // on Linux, a packaged app may only be on PATH
  if (platform === "linux") {
    if (!found.includes("teamviewer") && (await has("teamviewer"))) found.push("teamviewer");
    if (!found.includes("anydesk") && (await has("anydesk"))) found.push("anydesk");
  }
  if (await listening(5900, 500)) found.push(platform === "darwin" ? "screen-sharing" : "vnc");
  if (platform === "win32" && (await listening(3389, 500))) found.push("rdp");
  return found;
}
