import { stableHubId } from "./discovery.ts";
import { watchLocalDevice } from "./local-device.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { REPO_ROOT, RESTART_CODE } from "@warren/update";
import { Vault } from "@warren/vault";
import { registerApi } from "./api.ts";
import { openDb } from "./db.ts";
import { Hub } from "./hub.ts";
import { registerVaultGit } from "./vault-git.ts";
import { carryOverVault, rememberVaultDir, resolveVaultLocation } from "./vault-location.ts";
import { Store } from "./store.ts";
import { Vaults } from "./vaults.ts";
import { SetupCode } from "./setup-code.ts";

export interface HubOptions {
  dataDir: string;
  webDir?: string;
  logger?: boolean;
  /** what making the first account needs: by default a code saved in <data>/setup-code; false for none (tests) */
  setupCode?: string | false;
}

export async function buildHub(opts: HubOptions) {
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const db = openDb(path.join(opts.dataDir, "warren.db"));
  // memory lives in <data>/vault unless the owner pointed it at another folder (maybe an Obsidian vault)
  const location = resolveVaultLocation(opts.dataDir);
  const moved = carryOverVault(opts.dataDir, location.path);
  const vault = new Vault(location.path, db);
  await vault.init();
  if (moved && moved.files > 0) await vault.syncFromDisk({ name: "Warren", email: "warren@localhost" }, "Brought over memory from the earlier folder");
  rememberVaultDir(opts.dataDir, location.path);
  const store = new Store(db);
  // each organization's memory: the first keeps this vault, the others get their own under <data>/orgs
  let hubRef: Hub | null = null;
  const vaults = new Vaults(path.resolve(opts.dataDir), vault, store, (wsId) => hubRef?.broadcast(wsId, { type: "memory_changed" }));
  await vaults.openAll();
  const hub = new Hub(store, vaults);
  hubRef = hub;
  hub.id = stableHubId(path.resolve(opts.dataDir));
  hub.reach.cloudflare.configure(path.resolve(opts.dataDir));
  await hub.foldTeams();
  await hub.ensureBuiltinSkills(undefined, true);
  hub.routines.start();
  hub.background.start();
  // edits made in Obsidian on this machine show up in Warren
  const stopWatching = vault.watch({
    onChange: () => {
      const ws = store.firstWorkspace();
      if (ws) hub.broadcast(ws.id, { type: "memory_changed" });
    },
  });

  // invite links carry their secret in the path; keep it out of the log
  const redact = (url: string) => url.replace(/^\/join\/[^/?#]+/, "/join/[invite]");
  const logger = opts.logger ? { serializers: { req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: req.method, url: redact(req.url), host: req.hostname, remoteAddress: req.ip }) } } : false;
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 });
  const setupCode = new SetupCode(path.resolve(opts.dataDir), store.userCount() === 0, opts.setupCode ?? (process.env.WARREN_SETUP_CODE || undefined));
  // the consent and approve screens can't be framed by another site and clicked through
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("x-frame-options")) reply.header("x-frame-options", "SAMEORIGIN");
    const csp = reply.getHeader("content-security-policy");
    if (!csp) reply.header("content-security-policy", "frame-ancestors 'self'");
    return payload;
  });
  await app.register(websocket);
  app.get("/healthz", async () => ({ ok: true }));
  registerInstallers(app);
  registerApi(app, hub, {
    filesDir: path.join(opts.dataDir, "files"),
    dataDir: path.resolve(opts.dataDir),
    vault: { location, moved },
    restart: () => app.close().then(() => process.exit(RESTART_CODE)),
    setupCode,
  });
  registerVaultGit(app, hub, { dataDir: path.resolve(opts.dataDir) });
  // the hub's own computer becomes a device once someone asks for it and there's an owner
  const stopLocalDevice = watchLocalDevice(hub, path.resolve(opts.dataDir));

  if (opts.webDir && fs.existsSync(opts.webDir)) {
    // wildcard serving picks up rebuilt assets without a restart
    await app.register(fastifyStatic, {
      root: opts.webDir,
      cacheControl: false,
      setHeaders: (reply, file) => {
        // hashed assets are immutable; the shell must always revalidate
        reply.header("cache-control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    // SPA fallback: unknown page routes serve index.html (but never for missing assets)
    app.setNotFoundHandler((req, reply) => {
      const p = req.url.split("?")[0];
      if (req.method === "GET" && !p.startsWith("/api/") && !p.startsWith("/ws") && !p.startsWith("/assets/") && !path.extname(p)) return reply.sendFile("index.html");
      reply.code(404).send({ error: "not found" });
    });
  }

  app.addHook("preClose", async () => {
    stopWatching();
    stopLocalDevice();
    await hub.shutdown();
  });
  app.addHook("onClose", async () => {
    vaults.close();
    db.close();
  });
  return { app, hub, setupCode };
}

/**
 * The installers from the repo, served by the hub so Devices → Add device can give a one-line
 * command. They clone from wherever this hub's copy came from, when that's a public https URL.
 */
function registerInstallers(app: FastifyInstance) {
  let origin = "";
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  const repo = /^https:\/\/[^@\s]+$/.test(origin) ? origin : "";
  for (const [file, type, pattern] of [
    ["install.sh", "text/x-shellscript", /^WARREN_REPO="\$\{WARREN_REPO:-[^}]*\}"$/m],
    ["install.ps1", "text/plain", /^\$Repo = .*$/m],
  ] as const) {
    app.get(`/${file}`, async (_req, reply) => {
      let text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (file === "install.sh") text = joinInstaller(text);
      if (repo)
        text = text.replace(pattern, file === "install.sh" ? `WARREN_REPO="\${WARREN_REPO:-${repo}}"` : `$Repo = if ($env:WARREN_REPO) { $env:WARREN_REPO } else { "${repo}" }`);
      return reply.type(`${type}; charset=utf-8`).header("cache-control", "no-cache").send(text);
    });
  }
}

/** Compatibility for older checkouts; the canonical installer is maintained separately. */
export function joinInstaller(source: string): string {
  let text = source;
  if (!/^\s*join\)/m.test(text)) {
    text = text.replace('while [ $# -gt 0 ]; do', 'INVITE=""\nwhile [ $# -gt 0 ]; do');
    text = text.replace('  case "$1" in', `  case "$1" in
    join) MODE=join; if [ -n "\${2:-}" ] && [ "\${2#--}" = "$2" ]; then INVITE="$2"; shift; fi ;;`);
    text = text.replace('if [ "$MODE" = hub ]; then', `if [ "$MODE" = join ]; then
  if [ -n "$INVITE" ]; then warren join "$INVITE"; else warren join; fi
elif [ "$MODE" = hub ]; then`);
  }
  // The documented command pipes to sh; parse the actual installer with Bash on every platform.
  let delimiter = "WISP_INSTALLER_BASH";
  while (text.split("\n").includes(delimiter)) delimiter += "_";
  return `#!/usr/bin/env bash\nexec bash -s -- "$@" <<'${delimiter}'\n${text}\n${delimiter}\n`;
}
