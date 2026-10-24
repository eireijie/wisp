import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { findMovedWisp, joinTarget, joinWisp, type JoinDependencies } from "./join.ts";
import { discoverWisps, nearbyWisp, type Advertisement, type DiscoveryClient } from "./join-discovery.ts";

const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); });
function fixture(statuses: unknown[] = [{ status: "approved", nodeId: "n1", nodeToken: "private-key", hubUrl: "http://192.168.1.5:4747", workspaceName: "Yug's Wisp" }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-join-")); temporary.push(dir);
  let clock = 0;
  const replies = [{ requestId: "r1", secret: "private-secret", code: "482913", expiresAt: new Date(600_000).toISOString() }, ...statuses];
  const http = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
  const say = vi.fn();
  const install = vi.fn(() => {
    expect(JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8")).token).toBe("private-key");
  });
  const deps: JoinDependencies = {
    fetch: http as typeof fetch, discover: vi.fn(async () => [{ id: "w1", name: "Yug's Wisp", host: "Yug-Mac", url: "http://192.168.1.5:4747" }]),
    say, install, now: () => clock, sleep: vi.fn(async (ms) => { clock += ms; }),
  };
  return { dir, deps, http, say, install };
}

describe("join addresses", () => {
  it("splits an invite into its origin and secret", () => {
    expect(joinTarget("https://wisp.example/join/abc%2D123/")).toEqual({ url: "https://wisp.example", host: "wisp.example", invite: "abc-123" });
    expect(joinTarget("my-mac:4747").url).toBe("http://my-mac:4747");
    expect(joinTarget("ws://my-mac:4747/").url).toBe("http://my-mac:4747");
  });
  it.each(["https://example.com/other", "https://user:password@example.com", "https://", "file:///tmp/test"])("rejects malformed links: %s", (address) => expect(() => joinTarget(address)).toThrow());
});

describe("join protocol", () => {
  it("discovers, asks, displays the spaced code, polls privately and installs after saving", async () => {
    const f = fixture([{ status: "pending" }, { status: "approved", nodeId: "n1", nodeToken: "private-key", hubUrl: "http://192.168.1.5:4747", workspaceName: "Yug's Wisp" }]);
    fs.writeFileSync(path.join(f.dir, "node.json"), JSON.stringify({ shareScreen: true, local: true }));
    await joinWisp({ dir: f.dir, name: "Laptop" }, f.deps);
    expect(f.deps.discover).toHaveBeenCalledOnce();
    expect(f.http.mock.calls[0]).toEqual(expect.arrayContaining(["http://192.168.1.5:4747/api/join/requests"]));
    const calls = f.http.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ name: "Laptop", kind: "computer", platform: process.platform });
    expect(calls[1][1].headers).toEqual({ "x-join-secret": "private-secret" });
    expect(calls[1][1].redirect).toBe("error");
    expect(f.deps.sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(f.say.mock.calls.flat().join("\n")).toContain("482 913");
    expect(f.say.mock.calls.flat().join("\n")).not.toMatch(/private-(key|secret)/);
    expect(f.install).toHaveBeenCalledWith(f.dir);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dir, "node.json"), "utf8"));
    expect(saved).toMatchObject({ name: "Laptop", nodeId: "n1", token: "private-key", local: false, shareScreen: true });
    if (process.platform !== "win32") expect(fs.statSync(path.join(f.dir, "node.json")).mode & 0o777).toBe(0o600);
  });
  it("joins a mock HTTP service through the real fetch client", async () => {
    const f = fixture();
    let origin = "";
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        let text = ""; for await (const chunk of req) text += chunk;
        expect(JSON.parse(text)).toMatchObject({ name: "Laptop", kind: "computer", invite: "hello" });
        res.writeHead(201).end(JSON.stringify({ requestId: "r1", secret: "private-secret", code: "482913", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      } else {
        expect(req.url).toBe("/api/join/requests/r1");
        expect(req.headers["x-join-secret"]).toBe("private-secret");
        res.end(JSON.stringify({ status: "approved", nodeId: "n1", nodeToken: "private-key", hubUrl: origin, workspaceName: "Test Wisp" }));
      }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await joinWisp({ dir: f.dir, name: "Laptop", address: `${origin}/join/hello` }, { ...f.deps, fetch, now: Date.now, sleep: async () => {} });
      expect(f.install).toHaveBeenCalledOnce();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("keeps the address that worked when the one Wisp suggests can't be reached, and says which folder to start", async () => {
    const f = fixture();
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") res.writeHead(201).end(JSON.stringify({ requestId: "r1", secret: "s", code: "482913", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      else res.end(JSON.stringify({ status: "approved", nodeId: "n1", nodeToken: "k", hubUrl: "http://127.0.0.1:1", workspaceName: "Test Wisp" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await joinWisp({ dir: f.dir, name: "Laptop", address: origin, service: false }, { ...f.deps, fetch, now: Date.now, sleep: async () => {} });
      expect(JSON.parse(fs.readFileSync(path.join(f.dir, "node.json"), "utf8")).hub).toBe(origin);
      expect(f.say.mock.calls.flat().join("\n")).toContain(`wisp node start --dir ${JSON.stringify(f.dir)}`);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("uses an invite without browsing and can save without installing a service", async () => {
    const f = fixture();
    await joinWisp({ dir: f.dir, address: "https://wisp.example/join/hello", service: false }, f.deps);
    expect(f.deps.discover).not.toHaveBeenCalled();
    const calls = f.http.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0][1].body)).invite).toBe("hello");
    expect(f.install).not.toHaveBeenCalled();
  });
  it.each([[], [{ id: "a", name: "A", host: "a", url: "http://a" }, { id: "b", name: "B", host: "b", url: "http://b" }]].map((found) => [found]))("gives an invite hint instead of guessing: %j", async (found) => {
    const f = fixture();
    f.deps.discover = async () => found;
    await expect(joinWisp({ dir: f.dir }, f.deps)).rejects.toThrow("wisp join <invite-link>");
    expect(f.http).not.toHaveBeenCalled();
  });
  it.each(["denied", "expired", "unknown", "approved"])("does not save credentials for %s without a grant", async (status) => {
    const f = fixture([{ status }]);
    await expect(joinWisp({ dir: f.dir }, f.deps)).rejects.toThrow();
    expect(fs.existsSync(path.join(f.dir, "node.json"))).toBe(false);
    expect(f.install).not.toHaveBeenCalled();
  });
  it("expires locally even if the other computer stays pending", async () => {
    const f = fixture();
    let clock = 0;
    f.deps.now = () => clock;
    f.deps.sleep = async () => { clock = 600_001; };
    await expect(joinWisp({ dir: f.dir }, f.deps)).rejects.toThrow("expired");
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it.each([403, 429, 500])("handles HTTP %i without showing credentials", async (status) => {
    const f = fixture();
    f.deps.fetch = vi.fn(async () => new Response('{"error":"private-secret"}', { status })) as typeof fetch;
    await expect(joinWisp({ dir: f.dir }, f.deps)).rejects.toThrow(/invite|attempts|joining/);
    expect(f.say.mock.calls.flat().join(" ")).not.toContain("private-secret");
  });
  it("retains a one-use grant if service installation fails", async () => {
    const f = fixture();
    f.deps.install = () => { throw new Error("launchd unavailable"); };
    await expect(joinWisp({ dir: f.dir }, f.deps)).rejects.toThrow("wisp service install node");
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, "node.json"), "utf8")).token).toBe("private-key");
  });
  it("handles HTTP transport failure with a connection fix", async () => {
    const f = fixture();
    f.deps.fetch = vi.fn(async () => { throw new Error("offline"); });
    await expect(joinWisp({ dir: f.dir }, f.deps)).rejects.toThrow("check your Wi-Fi");
  });
});

