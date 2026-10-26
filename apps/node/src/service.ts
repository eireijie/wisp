import { migrateServices } from "./migrate-services.ts";
import { envVar } from "@wisp/core";
// `wisp service`: keep the hub or this device running with the system's own service manager:
// a LaunchAgent on macOS, systemd on Linux, and a task at sign-in on Windows (not a Windows
// service, which runs outside the desktop session, so agents couldn't use the screen).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@wisp/update";

export type ServiceKind = "hub" | "node";

interface Spec {
  kind: ServiceKind;
  /** launchd label, systemd unit name, or scheduled task name */
  name: string;
  args: string[];
  env: Record<string, string>;
  log: string;
}

const isRoot = () => process.getuid?.() === 0;

export function spec(kind: ServiceKind, dir: string): Spec {
  const script = path.join(REPO_ROOT, "bin", kind === "hub" ? "wisp-hub.mjs" : "wisp.mjs");
  // service managers start programs with a minimal PATH, so keep this terminal's: the device needs
  // it to find `claude`, `codex` and the VM engine
  // WISP_SERVICE tells `wisp node start` it's the service itself, not a second copy started by hand
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", WISP_SERVICE: "1" };
  if (kind === "hub") for (const k of ["WISP_DATA_DIR", "PORT", "HOST", "WISP_WEB_DIR"])  { const value = k.startsWith("WISP_") ? envVar(k.slice(5)) : process.env[k]; if (value !== undefined) env[k] = value; }
  if (kind === "node" && dir !== path.join(os.homedir(), ".wisp")) env.WISP_NODE_DIR = dir;
  const name = process.platform === "darwin" ? `ai.wisp.${kind}` : process.platform === "win32" ? `Wisp ${kind}` : kind === "hub" ? "wisp" : "wisp-node";
  return { kind, name, args: [process.execPath, script, ...(kind === "node" ? ["node", "start"] : [])], env, log: path.join(dir, `${kind}.log`) };
}

const run = (cmd: string, args: string[], quiet = false) => execFileSync(cmd, args, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
const attempt = (cmd: string, args: string[]) => {
  try {
    run(cmd, args, true);
    return true;
  } catch {
    return false;
  }
};
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

function launchdPlist(s: Spec) {
  const env = Object.entries(s.env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${s.name}</string>
  <key>ProgramArguments</key><array>${s.args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key><dict>${env}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(s.log)}</string>
  <key>StandardErrorPath</key><string>${xml(s.log)}</string>
</dict></plist>
`;
}

export function systemdUnit(s: Spec, system: boolean) {
  const q = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : a);
  return `[Unit]
Description=Wisp ${s.kind === "hub" ? "hub" : "device"}
After=network-online.target
Wants=network-online.target

[Service]
${system ? `User=${process.env.SUDO_USER || os.userInfo().username}\n` : ""}WorkingDirectory=${REPO_ROOT}
${Object.entries(s.env)
  .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
  .join("\n")}
ExecStart=${s.args.map(q).join(" ")}
${system ? "" : `StandardOutput=append:${s.log}\nStandardError=append:${s.log}\n`}Restart=always
RestartSec=3

[Install]
WantedBy=${system ? "multi-user.target" : "default.target"}
`;
}

/** Where the service definition lives, and how to control it. */
function linux(s: Spec) {
  const system = isRoot();
  const file = system ? `/etc/systemd/system/${s.name}.service` : path.join(os.homedir(), ".config/systemd/user", `${s.name}.service`);
  const ctl = (...args: string[]) => (system ? args : ["--user", ...args]);
  return { system, file, ctl };
}

export function installService(kind: ServiceKind, dir: string): Spec {
  const migrated = migrateServices({ home: os.homedir(), kinds: [kind], log: console.log });
  const s = spec(kind, dir);
  if (migrated.length) return s;
  fs.mkdirSync(path.dirname(s.log), { recursive: true });
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library/LaunchAgents", `${s.name}.plist`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const domain = `gui/${process.getuid!()}`;
    attempt("launchctl", ["bootout", `${domain}/${s.name}`]);
    if (!fs.existsSync(file)) fs.writeFileSync(file, launchdPlist(s));
    // bootout returns before launchd lets go of the old job; bootstrapping too soon fails with
    // "5: Input/output error", so give it a few seconds before reporting the failure
    for (let tries = 1; ; tries++) {
      try {
        run("launchctl", ["bootstrap", domain, file], true);
        break;
      } catch (e) {
        if (tries === 10) throw e;
        execFileSync("sleep", ["0.5"]);
      }
    }
  } else if (process.platform === "linux") {
    if (!attempt("systemctl", ["--version"])) throw new Error("This system doesn't use systemd. Run it in a terminal instead, or with your own service manager.");
    const { system, file, ctl } = linux(s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, systemdUnit(s, system));
    run("systemctl", ctl("daemon-reload"));
    run("systemctl", ctl("enable", s.name));
    run("systemctl", ctl("restart", s.name));
    // a user service stops when you log out unless lingering is on
    if (!system && !attempt("loginctl", ["enable-linger", os.userInfo().username]))
      console.log(`To keep it running after you log out: sudo loginctl enable-linger ${os.userInfo().username}`);
  } else if (process.platform === "win32") {
    if (attempt("powershell.exe", ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'; Get-ScheduledTask -TaskName ${ps(s.name)} | Out-Null`])) {
      run("powershell.exe", ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName ${ps(s.name)}`]);
      return s;
    }
    const [exe, ...rest] = s.args;
    const env = Object.entries(s.env)
      .filter(([k]) => k !== "PATH")
      .map(([k, v]) => `$env:${k}=${ps(v)}; `)
      .join("");
    const command = `${env}& ${[exe, ...rest].map(ps).join(" ")} *>> ${ps(s.log)}`;
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `Unregister-ScheduledTask -TaskName ${ps(s.name)} -Confirm:$false -ErrorAction SilentlyContinue`,
      `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory ${ps(REPO_ROOT)} -Argument ${ps(`-NoProfile -WindowStyle Hidden -Command ${command}`)}`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
      `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
      `Register-ScheduledTask -TaskName ${ps(s.name)} -Action $action -Trigger $trigger -Settings $settings | Out-Null`,
      `Start-ScheduledTask -TaskName ${ps(s.name)}`,
    ].join("; ");
    run("powershell.exe", ["-NoProfile", "-Command", script]);
  } else {
    throw new Error(`Starting Wisp automatically isn't supported on ${process.platform}. Run it in a terminal instead.`);
  }
  return s;
}

