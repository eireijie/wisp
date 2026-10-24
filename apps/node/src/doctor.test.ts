import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkDoctor, connectionLogged, type DoctorConfig, type DoctorDependencies } from "./doctor.ts";

const saved: DoctorConfig = { hub: "http://localhost:4747", token: "private-key", name: "Laptop", nodeId: "n1" };
function probes(replies: Record<string, unknown> = {}): DoctorDependencies {
  return {
    fetch: vi.fn(async (url: string | URL | Request) => {
      const route = new URL(String(url)).pathname;
      const body = replies[route] ?? {
        "/healthz": { ok: true }, "/api/node/agents": [],
        "/api/reach": { publicUrl: "https://wisp.example", tailscale: { serving: true } },
      }[route];
      return new Response(JSON.stringify(body), { status: body === false ? 403 : 200 });
    }) as typeof fetch,
    running: () => true, connected: () => true, harnesses: () => ["Claude Code"], engine: async () => true,
    away: async () => ({ on: false, found: true }),
  };
}
describe("wisp doctor", () => {
  it("checks health, actual online presence, agent apps, engine and remote access", async () => {
    const deps = probes();
    const result = await checkDoctor("/tmp/wisp", saved, deps);
    expect(result).toHaveLength(5);
    expect(result.every((r) => r.ok)).toBe(true);
    const calls = vi.mocked(deps.fetch).mock.calls;
    expect(calls.find(([url]) => String(url).endsWith("/api/node/agents"))?.[1]?.headers).toEqual({ authorization: "Bearer private-key" });
    expect(calls.find(([url]) => String(url).endsWith("/healthz"))?.[1]?.headers).toEqual({});
  });
  it("gives one fix per failed check even when offline", async () => {
    const deps = probes();
    deps.fetch = async () => { throw new Error("offline"); };
    deps.harnesses = () => []; deps.engine = async () => false;
    const result = await checkDoctor("/tmp/wisp", {}, deps);
    expect(result.every((r) => !r.ok && !!r.fix)).toBe(true);
    expect(result[1].fix).toBe("Run: wisp join");
  });
  it("does not confuse a running service with a connection", async () => {
    const deps = probes(); deps.connected = () => false;
    const result = await checkDoctor("/tmp/wisp", saved, deps);
    expect(result[1].ok).toBe(false);
    expect(result[1].fix).toContain("connection");
  });
  it("offers resume when this computer is paused", async () => {
    const result = await checkDoctor("/tmp/wisp", { ...saved, paused: true }, probes());
    expect(result[1]).toMatchObject({ ok: false, fix: "Run: wisp node resume" });
  });
  it("works with legacy settings without a saved id", async () => {
    const result = await checkDoctor("/tmp/wisp", { ...saved, nodeId: undefined }, probes());
    expect(result[1].ok).toBe(true);
  });
  it("checks local Tailscale when device credentials cannot read owner settings", async () => {
    const deps = probes({ "/api/reach": false });
    deps.away = vi.fn(async () => ({ on: true, found: true }));
    const result = await checkDoctor("/tmp/wisp", saved, deps);
    expect(result[4].ok).toBe(true);
    expect(deps.away).toHaveBeenCalledOnce();
  });
  it("does not infer remote access from Tailscale on the joining computer", async () => {
    const deps = probes({ "/api/reach": false });
    deps.away = vi.fn(async () => ({ on: true, found: true }));
    const result = await checkDoctor("/tmp/wisp", { ...saved, hub: "http://192.168.1.5:4747" }, deps);
    expect(result[4].ok).toBe(false);
    expect(deps.away).not.toHaveBeenCalled();
  });
  it("reports an https invite connection as usable away from home", async () => {
    const result = await checkDoctor("/tmp/wisp", { ...saved, hub: "https://wisp.example" }, probes({ "/api/reach": false }));
    expect(result[4].ok).toBe(true);
  });
  it("recognizes a reachable Tailscale address and does not claim offline access is on", async () => {
    const deps = probes({ "/api/reach": false });
    expect((await checkDoctor("/tmp/wisp", { ...saved, hub: "http://100.64.1.2:4747" }, deps))[4]).toMatchObject({ ok: true, detail: "Using Tailscale" });
    const offline = probes({ "/healthz": false, "/api/reach": false });
    expect((await checkDoctor("/tmp/wisp", { ...saved, hub: "https://wisp.example" }, offline))[4].ok).toBe(false);
  });
  it("uses the most recent connection event from the service log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-doctor-"));
    try {
      expect(connectionLogged(dir)).toBe(false);
      const file = path.join(dir, "node.log");
      fs.writeFileSync(file, `${"old text\n".repeat(10_000)}[warren] connected to http://mac as "Laptop"\n`);
      expect(connectionLogged(dir)).toBe(true);
      fs.appendFileSync(file, "[warren] disconnected (1006); retrying in 1s\n");
      expect(connectionLogged(dir)).toBe(false);
      fs.appendFileSync(file, '[warren] connected to http://mac as "Laptop"\n');
      expect(connectionLogged(dir)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("continues if an optional engine or app probe throws", async () => {
    const deps = probes(); deps.engine = async () => { throw new Error("missing"); }; deps.harnesses = () => { throw new Error("missing"); };
    const result = await checkDoctor("/tmp/wisp", saved, deps);
    expect(result[0].ok).toBe(true); expect(result[2].ok).toBe(false); expect(result[3].ok).toBe(false);
  });
});
