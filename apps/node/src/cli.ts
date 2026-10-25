#!/usr/bin/env -S npx tsx
import { envVar } from "@wisp/core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HARNESSES } from "@wisp/core";
import { deviceAdapters } from "@wisp/adapters";
import { ComputerHost, detectEngine } from "./computers/index.ts";
import { ensureImage } from "./computers/docker.ts";
import { listening, remoteDesktopSupport, setUpRemoteDesktop } from "./computers/remote-desktop.ts";
import { REMOTE_APPS, formatRustdeskId } from "@wisp/core";
import { detectRemoteApps } from "./remote-apps.ts";
import { rustdeskId, rustdeskInstalled, setUpRustdesk } from "./rustdesk.ts";
import { codeProblem, hashCode, type CodeKind } from "./screen-lock.ts";
import { discoverAgents } from "./discover.ts";
import { installService, isService, serviceStatus, servicePort, uninstallService, type ServiceKind } from "./service.ts";
import { NodeDaemon, normalizeHubUrl, type NodeConfig } from "./daemon.ts";
import { REPO_ROOT, RESTART_CODE, checkForUpdate, runUpdate, underKeeper, version, watchForUpdates } from "@wisp/update";

import { migrateHome } from "./migrate-home.ts";
import { migrateServices } from "./migrate-services.ts";

