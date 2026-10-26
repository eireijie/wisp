import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isMasked, maskSecret } from "@warren/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";

const settingsSchema = z.object({
  listen: z.enum(["device", "openai"]),
  speak: z.enum(["device", "openai", "elevenlabs"]),
  openaiKey: z.string().trim().max(8000),
  elevenlabsKey: z.string().trim().max(8000),
}).strict();
const defaults = { listen: "device", speak: "device", openaiKey: "", elevenlabsKey: "" } as const;
type Settings = z.infer<typeof settingsSchema>;

/** Personal credentials use the hub settings store and the same masking rules as connectors.
 * They never enter agent prompts, browser storage, or a provider URL supplied by a client. */
export function registerVoiceApi(app: FastifyInstance, hub: Hub, h: {
  need(req: FastifyRequest, reply: FastifyReply, opts: { user: boolean }): Caller | null;
}) {
  const key = (c: Caller) => `voice.${c.actor.id}`;
  const read = (c: Caller): Settings => ({ ...defaults, ...JSON.parse(hub.store.setting(c.workspaceId, key(c)) ?? "{}") });
  const view = (s: Settings) => ({ ...s, openaiKey: maskSecret(s.openaiKey), elevenlabsKey: maskSecret(s.elevenlabsKey) });
  app.get("/api/voice/settings", async (req, reply) => {
    const c = h.need(req, reply, { user: true });
    if (c) { reply.header("cache-control", "no-store"); return view(read(c)); }
  });
  app.put("/api/voice/settings", async (req, reply) => {
    const c = h.need(req, reply, { user: true });
    if (!c) return;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid voice settings" });
    const saved = read(c), next = parsed.data;
    for (const field of ["openaiKey", "elevenlabsKey"] as const) if (isMasked(next[field])) next[field] = saved[field];
    if ((next.listen === "openai" || next.speak === "openai") && !next.openaiKey) return reply.code(400).send({ error: "Add your OpenAI key first" });
    if (next.speak === "elevenlabs" && !next.elevenlabsKey) return reply.code(400).send({ error: "Add your ElevenLabs key first" });
    hub.store.setSetting(c.workspaceId, key(c), JSON.stringify(next));
    return view(next);
  });

  // Bound concurrent paid requests, payload size and upstream time. Provider errors are redacted.
  const active = new Map<string, number>();
  app.post("/api/voice/audio", { bodyLimit: 8_000_000 }, async (req, reply) => {
    const c = h.need(req, reply, { user: true });
    if (!c) return;
    const parsed = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("speak"), provider: z.enum(["openai", "elevenlabs"]), text: z.string().trim().min(1).max(1500), voice: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict(),
      z.object({ kind: z.literal("listen"), audio: z.string().min(1).max(7_500_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), mime: z.enum(["audio/webm", "audio/mp4", "audio/wav"]) }).strict(),
    ]).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid voice request" });
    const s = read(c), b = parsed.data;
    const provider = b.kind === "listen" ? "openai" : b.provider;
    const secret = provider === "openai" ? s.openaiKey : s.elevenlabsKey;
    if (!secret) return reply.code(400).send({ error: `Add your ${provider === "openai" ? "OpenAI" : "ElevenLabs"} key in Settings → Voice` });
    const id = `${c.workspaceId}:${c.actor.id}`;
    if ((active.get(id) ?? 0) >= 3) return reply.code(429).send({ error: "Voice is busy. Try again in a moment." });
    active.set(id, (active.get(id) ?? 0) + 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", abort);
    try {
      let url: string, body: BodyInit;
      const headers: Record<string, string> = provider === "openai" ? { authorization: `Bearer ${secret}` } : { "xi-api-key": secret };
      if (b.kind === "listen") {
        url = "https://api.openai.com/v1/audio/transcriptions";
        const form = new FormData();
        const ext = b.mime.split("/")[1];
        form.set("file", new Blob([Buffer.from(b.audio, "base64")], { type: b.mime }), `turn.${ext}`);
        form.set("model", "gpt-4o-mini-transcribe");
        body = form;
      } else {
        headers["content-type"] = "application/json";
        url = provider === "openai" ? "https://api.openai.com/v1/audio/speech" : `https://api.elevenlabs.io/v1/text-to-speech/${b.voice}`;
        body = JSON.stringify(provider === "openai" ? { model: "gpt-4o-mini-tts", input: b.text, voice: b.voice, response_format: "mp3" } : { model_id: "eleven_multilingual_v2", text: b.text });
      }
      const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      if (!res.ok) {
        await res.body?.cancel();
        return reply.code(502).send({ error: `${provider === "openai" ? "OpenAI" : "ElevenLabs"} couldn't process the audio (${res.status}). Check your key, quota and voice.` });
      }
      reply.header("cache-control", "no-store");
      if (b.kind === "listen") {
        const data = await res.json() as { text?: string };
        return { text: typeof data.text === "string" ? data.text.slice(0, 40_000) : "" };
      }
      return reply.type("audio/mpeg").send(Buffer.from(await res.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: "Voice provider couldn't be reached. Please try again." });
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", abort);
      const n = (active.get(id) ?? 1) - 1;
      if (n) active.set(id, n); else active.delete(id);
    }
  });
}
