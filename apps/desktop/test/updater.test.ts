import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const updater = createRequire(import.meta.url)("../src/updater.cjs");

const release = (tag: string, assets: string[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/eireijie/warren/releases/tag/${tag}`,
  body: `notes for ${tag}`,
  assets: assets.map((name) => ({ name, browser_download_url: `https://example.com/${tag}/${name}`, size: 100, digest: `sha256:${tag}` })),
  ...extra,
});

describe("desktop updates", () => {
  it("compares versions by number, not text", () => {
    expect(updater.compareVersions("0.0.10", "0.0.9")).toBe(1);
    expect(updater.compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(updater.compareVersions("0.9.9", "1.0.0")).toBe(-1);
  });

  it("downloads the build for this computer", () => {
    expect(updater.assetName("darwin", "arm64", {})).toBe("Warren-mac-arm64.zip");
    expect(updater.assetName("darwin", "x64", {})).toBe("Warren-mac-x64.zip");
    expect(updater.assetName("win32", "x64", {})).toBe("Warren-win-x64.exe");
    expect(updater.assetName("linux", "x64", { APPIMAGE: "/home/me/Warren.AppImage" })).toBe("Warren-linux-x86_64.AppImage");
    // a .deb install updates through the package manager
    expect(updater.assetName("linux", "x64", {})).toBeNull();
  });

  it("picks the newest desktop release that has this computer's build, skipping hub tags, drafts and pre-releases", () => {
    const releases = [
      release("v0.9.0", ["Warren-mac-arm64.zip"]),
      release("desktop-v0.3.0", ["Warren-mac-arm64.zip"], { prerelease: true }),
      release("desktop-v0.2.5", ["Warren-mac-arm64.zip"], { draft: true }),
      release("desktop-v0.2.0", ["Warren-win-x64.exe"]),
      release("desktop-v0.1.2", ["Warren-mac-arm64.zip", "Warren-win-x64.exe"]),
      release("desktop-v0.1.10", ["Warren-mac-arm64.zip"]),
    ];
    expect(updater.pickUpdate(releases, "0.0.1", "Warren-mac-arm64.zip")).toMatchObject({
      version: "0.1.10",
      url: "https://example.com/desktop-v0.1.10/Warren-mac-arm64.zip",
      digest: "sha256:desktop-v0.1.10",
    });
    expect(updater.pickUpdate(releases, "0.0.1", "Warren-win-x64.exe")?.version).toBe("0.2.0");
    expect(updater.pickUpdate(releases, "0.1.10", "Warren-mac-arm64.zip")).toBeNull();
  });

  it("only replaces a Mac app it can write to", () => {
    expect(updater.macBundle("/Applications/Warren.app/Contents/MacOS/Warren")).toBe("/Applications/Warren.app");
    expect(updater.canReplace("/Volumes/Warren/Warren.app")).toBe(false);
    expect(updater.canReplace("/private/var/folders/x/AppTranslocation/ABC/d/Warren.app")).toBe(false);
  });
});
