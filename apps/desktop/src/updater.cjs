// Keeping the desktop app up to date from GitHub releases, without code signing.
//
// electron-updater's Mac half (Squirrel.Mac) only installs updates signed by the same Apple
// developer as the running app, and Warren's builds are signed ad hoc for now, so the app does it
// itself: find the newest `desktop-v*` release, download this platform's build, check it against
// the digest GitHub publishes, and swap it in when you restart (or quit) Warren.
//
//   Mac      Warren-mac-<arch>.zip      unzip, replace the .app, open it again
//   Windows  Warren-win-x64.exe         run the installer silently; it opens Warren when done
//   Linux    Warren-linux-x86_64.AppImage  replace the AppImage you ran (a .deb install updates through apt)
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = "eireijie/warren";
// WARREN_UPDATE_FEED points a build at another list of releases (for trying an update locally)
const RELEASES = process.env.WARREN_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const TAG = /^desktop-v(\d+\.\d+\.\d+)$/;
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;

/** -1, 0 or 1, like a sort comparator, for plain x.y.z versions. */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
}

/** The release file this computer installs, or null when this kind of install can't update itself. */
function assetName(platform = process.platform, arch = process.arch, env = process.env) {
  if (platform === "darwin") return `Warren-mac-${arch === "x64" ? "x64" : "arm64"}.zip`;
  if (platform === "win32") return "Warren-win-x64.exe";
  if (platform === "linux" && env.APPIMAGE) return "Warren-linux-x86_64.AppImage";
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

/** The .app bundle this process runs from (…/Warren.app/Contents/MacOS/Warren). */
const macBundle = (execPath = process.execPath) => path.resolve(execPath, "..", "..", "..");

/**
 * @param {{ app: Electron.App, shell: Electron.Shell, notify: (title: string, body: string) => void, refresh: () => void, log: (line: string) => void, enabled: () => boolean }} o
 */
function createUpdater(o) {
  const { app } = o;
  const dir = path.join(app.getPath("userData"), "updates");
  /** idle | checking | downloading | ready | error */
  let state = "idle";
  let detail = "";
  let found = null; // the release being downloaded or ready
  let file = null; // the downloaded build
  let timer = null;
  let installing = false;

  const set = (s, d = "") => {
    state = s;
    detail = d;
    o.refresh();
  };

  async function check({ manual = false } = {}) {
    if (!app.isPackaged) {
      if (manual) o.notify("Updates", "Updates only work in the built app. From source, use git pull.");
      return;
    }
    if (state === "checking" || state === "downloading") return;
    if (state === "ready") {
      if (manual) o.notify(`Warren ${found.version} is ready`, "Restart Warren to finish updating.");
      return;
    }
    const name = assetName();
    const stuck = process.platform === "darwin" && !canReplace(macBundle());
    if (stuck) {
      set("error", "move Warren to Applications to get updates");
      if (manual) o.notify("Move Warren to Applications", "Warren can only update itself from your Applications folder.");
      return;
    }
    if (!name) {
      if (manual) o.notify("Updates", "This install updates through your package manager.");
      return;
    }
    set("checking");
    try {
      const res = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": `Warren/${app.getVersion()}` } });
      if (!res.ok) throw new Error(res.status === 404 ? "the release page isn't public yet" : `GitHub said ${res.status}`);
      const update = pickUpdate(await res.json(), app.getVersion(), name);
      if (!update) {
        set("idle");
        if (manual) o.notify("Warren is up to date", `You have the newest version, ${app.getVersion()}.`);
        return;
      }
      found = update;
      await download(update, name);
    } catch (e) {
      o.log(`update check failed: ${e.message}`);
      set("error", e.message);
      if (manual) o.notify("Couldn't check for updates", e.message);
    }
  }

  async function download(update, name) {
    set("downloading", update.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    const res = await fetch(update.url, { headers: { "user-agent": `Warren/${app.getVersion()}` } });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const out = fs.createWriteStream(dest);
    for await (const chunk of res.body) if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (update.digest) {
      const got = await fileDigest(dest);
      if (got !== update.digest) {
        fs.rmSync(dest, { force: true });
        throw new Error("the download didn't match the release, so it was thrown away");
      }
    }
    file = dest;
    set("ready", update.version);
    o.log(`update ${update.version} downloaded to ${dest}`);
    o.notify(`Warren ${update.version} is ready`, "It installs when you restart or quit Warren.");
  }

  /** Swap the new build in after this process exits; `relaunch` opens Warren again afterwards. */
  function install(relaunch) {
    if (state !== "ready" || !file || installing) return false;
    installing = true;
    const pid = process.pid;
    try {
      if (process.platform === "darwin") {
        const bundle = macBundle();
        const unpacked = path.join(dir, "unpacked");
        const script = [
          "#!/bin/sh",
          `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
          `rm -rf ${q(unpacked)} && mkdir -p ${q(unpacked)}`,
          `/usr/bin/ditto -x -k ${q(file)} ${q(unpacked)} || exit 1`,
          `NEW=$(/usr/bin/find ${q(unpacked)} -maxdepth 1 -name '*.app' | head -n 1)`,
          `[ -n "$NEW" ] || exit 1`,
          `/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null`,
          `rm -rf ${q(bundle)}.old && mv ${q(bundle)} ${q(bundle)}.old && mv "$NEW" ${q(bundle)} && rm -rf ${q(bundle)}.old ${q(dir)}`,
          relaunch ? `/usr/bin/open ${q(bundle)}` : "",
        ].join("\n");
        runDetached(script);
      } else if (process.platform === "win32") {
        // electron-builder's one-click installer: /S is silent, --force-run opens Warren when done
        spawn(file, relaunch ? ["/S", "--force-run"] : ["/S"], { detached: true, stdio: "ignore" }).unref();
      } else {
        const target = process.env.APPIMAGE;
        const script = [
          "#!/bin/sh",
          `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
          `chmod 755 ${q(file)} && mv -f ${q(file)} ${q(target)}`,
          relaunch ? `nohup ${q(target)} >/dev/null 2>&1 &` : "",
        ].join("\n");
        runDetached(script);
      }
      return true;
    } catch (e) {
      installing = false;
      o.log(`update install failed: ${e.message}`);
      set("error", e.message);
      return false;
    }
  }

  function runDetached(script) {
    const sh = path.join(os.tmpdir(), `warren-update-${process.pid}.sh`);
    fs.writeFileSync(sh, script, { mode: 0o755 });
    spawn("/bin/sh", [sh], { detached: true, stdio: "ignore" }).unref();
  }

  function restart() {
    if (install(true)) app.quit();
  }

  return {
    start() {
      if (!app.isPackaged) return;
      const tick = () => o.enabled() && check();
      setTimeout(tick, FIRST_CHECK_MS);
      timer = setInterval(tick, EVERY_MS);
    },
    stop: () => timer && clearInterval(timer),
    check: () => check({ manual: true }),
    /** restart into the new version now */
    restart,
    /** called while quitting: a downloaded update goes in quietly, without reopening Warren */
    installOnQuit: () => install(false),
    status: () => ({ state, detail, version: found?.version ?? null }),
    /** the tray's update item(s) */
    menu() {
      if (state === "ready") return [{ label: `Restart to Update to ${found.version}`, click: restart }];
      if (state === "downloading") return [{ label: `Downloading Warren ${detail}…`, enabled: false }];
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

module.exports = { createUpdater, compareVersions, assetName, pickUpdate, macBundle, canReplace };
