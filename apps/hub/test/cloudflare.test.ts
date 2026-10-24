import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { Cloudflare, Reach, cloudflaredCandidates } from "../src/reach.ts";
import { buildHub } from "../src/app.ts";
import { issueToken } from "../src/auth.ts";

const token = "a-valid-cloudflare-credential";
function fake() {
  const children: any[] = [];
  const spawnChild = vi.fn(() => {
    const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    child.kill = vi.fn(() => setImmediate(() => child.emit("exit", null, "SIGTERM")));
    children.push(child); return child;
  });
  return { children, spawnChild, options: { spawn: spawnChild as unknown as typeof spawn } };
}
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-cloudflare-")); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Cloudflare reach", () => {
  it("finds cloudflared on each supported platform and supports an override", () => {
    expect(cloudflaredCandidates("darwin", "")).toContain("/opt/homebrew/bin/cloudflared");
    expect(cloudflaredCandidates("win32", "")).toContain("C:\\Program Files (x86)\\cloudflared\\cloudflared.exe");
    expect(cloudflaredCandidates("linux", "/tools", "/custom/cloudflared")).toEqual(["/custom/cloudflared"]);
    const cf = new Cloudflare(4747, () => false);
    expect(cf.status().state).toBe("missing");
    expect(() => cf.start(token)).toThrow(/Install cloudflared/);
  });
  it("runs with a private credential, reads connection and ingress logs, and restores across restarts", () => {
    const f = fake(), dir = temp();
    const cf = new Cloudflare(4747, () => true, f.options);
    cf.configure(dir);
    expect(cf.start(token)).toEqual({ state: "starting", url: null, error: null });
    const args = f.spawnChild.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(args[1]).toEqual(["tunnel", "--no-autoupdate", "--logformat", "json", "run"]);
    expect(args[1].join(" ")).not.toContain(token);
    expect(args[2].env.TUNNEL_TOKEN).toBe(token);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "cloudflare.json")).mode & 0o777).toBe(0o600);
    const child = f.children[0];
    const config = JSON.stringify({ ingress: [{ hostname: "other.example", service: "http://localhost:3000" }, { hostname: "wisp.example", service: "http://127.0.0.1:4747" }] });
    const log = JSON.stringify({ message: "Updated to new configuration", config }) + "\n";
    child.stderr.emit("data", Buffer.from(log.slice(0, 20)));
    child.stderr.emit("data", Buffer.from(log.slice(20)));
    expect(cf.status().url).toBeNull();
    child.stderr.emit("data", Buffer.from('{"message":"Registered tunnel connection"}\n'));
    expect(cf.status()).toEqual({ state: "running", url: "https://wisp.example", error: null });
    expect(JSON.stringify(cf.status())).not.toContain(token);
    child.stderr.emit("data", Buffer.from(JSON.stringify({ config: { ingress: [{ hostname: "wrong.example", service: "http://localhost:3000" }] } }) + "\n"));
    expect(cf.status().url).toBeNull();
    cf.close(); expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 0); expect(cf.status().state).toBe("stopped");
    const restored = new Cloudflare(4747, () => true, f.options); restored.configure(dir);
    expect(f.spawnChild).toHaveBeenCalledTimes(2);
    restored.stop(); expect(fs.existsSync(path.join(dir, "cloudflare.json"))).toBe(false);
  });
  it("reports failures safely, replaces a running process, and validates HTTPS origins", () => {
    const f = fake(), cf = new Cloudflare(4747, () => true, f.options);
    expect(() => cf.start("not valid")).toThrow(/Paste/);
    for (const url of ["http://wisp.example", "https://user:pass@wisp.example", "https://wisp.example/path"]) expect(() => cf.start(token, url)).toThrow(/HTTPS/);
    cf.start(token, "https://wisp.example");
    f.children[0].stderr.emit("data", Buffer.from('{"message":"Registered tunnel connection"}\n'));
    expect(cf.status().url).toBe("https://wisp.example");
    cf.start(token); expect(f.children[0].kill).toHaveBeenCalledOnce();
    f.children[0].emit("exit", 1); expect(cf.status().state).toBe("starting");
    f.children[1].emit("error", new Error(token));
    expect(cf.status()).toMatchObject({ state: "error", url: null });
    expect(cf.status().error).not.toContain(token);
    cf.start(token); f.children[2].emit("exit", 1); expect(cf.status().state).toBe("error");
  });
  it("exposes the connected Cloudflare origin through the shared reach API, with owner controls", async () => {
    const dir = temp(), built = await buildHub({ dataDir: dir, setupCode: false });
    const f = fake();
    built.hub.reach = new Reach(4747, async () => ({ code: 1, stdout: "", stderr: "" }), (p) => p.endsWith("cloudflared"), f.options);
    built.hub.reach.cloudflare.configure(dir);
    const call = (method: "GET" | "POST", url: string, payload?: any, auth = "") => built.app.inject({ method, url, payload, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    try {
      const setup = (await call("POST", "/api/setup", { email: "cf@example.com", name: "Owner", password: "password123" })).json();
      const member = built.hub.store.createUser("member@example.com", "Member", "");
      built.hub.store.addMember(setup.workspace.id, member.id, "member");
      const auth = issueToken(built.hub.store.db, "session", member.id, setup.workspace.id);
      expect((await call("POST", "/api/reach/cloudflare", { action: "start", token })).statusCode).toBe(401);
      expect((await call("POST", "/api/reach/cloudflare", { action: "start", token }, auth)).statusCode).toBe(403);
      expect((await call("POST", "/api/reach/cloudflare", { action: "start", token, url: "https://wisp.example" }, setup.token)).json().cloudflare.state).toBe("starting");
      f.children[0].stderr.emit("data", Buffer.from('{"message":"Registered tunnel connection"}\n'));
      const reach = (await call("GET", "/api/reach", undefined, auth)).json();
      expect(reach.publicUrl).toBe("https://wisp.example");
      expect(reach.addresses[0]).toBe("https://wisp.example");
      expect(JSON.stringify(reach)).not.toContain(token);
      expect((await call("POST", "/api/reach/cloudflare", { action: "stop" }, setup.token)).json().cloudflare.state).toBe("stopped");
    } finally { await built.app.close(); }
  });
});
