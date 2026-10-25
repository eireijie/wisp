import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatRustdeskId } from "@wisp/core";
import { exec, has } from "./computers/driver.ts";
import type { SetupIO } from "./computers/remote-desktop.ts";

/**
 * RustDesk, for the person to reach this device from anywhere (an optional add-on). Wisp installs
 * it, asking first, and reads its ID for the device's page. Its password is the person's: they set
 * it in RustDesk and keep it in their password manager, and Wisp never sees it.
 */

export interface RustdeskConfig {
  id: string;
}

/** Where RustDesk's own program is once installed, by system. */
export function rustdeskBinary(platform = process.platform): string {
  if (platform === "darwin") return "/Applications/RustDesk.app/Contents/MacOS/rustdesk";
  if (platform === "win32") return path.join(process.env.ProgramFiles ?? "C:\\Program Files", "RustDesk", "rustdesk.exe");
  return "rustdesk";
}

export async function rustdeskInstalled(platform = process.platform): Promise<boolean> {
  const bin = rustdeskBinary(platform);
  return path.isAbsolute(bin) ? fs.existsSync(bin) : has(bin);
}

/** The ID from `rustdesk --get-id`'s output, or null when it hasn't got one yet. */
export function parseRustdeskId(out: string): string | null {
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{6,40}$/.test(l));
  return line ?? null;
}

/** This device's RustDesk ID, or null when RustDesk isn't running or hasn't made one yet. */
export async function rustdeskId(platform = process.platform): Promise<string | null> {
  const r = await exec(rustdeskBinary(platform), ["--get-id"], { timeoutMs: 10_000 }).catch(() => null);
  return r && r.code === 0 ? parseRustdeskId(r.stdout.toString("utf8")) : null;
}

export type InstallPlan = { kind: "run"; cmd: string; args: string[]; label: string } | { kind: "deb"; arch: string } | { kind: "manual"; why: string };

/** How to install RustDesk here: Homebrew on a Mac, winget on Windows, its .deb on Debian and Ubuntu. */
export function installPlan(platform: string, arch: string, have: { brew: boolean; winget: boolean; apt: boolean }): InstallPlan {
  if (platform === "darwin") return have.brew ? { kind: "run", cmd: "brew", args: ["install", "--cask", "rustdesk"], label: "Homebrew" } : { kind: "manual", why: "Install Homebrew (brew.sh) or get RustDesk from rustdesk.com" };
  if (platform === "win32") return have.winget ? { kind: "run", cmd: "winget", args: ["install", "--id", "RustDesk.RustDesk", "--exact"], label: "winget" } : { kind: "manual", why: 'Install "App Installer" from the Microsoft Store, or get RustDesk from rustdesk.com' };
  const debArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (have.apt && debArch) return { kind: "deb", arch: debArch };
  return { kind: "manual", why: "Get RustDesk for this Linux from rustdesk.com" };
}

/** The newest RustDesk .deb for this architecture, from RustDesk's GitHub releases. */
async function latestDeb(arch: string): Promise<{ name: string; url: string } | null> {
  const r = await fetch("https://api.github.com/repos/rustdesk/rustdesk/releases/latest", { headers: { accept: "application/vnd.github+json" } }).catch(() => null);
  if (!r?.ok) return null;
  const release = (await r.json()) as { assets?: { name: string; browser_download_url: string }[] };
  const asset = release.assets?.find((a) => a.name.endsWith(`-${arch}.deb`) && !a.name.includes("sciter"));
  return asset ? { name: asset.name, url: asset.browser_download_url } : null;
}

/** Start RustDesk's app in the background, so it makes its ID and the person can set its password. */
function openRustdesk(platform = process.platform) {
  const [cmd, args] = platform === "darwin" ? ["open", ["-a", "RustDesk"]] : [rustdeskBinary(platform), [] as string[]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

/**
 * Install RustDesk if it isn't here (asking first), open it, and read its ID. Returns its config, or
 * null when it couldn't be set up (the reason was said).
 */
export async function setUpRustdesk(dir: string, io: SetupIO): Promise<RustdeskConfig | null> {
  if (!(await rustdeskInstalled())) {
    const plan = installPlan(process.platform, process.arch, { brew: await has("brew"), winget: await has("winget"), apt: await has("apt-get") });
    if (plan.kind === "manual") {
      io.say(`   ${plan.why}, then run \`wisp node rustdesk\` again.`);
      return null;
    }
    io.say("   RustDesk is free, open-source remote desktop. You'll use it to reach this computer from anywhere.");
    if (plan.kind === "run") {
      if (!(await io.ask(`   Install it now with ${plan.label}?`))) return null;
      if (!io.run(plan.cmd, plan.args)) {
        io.say("   The install didn't finish. Run `wisp node rustdesk` to try again.");
        return null;
      }
    } else {
      const deb = await latestDeb(plan.arch);
      if (!deb) {
        io.say("   Couldn't find RustDesk's latest release. Get it from rustdesk.com, then run `wisp node rustdesk` again.");
        return null;
      }
      const sudo = process.getuid?.() === 0 ? [] : ["sudo"];
      if (!(await io.ask(`   Download ${deb.name} from RustDesk's GitHub releases and install it${sudo.length ? " (sudo asks for your password)" : ""}?`))) return null;
      const file = path.join(dir, deb.name);
      fs.mkdirSync(dir, { recursive: true });
      const r = await fetch(deb.url).catch(() => null);
      if (!r?.ok) {
        io.say("   The download didn't finish. Run `wisp node rustdesk` to try again.");
        return null;
      }
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      const ok = sudo.length ? io.run("sudo", ["apt-get", "install", "-y", file]) : io.run("apt-get", ["install", "-y", file]);
      fs.rmSync(file, { force: true });
      if (!ok) {
        io.say("   RustDesk didn't install. Run `wisp node rustdesk` to try again.");
        return null;
      }
    }
    if (!(await rustdeskInstalled())) {
      io.say("   RustDesk still isn't where Wisp expects it. Open it once, then run `wisp node rustdesk` again.");
      return null;
    }
  }

  openRustdesk();
  let id: string | null = null;
  for (let i = 0; i < 15 && !id; i++) {
    id = await rustdeskId();
    if (!id) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!id) {
    io.say("   RustDesk is installed but hasn't shown an ID yet. Open RustDesk, then run `wisp node rustdesk` again.");
    return null;
  }
  io.say(`   This computer's RustDesk ID is ${formatRustdeskId(id)}. It shows on this device's page in Wisp, for you only.`);
  io.say("   Now give it a password: in RustDesk, open Settings → Security, unlock it, choose \"Use permanent password\", and save that password in your password manager. Wisp never sees it.");
  if (process.platform === "darwin") io.say("   On a Mac, RustDesk also asks for Screen Recording and Accessibility in System Settings → Privacy & Security. Allow both.");
  return { id };
}
