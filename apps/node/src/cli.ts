#!/usr/bin/env -S npx tsx
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { HARNESSES } from "@warren/core";
import { deviceAdapters } from "@warren/adapters";
import { ComputerHost } from "./computers/index.ts";
import { discoverAgents } from "./discover.ts";
import { NodeDaemon, type NodeConfig } from "./daemon.ts";
import { RESTART_CODE, checkForUpdate, runUpdate, underKeeper, version, watchForUpdates } from "@warren/update";

const HELP = `warren — connect this device to a Warren hub

Usage:
  warren node start [--hub URL --token TOKEN] [--name NAME] [--dir DIR] [--allow-full-access]
      Connect this device as a node. Hub URL and token are saved to DIR/node.json,
      so later runs only need \`warren node start\`. Create the token in Warren → Devices.
      --allow-full-access lets agents set to "Full access" run without a sandbox here (saved).
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
  "noScreen": true         never let agents use this device's own screen
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
      version = execFileSync(a.binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim().split("\n")[0];
    } catch {}
    const how = HARNESSES.find((h) => h.id === a.id)?.protocol === "native" ? "" : " (ACP)";
    console.log(`  ${(a.label + how).padEnd(20)} ${a.binary.padEnd(14)} ${version}`);
  }
  const caps = await new ComputerHost({ dir, vmEngine: saved.vmEngine }).capabilities();
  console.log("\nComputers");
  console.log(`  This screen  ${saved.noScreen ? "off (noScreen)" : caps.screen.ok ? "yes" : "no"}: ${caps.screen.detail}`);
  console.log(`  VMs          ${caps.vm.ok ? "yes" : "no"}: ${caps.vm.detail}`);
  const found = discoverAgents();
  console.log("\nExisting agents Warren can import");
  if (!found.length) console.log("  none found");
  for (const a of found) console.log(`  ${a.name} (${a.harness}) ${a.path}`);
} else if (cmd === "node" && sub === "start") {
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
    console.error("Missing --hub and --token. Create a node in Warren → Nodes to get them.");
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const { dir: _dir, ...keep } = cfg;
  fs.writeFileSync(configFile, JSON.stringify(keep, null, 2), { mode: 0o600 });
  const kept = underKeeper();
  const daemon = new NodeDaemon(cfg);
  daemon.start();
  watchForUpdates(async () => {
    if (!kept) return console.log("[warren] Warren was updated; restart `warren node start` to use the new version");
    console.log("[warren] Warren was updated; restarting once no agent is running");
    await daemon.idle();
    daemon.stop();
    process.exit(RESTART_CODE);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      daemon.stop();
      process.exit(0);
    });
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
