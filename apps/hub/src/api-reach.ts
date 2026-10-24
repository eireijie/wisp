import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import { lanAddresses } from "./reach.ts";
import { reachableAddresses } from "./reachable-addresses.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean; owner?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

const DOWNLOAD: Record<string, string> = {
  darwin: "https://tailscale.com/download/mac",
  win32: "https://tailscale.com/download/windows",
  linux: "https://tailscale.com/download/linux",
};

/**
 * Settings → Access and the "Use Warren from anywhere" setup step: the hub's addresses and its
 * Tailscale status, and (owners) turning Tailscale's https address on or off.
 */
export function registerReachApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { need, parse } = h;
  const view = async (c: Caller, fresh = false) => {
    const tailscale = await hub.reach.tailscale(fresh);
    const port = Number(process.env.PORT ?? 4747);
    const publicUrl = await hub.reach.publicUrl();
    return {
      /** the address to give out: Tailscale's when it's on, else null (only this network) */
      publicUrl,
      cloudflare: hub.reach.cloudflare.status(),
      lan: lanAddresses(port),
      addresses: [...new Set([...(publicUrl ? [publicUrl] : []), ...reachableAddresses(null, port)])],
      tailscale: c.viewer.role === "owner" ? tailscale : { state: tailscale.state, serving: tailscale.serving, funnel: tailscale.funnel, dnsName: tailscale.dnsName },
      /** where to get Tailscale for the hub's computer */
      download: DOWNLOAD[process.platform] ?? "https://tailscale.com/download",
      hubPlatform: process.platform,
    };
  };

  app.get("/api/reach", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return view(c, (req.query as { fresh?: string }).fresh === "1");
  });

  app.post("/api/reach/tailscale", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ action: z.enum(["login", "up", "serve", "unserve", "funnel", "unfunnel"]) }), req.body, reply);
    if (!body) return;
    try {
      await hub.reach.act(body.action);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    return view(c, true);
  });

  app.post("/api/reach/cloudflare", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.discriminatedUnion("action", [
      z.object({ action: z.literal("start"), token: z.string().trim().min(20).max(16384), url: z.string().url().optional() }),
      z.object({ action: z.literal("stop") }),
    ]), req.body, reply);
    if (!body) return;
    try {
      if (body.action === "start") hub.reach.cloudflare.start(body.token, body.url);
      else hub.reach.cloudflare.stop();
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    return view(c, true);
  });

}
