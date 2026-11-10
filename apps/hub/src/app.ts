import { stableHubId } from "./discovery.ts";
import { watchLocalDevice } from "./local-device.ts";
import { adoptShared, keepDeviceScreens } from "./shared-computer.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { REPO_ROOT, RESTART_CODE } from "@wisp/update";
import { Vault } from "@wisp/vault";
import { envVar } from "@wisp/core";
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
  /** true logs to stdout; tests pass a stream to read what gets logged */
  logger?: boolean | { stream: { write(line: string): void } };
  /** what making the first account needs: by default a code saved in <data>/setup-code; false for none (tests) */
  setupCode?: string | false;
}

/** A data folder from before the rename to Wisp holds warren.db (and maybe its -wal/-shm); take it over once. */
export function adoptWarrenDb(dataDir: string) {
  const to = path.join(dataDir, "wisp.db");
  const from = path.join(dataDir, "warren.db");
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  // companions first, so a crash in between never leaves wisp.db without its write-ahead log
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(from + suffix)) fs.renameSync(from + suffix, to + suffix);
  fs.renameSync(from, to);
  console.log(`[wisp] using the database from before the rename (${from} -> ${to})`);
  return true;
}

/**
 * The data folder holds secrets in the clear (connector values, sign-ins), so only this account
 * reads it. Also tightens folders made before this; one on a filesystem without modes stays as it is.
 */
export function lockDataDir(dataDir: string) {
  const chmod = (p: string, mode: number) => {
    try {
      fs.chmodSync(p, mode);
    } catch (e) {
      console.warn(`[wisp] couldn't limit access to ${p}: ${(e as Error).message}`);
    }
  };
  chmod(dataDir, 0o700);
  // SQLite gives -wal and -shm the database's own mode, so a new one needs it from the start
  fs.closeSync(fs.openSync(path.join(dataDir, "wisp.db"), "a", 0o600));
  for (const f of ["wisp.db", "wisp.db-wal", "wisp.db-shm"]) if (fs.existsSync(path.join(dataDir, f))) chmod(path.join(dataDir, f), 0o600);
}

/** Query values that are secrets, and paths that carry one, kept out of the log. */
export function redactUrl(url: string): string {
  return url
    .replace(/^\/join\/[^/?#]+/, "/join/[invite]")
    .replace(/([?&](?:code|invite|token|state|secret)=)[^&#]*/gi, "$1[hidden]");
}

export async function buildHub(opts: HubOptions) {
  fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  adoptWarrenDb(opts.dataDir);
  lockDataDir(opts.dataDir);
  const db = openDb(path.join(opts.dataDir, "wisp.db"));
  // memory lives in <data>/vault unless the owner pointed it at another folder (maybe an Obsidian vault)
  const location = resolveVaultLocation(opts.dataDir);
  const moved = carryOverVault(opts.dataDir, location.path);
  const vault = new Vault(location.path, db);
  await vault.init();
  if (moved && moved.files > 0) await vault.syncFromDisk({ name: "Wisp", email: "wisp@localhost" }, "Brought over memory from the earlier folder");
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
  store.migrateTeamSteps();
  await hub.ensureBuiltinSkills(undefined, true);
  hub.routines.start();
  hub.schedules.start();
  hub.background.start();
  hub.watches.start();
  hub.autoMemory.start();
  // edits made in Obsidian on this machine show up in Wisp
  const stopWatching = vault.watch({
    onChange: () => {
      const ws = store.firstWorkspace();
      if (ws) hub.broadcast(ws.id, { type: "memory_changed" });
    },
  });

  const logger = opts.logger ? { ...(opts.logger === true ? {} : opts.logger), serializers: { req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url), host: req.hostname, remoteAddress: req.ip }) } } : false;
  // Tailscale Serve and Funnel, and cloudflared, reach the hub from this computer and say who the
  // visitor really is in X-Forwarded-For; without trusting them, every visitor shares one address
  // and one rate limit. Only this computer is trusted to say so, never the network.
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024, trustProxy: "loopback" });
  const setupCode = new SetupCode(path.resolve(opts.dataDir), store.userCount() === 0, opts.setupCode ?? (envVar("SETUP_CODE") || undefined));
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
  // agents made before the shared computer, with none of their own, get it (shared-computer.ts)
  for (const { id: ws } of store.db.prepare("SELECT id FROM workspaces").all() as { id: string }[]) {
    try {
      adoptShared(hub, ws);
      keepDeviceScreens(hub, ws);
    } catch {}
  }

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
    ["install.sh", "text/x-shellscript", /^WISP_REPO=.*$/m],
    ["install.ps1", "text/plain", /^\$Repo = .*$/m],
  ] as const) {
    app.get(`/${file}`, async (_req, reply) => {
      let text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (file === "install.sh") text = joinInstaller(text);
      if (repo)
        text = text.replace(pattern, file === "install.sh" ? `WISP_REPO="\${WISP_REPO-\${WARREN_REPO-${repo}}}"` : `$Repo = if (Test-Path Env:WISP_REPO) { $env:WISP_REPO } elseif (Test-Path Env:WARREN_REPO) { $env:WARREN_REPO } else { "${repo}" }`);
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
  if [ -n "$INVITE" ]; then wisp join "$INVITE"; else wisp join; fi
elif [ "$MODE" = hub ]; then`);
  }
  // The documented command pipes to sh; parse the actual installer with Bash on every platform.
  let delimiter = "WISP_INSTALLER_BASH";
  while (text.split("\n").includes(delimiter)) delimiter += "_";
  return `#!/usr/bin/env bash\nexec bash -s -- "$@" <<'${delimiter}'\n${text}\n${delimiter}\n`;
}
