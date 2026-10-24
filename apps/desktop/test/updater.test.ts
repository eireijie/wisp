import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const updater = createRequire(import.meta.url)("../src/updater.cjs");
const { GITHUB_URL } = createRequire(import.meta.url)("../src/repo.cjs");

const release = (tag: string, assets: string[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `${GITHUB_URL}/releases/tag/${tag}`,
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

describe("starting the update installer", () => {
  async function fixture(platform = "win32") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warren-installer-"));
    const children: (EventEmitter & { unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> })[] = [];
    const spawn = vi.fn((_cmd: string, _args: string[], _options: object) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() });
      children.push(child);
      return child;
    });
    const body = Buffer.from("a new Warren build");
    const name = updater.assetName(platform, process.arch, { APPIMAGE: "/Warren.AppImage" });
    const update = release("desktop-v0.0.2", [name]);
    Object.assign(update.assets[0], { size: body.length, digest: `sha256:${crypto.createHash("sha256").update(body).digest("hex")}` });
    const fetch = vi.fn(async (url: string) => url.includes("api.github.com") ? new Response(JSON.stringify([update])) : new Response(body));
    const app = { isPackaged: true, getPath: () => root, getVersion: () => "0.0.1", quit: vi.fn() };
    const log = vi.fn();
    const notify = vi.fn();
    const filename = fileURLToPath(new URL("../src/updater.cjs", import.meta.url));
    const require = createRequire(filename);
    const module = { exports: {} as typeof updater };
    runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, fetch, AbortSignal,
      process: { ...process, platform, execPath: path.join(root, "Warren.app", "Contents", "MacOS", "Warren"), env: { APPIMAGE: "/Warren.AppImage" } },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
      require: (name: string) => name === "node:child_process" ? { spawn } : name === "node:os" ? { tmpdir: () => root } : require(name),
    });
    const u = module.exports.createUpdater({ app, refresh: vi.fn(), log, notify });
    try {
      await u.check();
      expect(u.status().state).toBe("ready");
    } catch (e) {
      fs.rmSync(root, { recursive: true, force: true });
      throw e;
    }
    const file = path.join(root, "updates", name);
    return { u, app, log, notify, children, spawn, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it.each(["win32", "darwin", "linux"])("waits for spawn before quitting on %s", async (platform) => {
    const f = await fixture(platform);
    try {
      const restart = f.u.restart();
      expect(f.spawn.mock.calls[0][2]).toEqual({ detached: true, stdio: "ignore" });
      expect(f.app.quit).not.toHaveBeenCalled();
      expect(f.children[0].unref).not.toHaveBeenCalled();
      // Repeated restart/quit requests must not launch another installer or quit early.
      await f.u.restart();
      const event = { preventDefault: vi.fn() };
      expect(f.u.installOnQuit(event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(f.spawn).toHaveBeenCalledOnce();
      f.children[0].emit("spawn");
      await restart;
      expect(f.children[0].unref).toHaveBeenCalledOnce();
      expect(f.app.quit).toHaveBeenCalledOnce();
      expect(f.u.installOnQuit({ preventDefault: vi.fn() })).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["ENOENT", "EACCES"])("keeps the download and reports an asynchronous %s failure so restart can be retried", async (code) => {
    const f = await fixture();
    try {
      const restart = f.u.restart();
      f.children[0].emit("error", new Error(code));
      await restart;
      expect(f.app.quit).not.toHaveBeenCalled();
      expect(f.u.status()).toMatchObject({ state: "error", detail: expect.stringContaining(code), version: "0.0.2" });
      expect(f.log).toHaveBeenLastCalledWith(expect.stringContaining(code));
      expect(f.notify).toHaveBeenLastCalledWith("Couldn't install the update", expect.stringContaining(code));
      expect(fs.existsSync(f.file)).toBe(true);
      const retry = f.u.menu()[0].click();
      f.children[1].emit("spawn");
      await retry;
      expect(f.app.quit).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });

  it("keeps Warren open and the download retryable when the spawn deadline expires", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    try {
      const restart = f.u.restart();
      await vi.advanceTimersByTimeAsync(5_000);
      await restart;
      expect(f.app.quit).not.toHaveBeenCalled();
      expect(f.u.status()).toMatchObject({ state: "error", detail: expect.stringContaining("too long to start") });
      expect(f.notify).toHaveBeenLastCalledWith("Couldn't install the update", expect.stringContaining("Try again"));
      expect(fs.existsSync(f.file)).toBe(true);
      expect(f.children[0].kill).toHaveBeenCalledOnce();
      f.children[0].emit("spawn");
      f.children[0].emit("error", new Error("late error"));
      expect(f.app.quit).not.toHaveBeenCalled();
      const retry = f.u.restart();
      f.children[1].emit("spawn");
      await retry;
      expect(f.app.quit).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); f.cleanup(); }
  });

  it.each(["spawn", "error"])("defers normal quitting until the installer emits %s", async (eventName) => {
    const f = await fixture();
    try {
      const event = { preventDefault: vi.fn() };
      expect(f.u.installOnQuit(event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(f.app.quit).not.toHaveBeenCalled();
      f.children[0].emit(eventName, new Error("EACCES"));
      // Let the install and quit continuations finish.
      await Promise.resolve();
      await Promise.resolve();
      if (eventName === "spawn") {
        expect(f.app.quit).toHaveBeenCalledOnce();
        expect(f.u.installOnQuit({ preventDefault: vi.fn() })).toBe(false);
      } else {
        expect(f.app.quit).not.toHaveBeenCalled();
        expect(f.u.status()).toMatchObject({ state: "error", detail: expect.stringContaining("EACCES") });
        // the next quit must go ahead without the update, not trap the person in the app
        expect(f.u.installOnQuit({ preventDefault: vi.fn() })).toBe(false);
      }
    } finally { f.cleanup(); }
  });
});


describe("update request deadlines", () => {
  it("aborts and removes a download whose body stalls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warren-update-timeout-"));
    const file = path.join(root, "Warren.zip");
    try {
      await expect(updater.downloadTo("https://hub/build", file, { digest: `sha256:${"0".repeat(64)}` }, {
        timeoutMs: 10, fetchImpl: async (_url: string, init: RequestInit) => {
          expect(init.signal).toBeInstanceOf(AbortSignal);
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
        },
      })).rejects.toMatchObject({ name: "TimeoutError" });
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves update checks retryable after a deadline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warren-updater-"));
    const fetch = vi.fn(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("deadline"), { name: "TimeoutError" });
    });
    vi.stubGlobal("fetch", fetch);
    // on Linux the updater only runs for AppImage builds, so CI needs to look like one
    vi.stubEnv("APPIMAGE", "/Warren.AppImage");
    try {
      const app = { isPackaged: true, getPath: () => root, getVersion: () => "0.0.1" };
      const u = updater.createUpdater({ app, refresh: vi.fn(), log: vi.fn(), notify: vi.fn() });
      await u.check();
      expect(u.status()).toMatchObject({ state: "timed-out", detail: expect.stringContaining("Try checking again") });
      expect(u.menu()[0].enabled).toBe(true);
      await u.check();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
