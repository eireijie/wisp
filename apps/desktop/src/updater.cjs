const { envVar } = require("./env.cjs");
// Keeping the desktop app up to date from GitHub releases, without code signing.
//
// electron-updater's Mac half (Squirrel.Mac) only installs updates signed by the same Apple
// developer as the running app, and Wisp's builds are signed ad hoc for now, so the app does it
// itself: find the newest `desktop-v*` release, download this platform's build, check it against
// the digest GitHub publishes, and swap it in when you restart (or quit) Wisp.
//
//   Mac      Wisp-mac-<arch>.zip      unzip, replace the .app, open it again
//   Windows  Wisp-win-x64.exe         run the installer silently; it opens Wisp when done
//   Linux    Wisp-linux-x86_64.AppImage  replace the AppImage you ran (download and install a newer .deb manually)
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { GITHUB_REPO } = require("./repo.cjs");
// WISP_UPDATE_FEED points a build at another list of releases (for trying an update locally)
const RELEASES = envVar("UPDATE_FEED", process.env) ?? `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
const TAG = /^desktop-v(\d+\.\d+\.\d+)$/;
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;
const INSTALL_SPAWN_MS = 5_000;

/** -1, 0 or 1, like a sort comparator, for plain x.y.z versions. */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
}

/** The release file this computer installs, or null when this kind of install can't update itself. */
function assetName(platform = process.platform, arch = process.arch, env = process.env) {
  if (platform === "darwin") return `Wisp-mac-${arch === "x64" ? "x64" : "arm64"}.zip`;
  if (platform === "win32") return "Wisp-win-x64.exe";
  if (platform === "linux" && env.APPIMAGE) return "Wisp-linux-x86_64.AppImage";
  return null;
}

/** The newest published desktop release newer than `current` that has a build for this computer. */
function pickUpdate(releases, current, name) {
  let best = null;
  for (const r of releases || []) {
    if (r.draft || r.prerelease) continue;
    const m = TAG.exec(r.tag_name || "");
    if (!m || compareVersions(m[1], current) <= 0) continue;
    const asset = (r.assets || []).find((a) => a.name === name);
    if (!asset) continue;
    if (!best || compareVersions(m[1], best.version) > 0)
      best = { version: m[1], notes: r.body || "", page: r.html_url, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null };
  }
  return best;
}

/** sha256 of a file, as GitHub writes asset digests ("sha256:<hex>"). */
function fileDigest(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(`sha256:${h.digest("hex")}`)).on("error", reject);
  });
}

/**
 * Download a release file to `dest` and check it: exactly `size` bytes, and the sha256 `digest`
 * GitHub publishes. A build without a digest isn't installed, since nothing else vouches for it.
 * Anything wrong (a write error, a short or long file, another digest) throws and removes the file.
 */
async function downloadTo(url, dest, { size, digest }, { fetchImpl = fetch, headers = {}, timeoutMs = 10 * 60_000 } = {}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest || ""))) throw new Error("the release has no checksum for this build, so it wasn't downloaded");
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  let bytes = 0;
  const out = fs.createWriteStream(dest);
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (typeof size === "number" && bytes > size) throw new Error("the download is bigger than the release says");
          yield chunk;
        }
      },
      out,
      { signal },
    );
    if (typeof size === "number" && bytes !== size) throw new Error("the download was cut short");
    if ((await fileDigest(dest)) !== digest) throw new Error("the download didn't match the release, so it was thrown away");
  } catch (e) {
    // the file may still be opening when the download fails; wait for it to close, or it comes back after the delete
    if (!out.closed) await new Promise((done) => { out.once("close", done); out.destroy(); });
    fs.rmSync(dest, { force: true });
    throw signal.aborted ? signal.reason : e;
  }
  return dest;
}

/**
 * The script that swaps a new Mac build in once Wisp (`pid`) has quit. If the new app can't be
 * moved into place, the old one goes back where it was, so Wisp is never left missing.
 */
function macScript({ pid, file, unpacked, bundle, dir, relaunch }) {
  const b = q(bundle);
  const old = q(`${bundle}.old`);
  const open = relaunch ? `/usr/bin/open ${b}` : ":";
  return [
    "#!/bin/sh",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf ${q(unpacked)} && mkdir -p ${q(unpacked)} || { ${open}; exit 1; }`,
    `/usr/bin/ditto -x -k ${q(file)} ${q(unpacked)} || { ${open}; exit 1; }`,
    `NEW=$(/usr/bin/find ${q(unpacked)} -maxdepth 1 -name '*.app' | head -n 1)`,
    `[ -n "$NEW" ] || { ${open}; exit 1; }`,
    `/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null`,
    `rm -rf ${old}`,
    `mv ${b} ${old} || { ${open}; exit 1; }`,
    `if ! mv "$NEW" ${b}; then rm -rf ${b}; mv ${old} ${b}; ${open}; exit 1; fi`,
    `rm -rf ${old} ${q(dir)}`,
    open,
    "",
  ].join("\n");
}

