import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const { parseTarget, serviceWisp, Discovery, JoinClient } = createRequire(import.meta.url)("../src/join.cjs");
const expiresAt = () => new Date(Date.now() + 600000).toISOString();
const json = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body });

afterEach(() => vi.useRealTimers());

describe("desktop invite addresses", () => {
  it("splits invites and preserves ordinary address fallbacks", () => {
    expect(parseTarget(" https://wisp.example/join/abc%2Bdef/ ")).toEqual({ origins: ["https://wisp.example"], invite: "abc+def" });
    expect(parseTarget("http://192.168.1.2:4747/join/secret")).toEqual({ origins: ["http://192.168.1.2:4747"], invite: "secret" });
    expect(parseTarget("home:4747").origins).toEqual(["http://home:4747", "https://home:4747"]);
    expect(() => parseTarget("https://name:password@wisp.example/join/secret")).toThrow();
    expect(() => parseTarget("https://wisp.example/join/")).toThrow(/incomplete/);
    expect(() => parseTarget("")).toThrow();
  });
});

describe("Wi-Fi discovery", () => {
  const service = { name: "Wisp", port: 4747, addresses: ["fe80::1", "169.254.1.1", "192.168.1.2"], txt: { v: "1", id: "stable", name: "Yug's Wisp", host: "mac.local" } };

  it("resolves usable addresses and requires the supported protocol", () => {
    expect(serviceWisp(service)).toEqual({ id: "stable", name: "Yug's Wisp", host: "mac.local", url: "http://192.168.1.2:4747" });
    expect(serviceWisp({ ...service, addresses: ["fd12::2"] }).url).toBe("http://[fd12::2]:4747");
    expect(serviceWisp({ ...service, txt: { v: "2" } })).toBeNull();
  });

  it("browses _wisp._tcp for four seconds, deduplicates ids and closes its sockets", async () => {
    vi.useFakeTimers();
    let up: (s: object) => void = () => {};
    const browser = Object.assign(new EventEmitter(), { stop: vi.fn() });
    const destroy = vi.fn();
    const find = vi.fn((_opts, cb) => { up = cb; return browser; });
    const discovery = new Discovery(() => ({ Bonjour: class { find = find; destroy = destroy; } }));
    const result = discovery.browse();
    up(service);
    up({ ...service, txt: { ...service.txt, name: "Renamed Wisp" } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toMatchObject({ ok: true, wisps: [{ id: "stable", name: "Renamed Wisp" }] });
    expect(find).toHaveBeenCalledWith({ type: "wisp", protocol: "tcp" }, expect.any(Function));
    expect(browser.stop).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up when cancelled or multicast fails, and allows scanning again", async () => {
    const stop = vi.fn(), destroy = vi.fn();
    let error: () => void = () => {};
    const discovery = new Discovery(() => ({ Bonjour: class {
      constructor(_opts: unknown, cb: () => void) { error = cb; }
      find = () => Object.assign(new EventEmitter(), { stop });
      destroy = destroy;
    } }));
    const first = discovery.browse();
    discovery.cancel();
    expect(await first).toEqual({ ok: true, wisps: [] });
    const second = discovery.browse();
    error();
    expect(await second).toMatchObject({ ok: false, wisps: [] });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});

describe("desktop join protocol", () => {
  it("asks, polls with the secret, and retains the one-use approval across concurrent reads", async () => {
    let reads = 0;
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        let body = "";
        for await (const part of req) body += part;
        expect(JSON.parse(body)).toEqual({ name: "My Mac", kind: "computer", platform: "darwin", invite: "invite" });
        res.writeHead(201).end(JSON.stringify({ requestId: "request", secret: "private", code: "482913", expiresAt: expiresAt() }));
      } else {
        expect(req.url).toBe("/api/join/requests/request");
        expect(req.headers["x-join-secret"]).toBe("private");
        reads++;
        res.end(JSON.stringify(reads === 1 ? { status: "approved", nodeId: "device", nodeToken: "device-secret", hubUrl: "http://localhost:4747", workspaceName: "My Wisp" } : { status: "approved" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const client = new JoinClient({ name: () => "My Mac", platform: "darwin" });
      const request = await client.request(`${origin}/join/invite`);
      expect(request).toMatchObject({ ok: true, code: "482913" });
      expect(request.secret).toBeUndefined();
      const [a, b] = await Promise.all([client.poll(), client.poll()]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({ status: "approved", hubUrl: origin, nodeId: "device", nodeToken: "device-secret" });
      expect(await client.poll()).toEqual(a);
      expect(reads).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
  });

  it("does not persist an approval that arrived after cancellation", async () => {
    let approve: (value: any) => void = () => {};
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ requestId: "r", secret: "s", code: "012345", expiresAt: expiresAt() }))
      .mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; }));
    const client = new JoinClient({ fetchImpl, name: () => "PC", platform: "win32" });
    await client.request("http://home:4747");
    const result = client.poll();
    client.cancel();
    approve(json({ status: "approved", nodeId: "n", nodeToken: "t" }));
    expect(await result).toEqual({ status: "expired" });
  });

  it("does not save a request that completed after cancellation", async () => {
    let answer: (value: any) => void = () => {};
    const client = new JoinClient({ fetchImpl: () => new Promise((resolve) => { answer = resolve; }), name: () => "PC", platform: "linux" });
    const result = client.request("http://home:4747");
    client.cancel();
    answer(json({ requestId: "r", secret: "s", code: "012345", expiresAt: expiresAt() }));
    expect(await result).toEqual({ ok: false, cancelled: true });
    expect(await client.poll()).toEqual({ status: "expired" });
  });

  it("asks for a fresh request when a one-use approval was already collected", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ requestId: "r", secret: "s", code: "012345", expiresAt: expiresAt() })).mockResolvedValueOnce(json({ status: "approved" }));
    const client = new JoinClient({ fetchImpl, name: () => "PC", platform: "linux" });
    await client.request("http://home:4747");
    expect(await client.poll()).toEqual({ status: "expired" });
  });

  it.each(["pending", "denied", "expired"])("reports %s without a credential", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ requestId: "r", secret: "s", code: "012345", expiresAt: expiresAt() })).mockResolvedValueOnce(json({ status }));
    const client = new JoinClient({ fetchImpl, name: () => "PC", platform: "linux" });
    await client.request("http://home:4747");
    expect(await client.poll()).toEqual({ status });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).invite).toBeUndefined();
  });

  it("explains invalid invites and retries a failed poll without losing the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 403));
    const client = new JoinClient({ fetchImpl, name: () => "PC", platform: "linux" });
    await expect(client.request("https://wisp.example/join/old")).rejects.toThrow(/new invite/);
    fetchImpl.mockResolvedValueOnce(json({ requestId: "r", secret: "s", code: "012345", expiresAt: expiresAt() }))
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(json({ status: "pending" }));
    await client.request("https://wisp.example/join/new");
    await expect(client.poll()).rejects.toThrow("offline");
    expect(await client.poll()).toEqual({ status: "pending" });
  });
});
