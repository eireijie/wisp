import { GITHUB_URL } from "@wisp/core";
/**
 * Where to download the Wisp app. Release file names never change between versions
 * (.github/workflows/desktop-release.yml), so "latest/download/<name>" is always the newest build.
 * Keep in step with site/src/lib/site.ts.
 */
const latest = (file: string) => `${GITHUB_URL}/releases/latest/download/${file}`;

export const RELEASES = `${GITHUB_URL}/releases/latest`;

export const DOWNLOADS = {
  macArm: latest("Wisp-mac-arm64.dmg"),
  macIntel: latest("Wisp-mac-x64.dmg"),
  windows: latest("Wisp-win-x64.exe"),
  linuxAppImage: latest("Wisp-linux-x86_64.AppImage"),
  linuxDeb: latest("Wisp-linux-amd64.deb"),
  android: latest("Wisp-android.apk"),
};

export type DesktopOs = "mac" | "windows" | "linux" | "other";

export function desktopOs(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): DesktopOs {
  if (/iPhone|iPad|Android/i.test(ua)) return "other";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "other";
}

/** The main download for this computer, and any others worth offering next to it. */
export function downloadsFor(os: DesktopOs): { label: string; href: string; more: { label: string; href: string }[] } {
  switch (os) {
    case "mac":
      return { label: "Download for Mac", href: DOWNLOADS.macArm, more: [{ label: "Intel Mac", href: DOWNLOADS.macIntel }] };
    case "windows":
      return { label: "Download for Windows", href: DOWNLOADS.windows, more: [] };
    case "linux":
      return { label: "Download for Linux", href: DOWNLOADS.linuxAppImage, more: [{ label: ".deb", href: DOWNLOADS.linuxDeb }] };
    default:
      return { label: "Download Wisp", href: RELEASES, more: [] };
  }
}