const HELP = `wisp — run a Wisp hub, or connect this device to one

Usage:
  wisp hub start
      Run the hub (the workspace and web app) in this terminal, on PORT (default 4747) with
      its data in WISP_DATA_DIR (default ~/.wisp/data).
  wisp service install hub
  wisp service install node [--hub URL --token TOKEN | --local] [--name NAME]
      Keep the hub or this device running, started at login (macOS LaunchAgent, systemd on
      Linux, a task at sign-in on Windows). Uses this terminal's PATH so agents' CLIs are found.
      --local makes this computer a device of the hub running on it, once its first account
      exists: no token needed (the installer does this).
  wisp service uninstall hub|node
  wisp service status
  wisp setup [--yes]
      Get this device ready to give agents their own computers (VMs): checks the harnesses,
      offers to install a VM engine (Apple's container on a Mac with Apple silicon), and gets
      the VM image so the first VM starts in seconds. Asks before installing anything.
  wisp node start [--hub URL --token TOKEN] [--name NAME] [--dir DIR] [--allow-full-access]
      Connect this device as a node. Hub URL and token are saved to DIR/node.json,
      so later runs only need \`wisp node start\`. Create the token in Wisp → Devices.
      --allow-full-access lets agents set to "Full access" run without a sandbox here (saved).
  wisp node screen on|off
      Let the person who connected this device see and use its own screen from Wisp, and
      let agents that run on this device use it. Off by default; it can only be turned on here. Turning it
      on asks for a code (a 6-digit PIN or a password) that's needed to open the screen from
      Wisp, and offers Remote Desktop.
  wisp node screen code [off]
      Pick a new code for this screen (or remove it). Only here, never from Wisp.
  wisp node screen remote [off]
      Set up Remote Desktop: a VNC server for this screen that only listens on this device, for
      smooth live view (Linux with X11, and Windows). \`off\` goes back to screenshots.
  wisp node rustdesk [off]
      Set up RustDesk, to reach this computer from anywhere (the Remote desktop mod):
      installs it (asking first) and shows its ID on this device's page, for you only.
      You set its password in RustDesk; Wisp never sees it. \`off\` hides the ID again.
  wisp node pause | wisp node resume
      Stop everything Wisp does on this device right away (agent runs, computer use, live
      views) until you resume. Works while \`wisp node start\` is running.
  wisp migrate [--json]
      Migrate an existing Warren home and services to Wisp. Safe to repeat.
  wisp doctor
      Check which agent harnesses are installed here, whether agents can use this
      device's screen or run VMs on it, and which existing agents Wisp can import.
  wisp update [--check]
      Get the latest Wisp from GitHub: pull, install what changed, rebuild the web app
      on a hub, then restart the hub and device running from this folder (a device waits
      for its agents to finish). --check only shows what's new.

Settings in DIR/node.json (all optional):
  "harnesses": { "qwen": { "args": ["--experimental-acp"] },
                 "acp:my-bot": { "label": "My bot", "command": "my-bot", "args": ["acp"] } }
      Change how an ACP harness starts here, or add your own ACP agent.
  "vmEngine": "podman"     use Podman instead of Docker for VMs
  "shareScreen": true      what \`wisp node screen on\` sets
  "noScreen": true         never offer this device's own screen, even if shareScreen is on
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: "string" },
    token: { type: "string" },
    name: { type: "string" },
    dir: { type: "string" },
    "allow-full-access": { type: "boolean" },
    local: { type: "boolean" },
    check: { type: "boolean" },
    json: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    help: { type: "boolean", short: "h" },
  },
});

const migrationLines: string[] = [];
const migration = migrateHome({ home: os.homedir(), log: (line) => migrationLines.push(line) });
if (!values.json) for (const line of migrationLines) console.log(line);
const dir = path.resolve(values.dir ?? envVar("NODE_DIR") ?? migration.dir);
const configFile = path.join(dir, "node.json");
/** `node start` exits with this once the hub turns its token down, when $WISP_EXIT_IF_REJECTED asks it to (the desktop app does) */
const REJECTED_CODE = 78;
const [cmd, sub] = positionals;

if (values.help || !cmd) {
  console.log(HELP);
} else if (cmd === "migrate") {
  const services = migrateServices({ home: os.homedir(), log: (line) => migrationLines.push(line) });
  if (values.json) console.log(JSON.stringify({ home: migration, services, messages: migrationLines }));
  else console.log(services.length ? migrationLines.slice(migration.moved ? 1 : 0).join("\n") : "No old services to migrate.");
} else if (cmd === "doctor") {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  console.log("Harnesses");
  for (const a of Object.values(deviceAdapters(saved.harnesses))) {
    let version = "not found";
    try {
      // through the shell on Windows, where npm installs harnesses as .cmd shims
      version = execFileSync(a.binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, shell: process.platform === "win32" }).trim().split("\n")[0];
    } catch {}
    const how = HARNESSES.find((h) => h.id === a.id)?.protocol === "native" ? "" : " (ACP)";
    console.log(`  ${(a.label + how).padEnd(20)} ${a.binary.padEnd(14)} ${version}`);
  }
  const caps = await new ComputerHost({ dir, vmEngine: saved.vmEngine }).capabilities();
  console.log("\nComputers");
  const shared = saved.shareScreen && !saved.noScreen;
  console.log(`  This screen  ${!caps.screen.ok ? "no" : shared ? "on (only you and agents that run here can use it)" : "off (turn on with `wisp node screen on`)"}: ${caps.screen.detail}`);
  if (caps.screen.ok && shared) {
    console.log(`               ${saved.screenCode ? `opened with a ${saved.screenCode.kind === "pin" ? "PIN" : "password"}` : "no code: your Wisp sign-in alone opens it (`wisp node screen code`)"}`);
    const rd = remoteDesktopSupport();
    console.log(`               Remote Desktop ${saved.remoteDesktop ? `on (${saved.remoteDesktop.server}${(await listening(saved.remoteDesktop.port)) ? "" : ", not answering right now"})` : rd.ok ? "off (`wisp node screen remote`)" : `unavailable: ${rd.detail}`}`);
  }
  console.log(`  VMs          ${caps.vm.ok ? "yes" : "no"}: ${caps.vm.detail}`);
  const others = await detectRemoteApps();
  if (others.length) console.log(`  Also here    ${others.map((a) => REMOTE_APPS[a].label).join(", ")} (pick it under Remote desktop on this device's page)`);
  console.log(`  RustDesk     ${saved.rustdesk ? `on, ID ${formatRustdeskId(saved.rustdesk.id)}` : (await rustdeskInstalled()) ? "installed, not shown in Wisp (`wisp node rustdesk`)" : "not set up (`wisp node rustdesk`)"}`);
  const found = discoverAgents();
  console.log("\nExisting agents Wisp can import");
  if (!found.length) console.log("  none found");
  for (const a of found) console.log(`  ${a.name} (${a.harness}) ${a.path}`);
} else if (cmd === "setup") {
  await setup(values.yes ?? false);
} else if (cmd === "service") {
  await service(sub, positionals[2]);
} else if (cmd === "node" && sub === "start") {
  migrateServices({ home: os.homedir(), log: console.log });
  let cfg = saveNodeConfig();
  const kept = underKeeper();
  // two daemons with one token would take turns replacing each other on the hub
  const service = envVar("SERVICE") ? null : serviceStatus("node", dir);
  if (service?.running && !isService(service)) {
    console.error(`This device is already connected by its service (${service.name}), so there's nothing to start. To run it in this terminal instead: wisp service uninstall node`);
    process.exit(1);
  }
  if (cfg.local && !cfg.token) cfg = await waitForLocalHub(cfg);
  const daemon = new NodeDaemon(cfg);
  // the desktop app asks for this, so it can add this computer again instead of leaving a dead device running
  if (envVar("EXIT_IF_REJECTED")) daemon.onRejected = () => process.exit(REJECTED_CODE);
  daemon.start();
  watchForUpdates(async () => {
    if (!kept) return console.log("[wisp] Wisp was updated; restart `wisp node start` to use the new version");
    console.log("[wisp] Wisp was updated; restarting once no agent is running");
    await daemon.idle();
    await daemon.stop();
    process.exit(RESTART_CODE);
  });
  // runs in flight get a moment to tell the hub they were stopped, so nothing stays "busy" forever
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      if (stopping) process.exit(0);
      stopping = true;
      void daemon.stop().finally(() => process.exit(0));
    });
} else if (cmd === "node" && sub === "screen") {
  await screen(positionals[2], positionals[3]);
} else if (cmd === "node" && sub === "rustdesk") {
  await rustdesk(positionals[2]);
} else if (cmd === "node" && (sub === "pause" || sub === "resume")) {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  saved.paused = sub === "pause";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(saved.paused ? "Paused. Wisp stops agents and computers on this device within a second or two. `wisp node resume` to continue." : "Resumed.");
} else if (cmd === "update") {
  const v = await version();
  console.log(`Wisp ${v.commit ?? "(not a git checkout)"}${v.date ? ` from ${v.date.slice(0, 10)}` : ""}`);
  const check = await checkForUpdate();
  for (const c of check.changes.slice(0, 20)) console.log(`  ${c}`);
  if (check.changes.length > 20) console.log(`  …and ${check.changes.length - 20} more`);
  console.log(check.reason);
  if (values.check || !check.canUpdate) process.exit(check.canUpdate || check.behind === 0 ? 0 : 1);
  try {
    const r = await runUpdate(undefined, { log: (line) => console.log(line) });
    console.log(`Wisp ${r.from} → ${r.to}. A hub or device running from this folder restarts in a few seconds (a device waits for running agents).`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.log(HELP);
  process.exit(1);
}

/** A yes/no question in the terminal; no terminal means no. */
async function ask(q: string, yes = false): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === "" || a === "y" || a === "yes";
}

/** Read a line without showing what's typed. */
async function askHidden(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  let prompted = false;
  out._writeToOutput = (str: string) => {
    if (!prompted) {
      out.output.write(str);
      prompted = true;
    } else if (str.includes("\n") || str.includes("\r")) out.output.write("\n");
  };
  const a = await rl.question(q);
  rl.close();
  return a;
}

/** Pick the screen's code at the terminal: a 6-digit PIN or a password, typed twice. */
async function pickCode(): Promise<NonNullable<NodeConfig["screenCode"]> | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = (await rl.question("   A 6-digit PIN or a password (8+ characters)? [pin/password] ")).trim().toLowerCase();
  rl.close();
  const kind: CodeKind = choice.startsWith("pass") ? "password" : "pin";
  const label = kind === "pin" ? "PIN" : "password";
  for (let i = 0; i < 3; i++) {
    const code = await askHidden(`   New ${label}: `);
    const problem = codeProblem(kind, code);
    if (problem) {
      console.log(`   ${problem}`);
      continue;
    }
    if ((await askHidden(`   Type it again: `)) !== code) {
      console.log("   Those didn't match.");
      continue;
    }
    return hashCode(kind, code);
  }
  return null;
}

