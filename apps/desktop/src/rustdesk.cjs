// RustDesk, recommended during setup when agents will use this computer: free, open-source remote
// desktop (AGPL-3.0, installed as its own unchanged app), so the person can watch or take over
// this screen from their phone. Same idea as `wisp node rustdesk`: Wisp installs it, reads its ID
// into node.json (the device reports it to the hub), and never sees its password.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const run = (cmd, args, timeout = 10 * 60_000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), err })));

function binary(platform = process.platform) {
  if (platform === "darwin") return "/Applications/RustDesk.app/Contents/MacOS/rustdesk";
  if (platform === "win32") return path.join(process.env.ProgramFiles ?? "C:\\Program Files", "RustDesk", "rustdesk.exe");
  return "/usr/bin/rustdesk";
}

const installed = (platform = process.platform) => fs.existsSync(binary(platform));

/** The ID from `rustdesk --get-id`, or null before it has one. */
function parseId(out) {
  return out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{6,40}$/.test(l)) ?? null;
}

const brew = () => ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((b) => fs.existsSync(b));

/** RustDesk's newest release asset whose name matches, from its GitHub releases. */
async function latestAsset(match, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl("https://api.github.com/repos/rustdesk/rustdesk/releases/latest", { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r?.ok) return null;
  const release = await r.json();
  return release.assets?.find((a) => match.test(a.name) && !a.name.includes("sciter")) ?? null;
}

async function download(asset, dir) {
  const r = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
  if (!r?.ok) return null;
  const file = path.join(dir, asset.name);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/**
 * Install RustDesk for this system: Homebrew or its .dmg on a Mac, winget or its installer on
 * Windows. Linux needs the person's package manager, so it says where to get it instead.
 * Returns { ok } or { ok: false, error, url }.
 */
async function install({ platform = process.platform, arch = process.arch } = {}) {
  if (installed(platform)) return { ok: true };
  const manual = { ok: false, url: "https://rustdesk.com/download" };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-rustdesk-"));
  try {
    if (platform === "darwin") {
      const b = brew();
      if (b && (await run(b, ["install", "--cask", "rustdesk"])).ok && installed(platform)) return { ok: true };
      const asset = await latestAsset(new RegExp(`-${arch === "arm64" ? "aarch64" : "x86_64"}\\.dmg$`));
      const file = asset && (await download(asset, tmp));
      if (!file) return { ...manual, error: "Couldn't download RustDesk. Check your internet connection, or get it from rustdesk.com." };
      const mount = path.join(tmp, "mnt");
      if (!(await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, file])).ok) return { ...manual, error: "Couldn't open RustDesk's installer. Get it from rustdesk.com instead." };
      const copied = await run("ditto", [path.join(mount, "RustDesk.app"), "/Applications/RustDesk.app"]);
      await run("hdiutil", ["detach", mount, "-quiet"]);
      if (!copied.ok) return { ...manual, error: "Couldn't put RustDesk in Applications. Get it from rustdesk.com instead." };
      return { ok: installed(platform) };
    }
    if (platform === "win32") {
      if ((await run("winget", ["install", "--id", "RustDesk.RustDesk", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"])).ok && installed(platform)) return { ok: true };
      const asset = await latestAsset(/-x86_64\.exe$/);
      const file = asset && (await download(asset, tmp));
      if (!file) return { ...manual, error: "Couldn't download RustDesk. Check your internet connection, or get it from rustdesk.com." };
      await run(file, ["--silent-install"]);
      for (let i = 0; i < 30 && !installed(platform); i++) await new Promise((r) => setTimeout(r, 1000));
      return installed(platform) ? { ok: true } : { ...manual, error: "RustDesk's installer didn't finish. Get it from rustdesk.com instead." };
    }
    return { ...manual, error: "Install RustDesk from rustdesk.com, then press Check again." };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Open RustDesk so it makes its ID, and read it (waiting up to `ms`). */
async function startAndReadId({ platform = process.platform, ms = 20_000 } = {}) {
  const [cmd, args] = platform === "darwin" ? ["open", ["-g", "-a", "RustDesk"]] : [binary(platform), []];
  try { spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch {}
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
    const r = await run(binary(platform), ["--get-id"], 10_000);
    const id = r.ok ? parseId(r.stdout) : null;
    if (id) return id;
  }
  return null;
}

module.exports = { installed, install, startAndReadId, parseId, binary };