export function uninstallService(kind: ServiceKind, dir: string) {
  migrateServices({ home: os.homedir(), kinds: [kind], removeOnly: true, log: console.log });
  const s = spec(kind, dir);
  if (process.platform === "darwin") {
    attempt("launchctl", ["bootout", `gui/${process.getuid!()}/${s.name}`]);
    fs.rmSync(path.join(os.homedir(), "Library/LaunchAgents", `${s.name}.plist`), { force: true });
  } else if (process.platform === "linux") {
    const { file, ctl } = linux(s);
    attempt("systemctl", ctl("disable", "--now", s.name));
    fs.rmSync(file, { force: true });
    attempt("systemctl", ctl("daemon-reload"));
  } else if (process.platform === "win32") {
    attempt("powershell.exe", ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName ${ps(s.name)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(s.name)} -Confirm:$false`]);
  }
  return s;
}

/**
 * Whether this process is the service itself (or the keeper's child it runs), not a second copy
 * started by hand. Services installed before WISP_SERVICE existed don't set it, so this also
 * matches the service's own process id, and on macOS the job label launchd hands its jobs.
 */
export function isService(status: { name: string; pid?: number }): boolean {
  if (envVar("SERVICE")) return true;
  if (status.pid && (status.pid === process.pid || status.pid === process.ppid)) return true;
  return process.platform === "darwin" && process.env.XPC_SERVICE_NAME === status.name;
}

/** Parse only the listen port; status never exposes a service's token/environment. */
export function servicePortFromDefinition(text: string): number | undefined {
  const value = text.match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/)?.[1]
    ?? text.match(/\bEnvironment=["']?PORT=(\d+)\b/)?.[1]
    ?? text.match(/\$env:PORT\s*=\s*(?:'|"|&quot;|&apos;)?(\d+)\b/i)?.[1];
  const port = Number(value);
  return port > 0 && port <= 65535 ? port : undefined;
}

export function servicePort(kind: ServiceKind, dir: string): number {
  const s = spec(kind, dir);
  try {
    const definition = process.platform === "darwin" ? fs.readFileSync(path.join(os.homedir(), "Library/LaunchAgents", `${s.name}.plist`), "utf8")
      : process.platform === "linux" ? fs.readFileSync(linux(s).file, "utf8")
      : process.platform === "win32" ? run("powershell.exe", ["-NoProfile", "-Command", `Export-ScheduledTask -TaskName ${ps(s.name)}`], true) : "";
    return servicePortFromDefinition(definition) ?? Number(process.env.PORT ?? 4747);
  } catch { return Number(process.env.PORT ?? 4747); }
}

export function serviceStatus(kind: ServiceKind, dir: string): { installed: boolean; running: boolean; name: string; log: string; pid?: number } {
  const s = spec(kind, dir);
  const legacy = process.platform === "darwin" ? `ai.warren.${kind}` : process.platform === "win32" ? `Warren ${kind}` : kind === "hub" ? "warren" : "warren-node";
  if (process.platform === "darwin") {
    const folder = path.join(os.homedir(), "Library/LaunchAgents");
    if (!fs.existsSync(path.join(folder, `${s.name}.plist`)) && fs.existsSync(path.join(folder, `${legacy}.plist`))) s.name = legacy;
  } else if (process.platform === "linux") {
    const { file } = linux(s);
    if (!fs.existsSync(file) && fs.existsSync(path.join(path.dirname(file), `${legacy}.service`))) s.name = legacy;
  }
  const base = { name: s.name, log: s.log };
  if (process.platform === "darwin") {
    const installed = fs.existsSync(path.join(os.homedir(), "Library/LaunchAgents", `${s.name}.plist`));
    let running = false;
    let pid: number | undefined;
    try {
      const out = run("launchctl", ["print", `gui/${process.getuid!()}/${s.name}`], true);
      running = /state = running/.test(out);
      pid = Number(out.match(/^\s*pid = (\d+)/m)?.[1]) || undefined;
    } catch {}
    return { ...base, installed, running, pid };
  }
  if (process.platform === "linux") {
    const { file, ctl } = linux(s);
    let pid: number | undefined;
    try {
      pid = Number(run("systemctl", ctl("show", "--property", "MainPID", "--value", s.name), true).trim()) || undefined;
    } catch {}
    return { ...base, installed: fs.existsSync(file), running: attempt("systemctl", ctl("is-active", "--quiet", s.name)), pid };
  }
  if (process.platform === "win32") {
    let state = "";
    try {
      state = run("powershell.exe", ["-NoProfile", "-Command", `(Get-ScheduledTask -TaskName ${ps(s.name)}).State`], true).trim();
    } catch {}
    if (!state) { try { state = run("powershell.exe", ["-NoProfile", "-Command", `(Get-ScheduledTask -TaskName ${ps(legacy)}).State`], true).trim(); if (state) base.name = legacy; } catch {} }
    return { ...base, installed: !!state, running: state === "Running" };
  }
  return { ...base, installed: false, running: false };
}