/** `wisp node screen on|off|code|remote`: everything about this device's own screen, decided here. */
async function screen(what: string | undefined, arg: string | undefined) {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
  };
  const on = !!saved.shareScreen && !saved.noScreen;
  const setUpRemote = async () => {
    const rd = await setUpRemoteDesktop(dir, { ask: (q) => ask(q), run, say: (l) => console.log(l) });
    if (!rd) return false;
    saved.remoteDesktop = rd;
    return true;
  };

  if (what === "off") {
    saved.shareScreen = false;
    save();
    return console.log("This screen is off. Nobody in Wisp can see or use it.");
  }

  if (what === "on") {
    saved.shareScreen = true;
    delete saved.noScreen;
    save();
    console.log("This screen is on. In Wisp, only the person who connected this device can see or use it, and agents only if they run on this device.");
    if (!saved.screenCode) {
      console.log("\nPick a code. Opening this screen from Wisp will need it, so someone who gets into your Wisp account still can't see this computer.");
      const code = await pickCode();
      if (code) {
        saved.screenCode = code;
        save();
        console.log(`   Done. You'll enter this ${code.kind === "pin" ? "PIN" : "password"} in Wisp to watch this screen.`);
      } else console.log("   No code set, so your Wisp sign-in alone opens this screen. Pick one any time: wisp node screen code");
    }
    if (!saved.remoteDesktop && remoteDesktopSupport().ok) {
      console.log("");
      if (await ask("Turn on Remote Desktop? Live view is much smoother, and it only listens on this computer.")) {
        if (await setUpRemote()) {
          save();
          console.log("   Remote Desktop is on.");
        }
      } else console.log("   Live view uses screenshots. Turn Remote Desktop on any time: wisp node screen remote");
    }
    return;
  }

  if (what === "code") {
    if (arg === "off") {
      delete saved.screenCode;
      save();
      return console.log("This screen has no code now: your Wisp sign-in alone opens it.");
    }
    const code = await pickCode();
    if (!code) {
      console.log(process.stdin.isTTY ? "The code didn't change." : "Run this in a terminal to pick a code.");
      process.exit(1);
    }
    saved.screenCode = code;
    save();
    return console.log("New code saved. Anything the old one opened is closed now.");
  }

  if (what === "remote") {
    if (arg === "off") {
      delete saved.remoteDesktop;
      save();
      return console.log("Remote Desktop is off for Wisp; live view uses screenshots. (The VNC server stays installed; Wisp doesn't run or use it.)");
    }
    if (!(await setUpRemote())) process.exit(1);
    save();
    return console.log(on ? "Remote Desktop is on." : "Remote Desktop is set up. Turn the screen on to use it: wisp node screen on");
  }

  console.log(`This screen is ${on ? "on" : "off"}${saved.screenCode ? `, opened with a ${saved.screenCode.kind === "pin" ? "PIN" : "password"}` : ", with no code"}${saved.remoteDesktop ? ", with Remote Desktop" : ""}.`);
  console.log("Use `wisp node screen on|off`, `wisp node screen code`, or `wisp node screen remote`.");
  process.exit(what ? 1 : 0);
}

