import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { RESTART_CODE, underKeeper } from "@wisp/update";
import type { Caller } from "./api.ts";
import { id } from "./auth.ts";
import type { Hub } from "./hub.ts";
import { GIT_PATH, newSyncToken, syncProblem } from "./vault-git.ts";
import { resolveVaultLocation, saveVaultLocation, type MoveResult, type VaultLocation } from "./vault-location.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  dataDir: string;
  /** where the vault was opened from when the hub started, and what happened to an earlier vault */
  started: { location: VaultLocation; moved: MoveResult | null };
  /** stop the hub so its keeper starts it again */
  restart(): void;
}

/** Settings → Memory: where the vault lives, and the tokens Obsidian's Git plugin signs in with. */
export function registerMemoryStorageApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need, parse } = h;

  async function describe(c: Caller) {
    const owner = c.viewer.role === "owner";
    const vault = hub.vault(c.workspaceId);
    // only the first organization's memory can live in a folder of the owner's choosing; the others stay in Wisp's data folder
    const movable = hub.vaults.isPrimary(c.workspaceId);
    const next = resolveVaultLocation(h.dataDir);
    const problem = await syncProblem(hub, c.workspaceId, c.viewer);
    return {
      // the folder is the owner's business; everyone else only needs the instructions
      path: owner ? vault.root : null,
      source: movable ? h.started.location.source : "default",
      setting: owner && movable ? next.setting : null,
      pendingRestart: owner && movable && path.resolve(next.path) !== path.resolve(vault.root),
      nextPath: owner ? (movable ? next.path : vault.root) : null,
      restartable: underKeeper(),
      previous: owner && movable ? h.started.location.previous : null,
      moved: owner && movable ? h.started.moved : null,
      movable,
      sync: { allowed: !problem, reason: problem, urlPath: GIT_PATH, branch: await vault.branch() },
      tokens: store.vaultTokens(c.actor.id),
    };
  }

  app.get("/api/memory/storage", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return describe(c);
  });

  /** Choose the folder memory lives in. It takes effect the next time Wisp starts. */
  app.put("/api/memory/storage", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ path: z.string().max(1000).nullable() }), req.body, reply);
    if (!body) return;
    if (!hub.vaults.isPrimary(c.workspaceId)) return reply.code(409).send({ error: "Only the first workspace's memory can be moved to another folder; this one stays in Wisp's data folder." });
    if (h.started.location.source === "env") return reply.code(409).send({ error: "This is set by the WISP_VAULT_DIR setting where Wisp runs; change it there." });
    const saved = saveVaultLocation(h.dataDir, body.path);
    if (!saved.ok) return reply.code(400).send({ error: saved.error });
    return describe(c);
  });

  app.post("/api/memory/storage/restart", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    if (!underKeeper()) return reply.code(400).send({ error: "Wisp can't restart itself here. Stop it and start it again." });
    setTimeout(() => h.restart(), 300);
    return { ok: true, code: RESTART_CODE };
  });

  /** A token for Obsidian's Git plugin. Shown once. */
  app.post("/api/memory/tokens", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ label: z.string().trim().max(60).default("") }), req.body ?? {}, reply);
    if (!body) return;
    const problem = await syncProblem(hub, c.workspaceId, c.viewer);
    if (problem) return reply.code(403).send({ error: problem });
    const { token, hash } = newSyncToken();
    const tokenId = id("vtk");
    store.addVaultToken({ id: tokenId, hash, userId: c.actor.id, workspaceId: c.workspaceId, label: body.label || "Obsidian" });
    return { id: tokenId, token };
  });

  app.delete("/api/memory/tokens/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    if (!store.removeVaultToken(c.actor.id, (req.params as { id: string }).id)) return reply.code(404).send({ error: "token not found" });
    return { ok: true };
  });
}
