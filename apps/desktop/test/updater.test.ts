import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
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

describe("downloading an update", () => {
  const body = Buffer.from("a new Warren build");
  const digest = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
  const serve = (bytes: Buffer) => async () => new Response(bytes);
  const dest = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "warren-update-")), "Warren.zip");

  it("keeps a build that matches the release's size and checksum", async () => {
    const file = dest();
    await updater.downloadTo("https://x/Warren.zip", file, { size: body.length, digest }, { fetchImpl: serve(body) });
    expect(fs.readFileSync(file)).toEqual(body);
  });

  it("won't download a build the release has no checksum for", async () => {
    let fetched = false;
    const err = await updater.downloadTo("https://x/Warren.zip", dest(), { size: body.length, digest: null }, { fetchImpl: async () => ((fetched = true), new Response(body)) }).catch((e: Error) => e);
    expect(err.message).toMatch(/no checksum/);
    expect(fetched).toBe(false);
  });

  it("throws away a build of the wrong size or checksum", async () => {
    for (const [got, size, sum] of [[body.subarray(0, 5), body.length, digest], [Buffer.concat([body, body]), body.length, digest], [body, body.length, `sha256:${"0".repeat(64)}`]] as const) {
      const file = dest();
      await expect(updater.downloadTo("https://x/Warren.zip", file, { size, digest: sum }, { fetchImpl: serve(got) })).rejects.toThrow();
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it("fails cleanly when the file can't be written", async () => {
    const file = path.join(os.tmpdir(), "warren-no-such-dir", String(Date.now()), "Warren.zip");
    await expect(updater.downloadTo("https://x/Warren.zip", file, { size: body.length, digest }, { fetchImpl: serve(body) })).rejects.toThrow(/ENOENT/);
  });
});

describe("installing an update on a Mac", () => {
  /** Run the swap script against a pretend Warren.app; `zip` is the downloaded build. */
  const run = (zip: (dir: string) => string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warren-swap-"));
    const bundle = path.join(root, "Applications", "Warren.app");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, "version"), "old");
    const dir = path.join(root, "updates");
    fs.mkdirSync(dir);
    const script = updater.macScript({ pid: 999999, file: zip(dir), unpacked: path.join(dir, "unpacked"), bundle, dir, relaunch: false });
    const sh = path.join(root, "swap.sh");
    fs.writeFileSync(sh, script);
    let ok = true;
    try {
      execFileSync("/bin/sh", [sh], { stdio: "ignore" });
    } catch {
      ok = false;
    }
    return { ok, version: fs.readFileSync(path.join(bundle, "version"), "utf8"), leftovers: fs.readdirSync(path.dirname(bundle)) };
  };

  it.runIf(process.platform === "darwin")("replaces the app with the new one", () => {
    const r = run((dir) => {
      const src = path.join(dir, "src", "Warren.app");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "version"), "new");
      const zip = path.join(dir, "Warren.zip");
      execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", src, zip]);
      fs.rmSync(path.join(dir, "src"), { recursive: true });
      return zip;
    });
    expect(r).toEqual({ ok: true, version: "new", leftovers: ["Warren.app"] });
  });

  it.runIf(process.platform === "darwin")("leaves the old app in place when the download isn't a good build", () => {
    const r = run((dir) => {
      const zip = path.join(dir, "Warren.zip");
      fs.writeFileSync(zip, "not a zip");
      return zip;
    });
    expect(r).toEqual({ ok: false, version: "old", leftovers: ["Warren.app"] });
  });

  it("puts the old app back if the new one can't be moved in", () => {
    const script = updater.macScript({ pid: 1, file: "/u/W.zip", unpacked: "/u/unpacked", bundle: "/Applications/Warren.app", dir: "/u", relaunch: true });
    expect(script).toContain(`if ! mv "$NEW" '/Applications/Warren.app'; then rm -rf '/Applications/Warren.app'; mv '/Applications/Warren.app.old' '/Applications/Warren.app'; /usr/bin/open '/Applications/Warren.app'; exit 1; fi`);
  });
});