/** The same for an AppImage: copy next to it first, so the swap itself is one rename. */
function linuxScript({ pid, file, target, relaunch }) {
  const next = q(`${target}.new`);
  return [
    "#!/bin/sh",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    `if cp -f ${q(file)} ${next} && chmod 755 ${next} && mv -f ${next} ${q(target)}; then rm -f ${q(file)}; else rm -f ${next}; fi`,
    relaunch ? `nohup ${q(target)} >/dev/null 2>&1 &` : "",
    "",
  ].join("\n");
}

/** The .app bundle this process runs from (…/Wisp.app/Contents/MacOS/wisp). */
const macBundle = (execPath = process.execPath) => path.resolve(execPath, "..", "..", "..");

/**
 * @param {{ app: Electron.App, shell: Electron.Shell, notify: (title: string, body: string) => void, refresh: () => void, log: (line: string) => void, enabled: () => boolean }} o
 */
function createUpdater(o) {
  const { app } = o;
  const dir = path.join(app.getPath("userData"), "updates");
  /** idle | checking | current | downloading | ready | unsupported | error | timed-out */
  let state = "idle";
  let detail = "";
  let found = null; // the release being downloaded or ready
  let file = null; // the downloaded build
  let timer = null;
  let installing = false;
  let installed = false;

  const set = (s, d = "") => {
    state = s;
    detail = d;
    o.refresh();
  };

  async function check({ manual = false, quiet = false } = {}) {
    const say = (title, body) => manual && !quiet && o.notify(title, body);
    if (!app.isPackaged) {
      set("unsupported", "Updates only work in the built app. From source, use git pull.");
      say("Updates", "Updates only work in the built app. From source, use git pull.");
      return;
    }
    if (state === "checking" || state === "downloading" || installing) return;
    if (state === "ready") {
      say(`Wisp ${found.version} is ready`, "Restart Wisp to finish updating.");
      return;
    }
    const name = assetName();
    const stuck = process.platform === "darwin" && !canReplace(macBundle());
    if (stuck) {
      set("error", "move Wisp to Applications to get updates");
      say("Move Wisp to Applications", "Wisp can only update itself from your Applications folder.");
      return;
    }
    if (!name) {
      set("unsupported", "This install updates through your package manager.");
      say("Updates", "This install updates through your package manager.");
      return;
    }
    set("checking");
    try {
      const res = await fetch(RELEASES, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/vnd.github+json", "user-agent": `Wisp/${app.getVersion()}` } });
      if (!res.ok) throw new Error(res.status === 404 ? "the release page isn't public yet" : `GitHub said ${res.status}`);
      const update = pickUpdate(await res.json(), app.getVersion(), name);
      if (!update) {
        set("current");
        say("Wisp is up to date", `You have the newest version, ${app.getVersion()}.`);
        return;
      }
      found = update;
      await download(update, name);
    } catch (e) {
      o.log(`update check failed: ${e.message}`);
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      const message = timedOut ? "The update request timed out. Try checking again." : e.message;
      set(timedOut ? "timed-out" : "error", message);
      say("Couldn't check for updates", message);
    }
  }

  async function download(update, name) {
    set("downloading", update.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    await downloadTo(update.url, dest, update, { headers: { "user-agent": `Wisp/${app.getVersion()}` } });
    file = dest;
    set("ready", update.version);
    o.log(`update ${update.version} downloaded to ${dest}`);
    o.notify(`Wisp ${update.version} is ready`, "It installs when you restart or quit Wisp.");
  }

  /** Swap the new build in after this process exits; `relaunch` opens Wisp again afterwards. */
  async function install(relaunch) {
    if ((state !== "ready" && state !== "error") || !file || installing) return false;
    installing = true;
    const pid = process.pid;
    try {
      if (process.platform === "darwin") {
        await runDetached("/bin/sh", [writeScript(macScript({ pid, file, unpacked: path.join(dir, "unpacked"), bundle: macBundle(), dir, relaunch }))]);
      } else if (process.platform === "win32") {
        // electron-builder's one-click installer: /S is silent, --force-run opens Wisp when done
        await runDetached(file, relaunch ? ["/S", "--force-run"] : ["/S"]);
      } else {
        await runDetached("/bin/sh", [writeScript(linuxScript({ pid, file, target: process.env.APPIMAGE, relaunch }))]);
      }
      installed = true;
      return true;
    } catch (e) {
      installing = false;
      o.log(`update install failed: ${e.message}`);
      const message = `couldn't install the update (${e.message})`;
      set("error", message);
      o.notify("Couldn't install the update", message);
      return false;
    }
  }

  function writeScript(script) {
    const sh = path.join(os.tmpdir(), `wisp-update-${process.pid}.sh`);
    fs.writeFileSync(sh, script, { mode: 0o755 });
    return sh;
  }

  /** Start the installer on its own; if it can't start, say so instead of crashing Wisp. */
  function runDetached(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      const started = () => {
        clearTimeout(timeout);
        child.unref();
        resolve();
      };
      const timeout = setTimeout(() => {
        child.removeListener("spawn", started);
        reject(new Error("the update installer took too long to start. Try again."));
        child.kill();
      }, INSTALL_SPAWN_MS);
      child.once("spawn", started);
      child.once("error", (e) => {
        clearTimeout(timeout);
        child.removeListener("spawn", started);
        reject(e);
      });
    });
  }

  async function restart() {
    if (await install(true)) app.quit();
  }

  /** Defer quitting until the installer starts; leave Wisp running if it fails. */
  let gaveUp = false; // an install-on-quit that failed: the next quit goes ahead without the update
  function installOnQuit(event) {
    if (installed || gaveUp || !file || (state !== "ready" && state !== "error")) return false;
    event.preventDefault();
    if (!installing) void install(false).then((ok) => { if (!ok) gaveUp = true; if (ok) app.quit(); });
    return true;
  }

  const status = () => ({ state, detail, version: found?.version ?? null, current: app.getVersion() });

  return {
    start() {
      if (!app.isPackaged) return;
      const tick = () => o.enabled() && check();
      setTimeout(tick, FIRST_CHECK_MS);
      timer = setInterval(tick, EVERY_MS);
    },
    stop: () => timer && clearInterval(timer),
    check: () => check({ manual: true }),
    /** a check asked for from Wisp's own Updates page, which shows the result itself */
    checkQuietly: async () => {
      await check({ manual: true, quiet: true });
      return status();
    },
    /** restart into the new version now */
    restart,
    /** called while quitting: a downloaded update goes in quietly, without reopening Wisp */
    installOnQuit,
    status,
    /** the tray's update item(s) */
    menu() {
      if (state === "ready" || (state === "error" && file)) return [{ label: `Restart to Update to ${found.version}`, click: restart }];
      if (state === "downloading") return [{ label: `Downloading Wisp ${detail}…`, enabled: false }];
      return [{ label: state === "checking" ? "Checking for Updates…" : "Check for Updates…", enabled: state !== "checking", click: () => check({ manual: true }) }];
    },
  };
}

/** A Mac app can only replace itself where it may write (not on the disk image, not translocated). */
function canReplace(bundle) {
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Quote a path for /bin/sh. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

module.exports = { createUpdater, compareVersions, assetName, pickUpdate, macBundle, canReplace, downloadTo, macScript, linuxScript };
