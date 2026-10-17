#!/usr/bin/env -S npx tsx
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HARNESSES } from "@warren/core";
import { deviceAdapters } from "@warren/adapters";
import { ComputerHost, detectEngine } from "./computers/index.ts";
import { ensureImage } from "./computers/docker.ts";
import { discoverAgents } from "./discover.ts";
import { installService, serviceStatus, uninstallService, type ServiceKind } from "./service.ts";
import { NodeDaemon, normalizeHubUrl, type NodeConfig } from "./daemon.ts";
import { RESTART_CODE, checkForUpdate, runUpdate, underKeeper, version, watchForUpdates } from "@warren/update";

const HELP = `warren — run a Warren hub, or connect this device to one

Usage:
  warren hub start
      Run the hub (the workspace and web app) in this terminal, on PORT (default 4747) with
      its data in WARREN_DATA_DIR (default ./data in the Warren folder).
  warren service install hub
  warren service install node [--hub URL --token TOKEN] [--name NAME]
      Keep the hub or this device running, started at login (macOS LaunchAgent, systemd on
      Linux, a task at sign-in on Windows). Uses this terminal's PATH so agents' CLIs are found.
  warren service uninstall hub|node
  warren service status
  warren setup [--yes]
      Get this device ready to give agents their own computers (VMs): checks the harnesses,
      offers to install a VM engine (Apple's container on a Mac with Apple silicon), and gets
      the VM image so the first VM starts in seconds. Asks before installing anything.
  warren node start [--hub URL --token TOKEN] [--name NAME] [--dir DIR] [--allow-full-access]
      Connect this device as a node. Hub URL and token are saved to DIR/node.json,
      so later runs only need \`warren node start\`. Create the token in Warren → Devices.
      --allow-full-access lets agents set to "Full access" run without a sandbox here (saved).
  warren node screen on|off
      Let the person who connected this device see and use its own screen from Warren, and
      lend it to agents for a while. Off by default; it can only be turned on here.
  warren node pause | warren node resume
      Stop everything Warren does on this device right away (agent runs, computer use, live
      views) until you resume. Works while \`warren node start\` is running.
  warren doctor
      Check which agent harnesses are installed here, whether agents can use this
      device's screen or run VMs on it, and which existing agents Warren can import.
  warren update [--check]
      Get the latest Warren from GitHub: pull, install what changed, rebuild the web app
      on a hub, then restart the hub and device running from this folder (a device waits
      for its agents to finish). --check only shows what's new.

Settings in DIR/node.json (all optional):
  "harnesses": { "qwen": { "args": ["--experimental-acp"] },
                 "acp:my-bot": { "label": "My bot", "command": "my-bot", "args": ["acp"] } }
      Change how an ACP harness starts here, or add your own ACP agent.
  "vmEngine": "podman"     use Podman instead of Docker for VMs
  "shareScreen": true      what \`warren node screen on\` sets
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
    check: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    help: { type: "boolean", short: "h" },
  },
});

const dir = path.resolve(values.dir ?? process.env.WARREN_NODE_DIR ?? path.join(os.homedir(), ".warren"));
const configFile = path.join(dir, "node.json");
const [cmd, sub] = positionals;

if (values.help || !cmd) {
  console.log(HELP);
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
  console.log(`  This screen  ${!caps.screen.ok ? "no" : shared ? "on (only you can use it, and lend it to agents)" : "off (turn on with `warren node screen on`)"}: ${caps.screen.detail}`);
  console.log(`  VMs          ${caps.vm.ok ? "yes" : "no"}: ${caps.vm.detail}`);
  const found = discoverAgents();
  console.log("\nExisting agents Warren can import");
  if (!found.length) console.log("  none found");
  for (const a of found) console.log(`  ${a.name} (${a.harness}) ${a.path}`);
} else if (cmd === "setup") {
  await setup(values.yes ?? false);
} else if (cmd === "service") {
  await service(sub, positionals[2]);
} else if (cmd === "node" && sub === "start") {
  const cfg = saveNodeConfig();
  const kept = underKeeper();
  // two daemons with one token would take turns replacing each other on the hub
  const service = process.env.WARREN_SERVICE ? null : serviceStatus("node", dir);
  if (service?.running) {
    console.error(`This device is already connected by its service (${service.name}), so there's nothing to start. To run it in this terminal instead: warren service uninstall node`);
    process.exit(1);
  }
  const daemon = new NodeDaemon(cfg);
  daemon.start();
  watchForUpdates(async () => {
    if (!kept) return console.log("[warren] Warren was updated; restart `warren node start` to use the new version");
    console.log("[warren] Warren was updated; restarting once no agent is running");
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
} else if (cmd === "node" && (sub === "screen" || sub === "pause" || sub === "resume")) {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  if (sub === "screen") {
    const want = positionals[2];
    if (want !== "on" && want !== "off") {
      console.log(`This screen is ${saved.shareScreen && !saved.noScreen ? "on" : "off"}. Use \`warren node screen on\` or \`warren node screen off\`.`);
      process.exit(want ? 1 : 0);
    }
    saved.shareScreen = want === "on";
    if (want === "on") delete saved.noScreen;
  } else saved.paused = sub === "pause";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
  if (sub === "screen")
    console.log(
      saved.shareScreen
        ? "This screen is on. In Warren, only the person who connected this device can see or use it, and agents only while they lend it (Computers)."
        : "This screen is off. Nobody in Warren can see or use it.",
    );
  else console.log(saved.paused ? "Paused. Warren stops agents and computers on this device within a second or two. `warren node resume` to continue." : "Resumed.");
} else if (cmd === "update") {
  const v = await version();
  console.log(`Warren ${v.commit ?? "(not a git checkout)"}${v.date ? ` from ${v.date.slice(0, 10)}` : ""}`);
  const check = await checkForUpdate();
  for (const c of check.changes.slice(0, 20)) console.log(`  ${c}`);
  if (check.changes.length > 20) console.log(`  …and ${check.changes.length - 20} more`);
  console.log(check.reason);
  if (values.check || !check.canUpdate) process.exit(check.canUpdate || check.behind === 0 ? 0 : 1);
  try {
    const r = await runUpdate(undefined, { log: (line) => console.log(line) });
    console.log(`Warren ${r.from} → ${r.to}. A hub or device running from this folder restarts in a few seconds (a device waits for running agents).`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.log(HELP);
  process.exit(1);
}

/** Merges --hub, --token, --name and --allow-full-access into DIR/node.json; exits if hub or token is missing. */
function saveNodeConfig(): NodeConfig {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const cfg: NodeConfig = {
    ...saved,
    hub: values.hub ?? process.env.WARREN_HUB ?? saved.hub ?? "",
    token: values.token ?? process.env.WARREN_NODE_TOKEN ?? saved.token ?? "",
    name: values.name ?? saved.name ?? os.hostname(),
    allowFullAccess: values["allow-full-access"] ?? saved.allowFullAccess ?? false,
    dir,
  };
  if (!cfg.hub || !cfg.token) {
    console.error("Missing --hub and --token. Get them in Warren → Devices → Add device.");
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

/** `warren service`: start the hub or this device at login and keep it running. */
async function service(action: string | undefined, kind: string | undefined) {
  const kinds: ServiceKind[] = ["hub", "node"];
  if (action === "status") {
    for (const k of kind ? [kind as ServiceKind] : kinds) {
      const s = serviceStatus(k, dir);
      console.log(`${k.padEnd(5)} ${s.running ? "running" : s.installed ? "installed, not running" : "not installed"}${s.installed ? ` (${s.name}, log: ${s.log})` : ""}`);
    }
    return;
  }
  if ((action !== "install" && action !== "uninstall") || !kinds.includes(kind as ServiceKind)) {
    console.log("Usage: warren service install|uninstall hub|node, or warren service status");
    process.exit(1);
  }
  const k = kind as ServiceKind;
  if (action === "uninstall") {
    const s = uninstallService(k, dir);
    console.log(`Removed ${s.name}. Warren's data and settings are untouched.`);
    return;
  }
  const cfg = k === "node" ? saveNodeConfig() : undefined;
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
  const port = process.env.PORT ?? "4747";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (k === "hub") {
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (ok) return console.log(`The hub is up at http://localhost:${port}`);
    } else if (fs.existsSync(s.log)) {
      const recent = fs.readFileSync(s.log, "utf8").slice(from).split("\n").slice(-50).join("\n");
      if (recent.includes(`connected to ${cfg!.hub} as`)) return console.log(`Connected to ${cfg!.hub} as "${cfg!.name}".`);
    }
  }
  console.log(`It hasn't ${k === "hub" ? "answered yet" : "connected yet"}. Check ${s.log}${process.platform === "linux" ? ` or journalctl ${process.getuid?.() === 0 ? "" : "--user "}-u ${s.name}` : ""}.`);
}

/** `warren setup`: harnesses, a VM engine, and the VM image, so agents get their own computers here. */
async function setup(yes: boolean) {
  const saved: Partial<NodeConfig> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const ask = async (q: string) => {
    if (yes) return true;
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${q} [Y/n] `)).trim().toLowerCase();
    rl.close();
    return a === "" || a === "y" || a === "yes";
  };
  const run = (cmd: string, args: string[]) => {
    console.log(`  $ ${[cmd, ...args].join(" ")}`);
    try {
      execFileSync(cmd, args, { stdio: "inherit" });
      return true;
    } catch {
      return false;
    }
  };
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
      if (await ask("   Apple's container is installed but not running. Start it now?")) run("container", ["system", "start", "--enable-kernel-install"]);
    } else if (process.arch === "arm64" && which("brew")) {
      console.log("   Apple's container runs each VM in its own small virtual machine. It's free and open source, from Apple.");
      if (await ask("   Install it with Homebrew now?")) {
        if (run("brew", ["install", "container"])) run("container", ["system", "start", "--enable-kernel-install"]);
      }
    } else if (process.arch === "arm64") {
      console.log("   Install Apple's container from https://github.com/apple/container/releases (the .pkg), then run `warren setup` again.");
    } else {
      console.log("   On an Intel Mac, install OrbStack (https://orbstack.dev) or Docker Desktop, then run `warren setup` again.");
    }
    ({ engine, detail } = await detectEngine(saved.vmEngine));
  } else if (!engine && process.platform === "linux") {
    console.log("   Install Docker Engine or Podman, for example:");
    console.log("     curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # then log out and in");
    console.log("     sudo apt-get install -y podman                                             # or this");
  } else if (!engine && process.platform === "win32") {
    console.log("   Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then run `warren setup` again.");
  }
  console.log(`   ${detail}`);
  if (!engine) {
    console.log("\nAgents can still use an Orgo cloud computer (Settings → Computers in Warren) until this device can run VMs.");
    process.exit(1);
  }

  console.log("\n3. The VM image");
  let last = "";
  const image = await ensureImage(engine, (text) => {
    if (text !== last) console.log(`   ${(last = text)}`);
  });
  console.log(`   ready: ${image}`);

  console.log("\nThis device is ready to give agents their own computers.");
  console.log(saved.hub ? "If `warren node start` is running, Warren sees it within a few seconds." : "Next: connect it to your hub with the command from Warren → Devices → Add device.");
}