describe("mDNS discovery", () => {
  const service: Advertisement = { name: "Wisp", host: "mac.local", port: 4747, addresses: ["fe80::1", "192.168.1.5"], txt: { v: "1", id: "w1", name: "Yug's Wisp", host: "Yug-Mac" } };
  it("reads versioned TXT metadata and chooses a usable address", () => {
    expect(nearbyWisp(service)).toEqual({ id: "w1", name: "Yug's Wisp", host: "Yug-Mac", url: "http://192.168.1.5:4747" });
    expect(nearbyWisp({ ...service, addresses: ["fd00::5"] })?.url).toBe("http://[fd00::5]:4747");
    expect(nearbyWisp({ ...service, txt: { v: "2" } })).toBeNull();
  });
  it("browses _wisp._tcp, deduplicates and closes both resources", async () => {
    const stop = vi.fn(), destroy = vi.fn();
    const find = vi.fn((_options, up) => { up(service); up(service); return { stop }; });
    const found = await discoverWisps({ durationMs: 1, create: () => ({ find, destroy }) });
    expect(find).toHaveBeenCalledWith({ type: "wisp", protocol: "tcp" }, expect.any(Function));
    expect(found).toHaveLength(1);
    expect(stop).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
  });
  it("cleans up when multicast fails", async () => {
    const stop = vi.fn(), destroy = vi.fn();
    const create = (onError: (error: Error) => void): DiscoveryClient => {
      queueMicrotask(() => onError(new Error("multicast blocked")));
      return { find: () => ({ stop }), destroy };
    };
    await expect(discoverWisps({ create })).rejects.toThrow("multicast blocked");
    expect(stop).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
  });
  it("closes discovery when cancelled", async () => {
    const abort = new AbortController(); const stop = vi.fn(), destroy = vi.fn();
    const promise = discoverWisps({ signal: abort.signal, create: () => ({ find: () => ({ stop }), destroy }) });
    abort.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("a Wisp that moved", () => {
  const me = { hubId: "hub-1", nodeId: "node-1", token: "wr_node_secret" };
  const wisp = (id: string, url: string) => ({ id, name: "Yug's Wisp", host: "yug-mac", url });
  const hash = crypto.createHash("sha256").update(me.token).digest("hex");
  const prover = (key: string) => vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { nonce } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ macs: [crypto.createHmac("sha256", key).update(`wisp-relocate:${nonce}`).digest("hex")] }));
  }) as unknown as typeof fetch;

  it("moves only to the Wisp that proves it holds this computer's credential", async () => {
    const found = async () => [wisp("other", "http://192.168.1.9:4747"), wisp("hub-1", "http://192.168.1.31:4747")];
    const real = prover(hash);
    expect(await findMovedWisp(me, "http://192.168.1.20:4747", found, real)).toBe("http://192.168.1.31:4747");
    const body = JSON.parse(String((real as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(JSON.stringify(body)).not.toContain(me.token);
    expect(JSON.stringify(body)).not.toContain(hash);
  });
  it("refuses a look-alike that announces the same id but can't prove it", async () => {
    const found = async () => [wisp("hub-1", "http://192.168.1.66:4998")];
    expect(await findMovedWisp(me, "http://192.168.1.20:4747", found, prover("not-the-hash"))).toBeNull();
    expect(await findMovedWisp(me, "http://192.168.1.20:4747", found, (async () => { throw new Error("refused"); }) as typeof fetch)).toBeNull();
  });
  it("leaves https addresses, unmoved Wisps and failed lookups alone", async () => {
    const discover = vi.fn(async () => [wisp("hub-1", "http://192.168.1.31:4747")]);
    expect(await findMovedWisp(me, "https://yug-mac.tail3c1.ts.net", discover, prover(hash))).toBeNull();
    expect(discover).not.toHaveBeenCalled();
    expect(await findMovedWisp(me, "http://192.168.1.31:4747", discover, prover(hash))).toBeNull();
    expect(await findMovedWisp(me, "http://192.168.1.20:4747", async () => { throw new Error("no multicast"); }, prover(hash))).toBeNull();
  });
});
