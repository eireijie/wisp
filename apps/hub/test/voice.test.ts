import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";

let built: Awaited<ReturnType<typeof buildHub>>, dir: string, owner: string, second: string;
async function api(method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: object, token = owner) {
  return built.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body });
}
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-voice-"));
  built = await buildHub({ dataDir: dir, setupCode: false });
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything", workspaceName: "Lab" }, "")).json().token;
  await api("POST", "/api/members", { email: "second@example.com", name: "Second", password: "password123", role: "member" });
  second = (await api("POST", "/api/auth/login", { email: "second@example.com", password: "password123" }, "")).json().token;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await built.app.close(); await fs.rm(dir, { recursive: true, force: true }); });
const settings = { listen: "device", speak: "device", openaiKey: "sk-private-secret-1234", elevenlabsKey: "eleven-secret-5678" };

describe("personal voice credentials and proxy", () => {
  it("requires authentication, defaults to free, masks and isolates personal keys", async () => {
    expect((await api("GET", "/api/voice/settings", undefined, "")).statusCode).toBe(401);
    expect((await api("GET", "/api/voice/settings")).json()).toEqual({ listen: "device", speak: "device", openaiKey: "", elevenlabsKey: "" });
    const saved = (await api("PUT", "/api/voice/settings", settings)).json();
    expect(saved.openaiKey).toBe("••••1234");
    expect(saved.elevenlabsKey).toBe("••••5678");
    expect((await api("PUT", "/api/voice/settings", saved)).json()).toEqual(saved);
    expect((await api("GET", "/api/voice/settings", undefined, second)).json().openaiKey).toBe("");
    expect((await api("PUT", "/api/voice/settings", { ...settings, listen: "openai", openaiKey: "" })).statusCode).toBe(400);
  });
  it("uses only fixed upstreams and the caller's saved key, with no credential in a response", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetcher);
    const body = { kind: "speak", provider: "openai", text: "Hello", voice: "coral" };
    const res = await api("POST", "/api/voice/audio", body);
    expect(res.statusCode).toBe(200); expect(res.headers["cache-control"]).toBe("no-store");
    expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/speech");
    expect((fetcher.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${settings.openaiKey}` });
    expect((await api("POST", "/api/voice/audio", body, second)).statusCode).toBe(400);
    expect((await api("POST", "/api/voice/audio", { ...body, voice: "../../private" })).statusCode).toBe(400);
    expect((await api("POST", "/api/voice/audio", { ...body, url: "https://bad.example" })).statusCode).toBe(400);
    expect((await api("POST", "/api/voice/audio", { ...body, text: "x".repeat(1501) })).statusCode).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("transcribes supported audio and redacts provider errors", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: "Hello ghost" }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const res = await api("POST", "/api/voice/audio", { kind: "listen", audio: "YXVkaW8=", mime: "audio/webm" });
    expect(res.json()).toEqual({ text: "Hello ghost" });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    fetcher.mockImplementationOnce(async () => new Response(settings.openaiKey, { status: 401 }));
    const error = await api("POST", "/api/voice/audio", { kind: "speak", provider: "openai", voice: "coral", text: "Hi" });
    expect(error.statusCode).toBe(502); expect(error.body).not.toContain(settings.openaiKey);
  });
  it("stores a voice turn through normal chat and keeps per-agent voices", async () => {
    const agent = (await api("POST", "/api/agents", { handle: "ghost", name: "Ghost", harness: "custom" })).json();
    const voice = { device: "local-voice", openai: "coral", elevenlabs: "JBFqnCBsd6RMkjVDRZzb" };
    expect((await api("PATCH", `/api/agents/${agent.id}`, { settings: { voice } })).statusCode).toBe(200);
    const agents = (await api("GET", "/api/agents")).json();
    expect(agents.find((a: { id: string }) => a.id === agent.id).settings.voice).toEqual(voice);
    const dm = (await api("POST", `/api/dm/${agent.id}`)).json();
    const message = (await api("POST", `/api/channels/${dm.id}/messages`, { body: "Please help me", voice: true })).json();
    expect(message.body).toBe("Please help me");
    expect(message.parts).toContainEqual({ type: "status", text: "Voice message" });
    expect(built.hub.store.db.prepare("SELECT id FROM runs WHERE trigger_message_id = ?").get(message.id)).toBeTruthy();
  });
  it("deletes a cleared key", async () => {
    expect((await api("PUT", "/api/voice/settings", { ...settings, openaiKey: "", elevenlabsKey: "" })).statusCode).toBe(200);
    expect((await api("GET", "/api/voice/settings")).json().openaiKey).toBe("");
  });
});
