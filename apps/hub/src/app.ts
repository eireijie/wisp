import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { REPO_ROOT } from "@warren/update";
import { Vault } from "@warren/vault";
import { registerApi } from "./api.ts";
import { openDb } from "./db.ts";
import { Hub } from "./hub.ts";
import { Store } from "./store.ts";

export interface HubOptions {
  dataDir: string;
  webDir?: string;
  logger?: boolean;
}

export async function buildHub(opts: HubOptions) {
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const db = openDb(path.join(opts.dataDir, "warren.db"));
  const vault = new Vault(path.join(opts.dataDir, "vault"), db);
  await vault.init();
  const hub = new Hub(new Store(db), vault);
  await hub.ensureTeams();
  hub.routines.start();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(websocket);
  app.get("/healthz", async () => ({ ok: true }));
  registerInstallers(app);
  registerApi(app, hub, { filesDir: path.join(opts.dataDir, "files"), dataDir: path.resolve(opts.dataDir) });

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

  app.addHook("preClose", async () => hub.shutdown());
  app.addHook("onClose", async () => db.close());
  return { app, hub };
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
      if (repo)
        text = text.replace(pattern, file === "install.sh" ? `WARREN_REPO="\${WARREN_REPO:-${repo}}"` : `$Repo = if ($env:WARREN_REPO) { $env:WARREN_REPO } else { "${repo}" }`);
      return reply.type(`${type}; charset=utf-8`).header("cache-control", "no-cache").send(text);
    });
  }
}
