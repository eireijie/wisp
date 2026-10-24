import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeviceShelf } from "@warren/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
}

/**
 * The marketplace's other shelves: brand logos, skills from public repos, and what the person's
 * own devices already have. Apps themselves come from /api/marketplace.
 */
export function registerShopApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need } = h;

  /**
   * A brand's logo as SVG, for the first of `for` that names one (Simple Icons). No sign-in: it's
   * public artwork, asked for by <img> tags, which can't send a token.
   */
  app.get("/api/logo", async (req, reply) => {
    const q = (req.query as { for?: string | string[] }).for;
    const names = (Array.isArray(q) ? q : q ? [q] : []).slice(0, 3).map((n) => String(n).slice(0, 100));
    const svg = names.length ? await hub.logos.svg(names) : null;
    reply.header("cache-control", "public, max-age=86400").header("x-content-type-options", "nosniff");
    if (!svg) return reply.code(404).send({ error: "no logo" });
    // opened on its own, the file still can't run anything
    return reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").type("image/svg+xml").send(svg);
  });

  app.get("/api/skill-store", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return hub.publicSkills.list();
  });

  /** One public skill and its instructions (only open-source ones; the rest are read at their source). */
  app.get("/api/skill-store/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const found = await hub.publicSkills.get((req.params as { id: string }).id);
    if (!found) return reply.code(404).send({ error: "no such skill" });
    return { skill: found.skill, content: found.skill.license.open ? found.text : null };
  });

  /** What the caller's own devices' harnesses already have. Someone else's device is theirs to look through. */
  app.get("/api/shelf", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const out: DeviceShelf[] = [];
    for (const n of store.nodes(c.workspaceId)) {
      if (n.ownerId !== c.actor.id) continue;
      const items = hub.shelves.get(n.id);
      if (items) out.push({ nodeId: n.id, nodeName: n.name, online: hub.isNodeOnline(n.id), items });
    }
    return out;
  });

  /** Have a device look through its harnesses again. */
  app.post("/api/shelf/:nodeId/refresh", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const n = store.node((req.params as { nodeId: string }).nodeId);
    if (!n || n.workspaceId !== c.workspaceId || n.ownerId !== c.actor.id) return reply.code(404).send({ error: "device not found" });
    if (!hub.isNodeOnline(n.id)) return reply.code(503).send({ error: `${n.name} is offline` });
    hub.sendToNode(n.id, { type: "refresh" });
    return { ok: true };
  });
}