/** `wisp node rustdesk [off]`: set RustDesk up here and show its ID in Wisp, or stop showing it. */
async function rustdesk(what: string | undefined) {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
  };
  if (what === "off") {
    delete saved.rustdesk;
    save();
    return console.log("Wisp doesn't show this computer's RustDesk ID anymore. RustDesk itself stays installed and works as before.");
  }
  if (what) {
    console.log("Use `wisp node rustdesk` or `wisp node rustdesk off`.");
    process.exit(1);
  }
  // already set up: just make sure the ID is current
  const known = saved.rustdesk && (await rustdeskInstalled()) ? await rustdeskId() : null;
  const r = known ? { id: known } : await setUpRustdesk(dir, { ask: (q) => ask(q), run, say: (l) => console.log(l) });
  if (!r) process.exit(1);
  saved.rustdesk = r;
  save();
  console.log(known ? `RustDesk is set up. This computer's ID is ${formatRustdeskId(r.id)}.` : "RustDesk is set up. Its ID is on this device's page in Wisp (turn on the Remote desktop mod to see it).");
}

/** Run a command with the terminal attached, showing it first. */
function run(cmd: string, args: string[]): boolean {
  console.log(`  $ ${[cmd, ...args].join(" ")}`);
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

/** Merges --hub, --token, --name and --allow-full-access into DIR/node.json; exits if hub or token is missing. */
function saveNodeConfig(): NodeConfig {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const cfg: NodeConfig = {
    ...saved,
    hub: values.hub ?? envVar("HUB") ?? saved.hub ?? "",
    token: values.token ?? envVar("NODE_TOKEN") ?? saved.token ?? "",
    // "Mac.fios-router.home" → "Mac": the network's domain isn't part of the computer's name
    name: values.name ?? saved.name ?? (os.hostname().split(".")[0] || os.hostname()),
    allowFullAccess: values["allow-full-access"] ?? saved.allowFullAccess ?? false,
    dir,
  };
  // --local: the hub on this computer hands over the connection once its first account exists
  if (!cfg.token && (values.local || saved.local)) {
    const { dir: _d, ...keep } = { ...cfg, local: true };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(keep, null, 2), { mode: 0o600 });
    return { ...cfg, local: true };
  }
  if (!cfg.hub || !cfg.token) {
    console.error("Missing --hub and --token. Get them in Wisp → Devices → Add device.");
    process.exit(1);
  }
  try {
    cfg.hub = normalizeHubUrl(cfg.hub);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const { dir: _dir, ...keep } = cfg;
  fs.writeFileSync(configFile, JSON.stringify(keep, null, 2), { mode: 0o600 });
  return cfg;
}

/** Where the hub on this computer keeps its data (the same default as the hub itself). */
function hubDataDir(): string {
  return path.resolve(envVar("DATA_DIR") ?? envVar("DEFAULT_DATA_DIR") ?? path.join(migration.dir, "data"));
}

/**
 * `--local`: ask the hub on this computer to make it a device, then wait (as long as it takes,
 * since the first account is made in the browser) for it to hand over the connection.
 */
async function waitForLocalHub(cfg: NodeConfig): Promise<NodeConfig> {
  const data = hubDataDir();
  const grant = path.join(data, "local-device.json");
  const request = path.join(data, "local-device.request");
  if (!fs.existsSync(grant)) {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(request, JSON.stringify({ name: values.name ?? cfg.name }), { mode: 0o600 });
    console.log("[wisp] waiting for the hub on this computer: this computer becomes a device once you've made your account in the browser");
  }
  while (!fs.existsSync(grant)) await new Promise((r) => setTimeout(r, 2000));
  const got = JSON.parse(fs.readFileSync(grant, "utf8")) as { hub: string; token: string; name: string };
  const next: NodeConfig = { ...cfg, hub: got.hub, token: got.token, name: got.name, local: false };
  const { dir: _d, ...keep } = next;
  fs.writeFileSync(configFile, JSON.stringify(keep, null, 2), { mode: 0o600 });
  // the token now lives only in this device's own settings
  fs.rmSync(grant, { force: true });
  return next;
}

/** `wisp service`: start the hub or this device at login and keep it running. */
async function service(action: string | undefined, kind: string | undefined) {
  const kinds: ServiceKind[] = ["hub", "node"];
  if (action === "status") {
    const states = [];
    for (const k of kind ? [kind as ServiceKind] : kinds) {
      const s = serviceStatus(k, dir);
      states.push({ kind: k, ...s, ...(k === "hub" ? { port: servicePort(k, dir) } : {}) });
      if (!values.json) console.log(`${k.padEnd(5)} ${s.running ? "running" : s.installed ? "installed, not running" : "not installed"}${s.installed ? ` (${s.name}, log: ${s.log})` : ""}`);
    }
    if (values.json) console.log(JSON.stringify(states));
    return;
  }
  if ((action !== "install" && action !== "uninstall") || !kinds.includes(kind as ServiceKind)) {
    console.log("Usage: wisp service install|uninstall hub|node, or wisp service status");
    process.exit(1);
  }
  const k = kind as ServiceKind;
  if (action === "uninstall") {
    const s = uninstallService(k, dir);
    console.log(`Removed ${s.name}. Wisp's data and settings are untouched.`);
    return;
  }
  const cfg = k === "node" ? saveNodeConfig() : undefined;
  if (cfg?.local && !cfg.token) {
    // a fresh request even if one is there, so the hub answers this install
    const data = hubDataDir();
    fs.mkdirSync(data, { recursive: true });
    if (!fs.existsSync(path.join(data, "local-device.json"))) fs.writeFileSync(path.join(data, "local-device.request"), JSON.stringify({ name: cfg.name }), { mode: 0o600 });
  }
  const log = path.join(dir, `${k}.log`);
  const from = fs.existsSync(log) ? fs.statSync(log).size : 0;
  let s;
  try {
    s = installService(k, dir);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  console.log(`Installed ${s.name}: it starts at login and restarts if it stops. Log: ${s.log}`);
  // wait for it to come up, so problems show here instead of in a log nobody reads
  const deadline = Date.now() + 30_000;
  const port = servicePort(k, dir);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (k === "hub") {
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (ok) return console.log(`The hub is up at http://localhost:${port}`);
    } else if (cfg?.local && !cfg.token) {
      return console.log("This computer becomes a device as soon as you've made your account in the browser.");
    } else if (fs.existsSync(s.log)) {
      const recent = fs.readFileSync(s.log, "utf8").slice(from).split("\n").slice(-50).join("\n");
      if (recent.includes(`connected to ${cfg!.hub} as`)) return console.log(`Connected to ${cfg!.hub} as "${cfg!.name}".`);
    }
  }
  console.log(`It hasn't ${k === "hub" ? "answered yet" : "connected yet"}. Check ${s.log}${process.platform === "linux" ? ` or journalctl ${process.getuid?.() === 0 ? "" : "--user "}-u ${s.name}` : ""}.`);
}

/** `wisp setup`: harnesses, a VM engine, and the VM image, so agents get their own computers here. */
async function setup(yes: boolean) {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const askHere = (q: string) => ask(q, yes);
  const which = (bin: string) => {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  console.log("1. Harnesses");
  const found = Object.values(deviceAdapters(saved.harnesses)).filter((a) => which(a.binary));
  console.log(found.length ? `   ${found.map((a) => a.label).join(", ")}` : "   none yet. Agents can still run inside their VMs (Claude Code, Codex, Hermes and Kimi CLI come with it).");

  console.log("\n2. Something to run VMs");
  let { engine, detail } = await detectEngine(saved.vmEngine);
  if (!engine && process.platform === "darwin") {
    if (which("container")) {
      if (await askHere("   Apple's container is installed but not running. Start it now?")) run("container", ["system", "start", "--enable-kernel-install"]);
    } else if (process.arch === "arm64" && which("brew")) {
      console.log("   Apple's container runs each VM in its own small virtual machine. It's free and open source, from Apple.");
      if (await askHere("   Install it with Homebrew now?")) {
        if (run("brew", ["install", "container"])) run("container", ["system", "start", "--enable-kernel-install"]);
      }
    } else if (process.arch === "arm64") {
      console.log("   Install Apple's container from https://github.com/apple/container/releases (the .pkg), then run `wisp setup` again.");
    } else {
      console.log("   On an Intel Mac, install OrbStack (https://orbstack.dev) or Docker Desktop, then run `wisp setup` again.");
    }
    ({ engine, detail } = await detectEngine(saved.vmEngine));
  } else if (!engine && process.platform === "linux") {
    console.log("   Install Docker Engine or Podman, for example:");
    console.log("     curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # then log out and in");
    console.log("     sudo apt-get install -y podman                                             # or this");
  } else if (!engine && process.platform === "win32") {
    console.log("   Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then run `wisp setup` again.");
  }
  console.log(`   ${detail}`);
  if (!engine) {
    console.log("\nAgents can still use an Orgo cloud computer (Settings → Computers in Wisp) until this device can run VMs.");
    process.exit(1);
  }

  console.log("\n3. The VM image");
  let last = "";
  const image = await ensureImage(engine, (text) => {
    if (text !== last) console.log(`   ${(last = text)}`);
  });
  console.log(`   ready: ${image}`);

  console.log("\nThis device is ready to give agents their own computers.");
  console.log(saved.hub ? "If `wisp node start` is running, Wisp sees it within a few seconds." : "Next: connect it to your hub with the command from Wisp → Devices → Add device.");
}
