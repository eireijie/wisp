import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { buildHub } from "../src/app.ts";
import { newSetupCode } from "../src/setup-code.ts";
import { Cloudflare, Reach, type Run } from "../src/reach.ts";

// What a stranger reaching a Wisp through Tailscale Funnel or a Cloudflare Tunnel can and can't do.

const dirs: string[] = [];
const built: Awaited<ReturnType<typeof buildHub>>[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-exposed-")); dirs.push(dir); return dir; };
const hub = async (dataDir: string, setupCode?: string | false) => { const b = await buildHub({ dataDir, setupCode }); built.push(b); return b; };
afterEach(async () => {
  for (const b of built.splice(0)) await b.app.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const owner = { email: "me@example.com", name: "Me", password: "password123" };
const setup = (b: Awaited<ReturnType<typeof buildHub>>, payload: object, headers: Record<string, string> = {}) =>
  // through a tunnel, every visitor arrives from this computer itself
  b.app.inject({ method: "POST", url: "/api/setup", payload, remoteAddress: "127.0.0.1", headers });

describe("making the first account", () => {
  it("needs the setup code saved on this computer, even from localhost", async () => {
    const dir = temp(), b = await hub(dir);
    const code = fs.readFileSync(path.join(dir, "setup-code"), "utf8").trim();
    expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "setup-code")).mode & 0o777).toBe(0o600);
    expect((await b.app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ needsSetup: true, needsCode: true });

    expect((await setup(b, owner)).statusCode).toBe(403);
    expect((await setup(b, { ...owner, setupCode: newSetupCode() })).statusCode).toBe(403);
    expect(b.hub.store.userCount()).toBe(0);

    // typed with capitals or without dashes still works
    const ok = await setup(b, { ...owner, setupCode: code.toUpperCase().replace(/-/g, "") });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();
    expect(fs.existsSync(path.join(dir, "setup-code"))).toBe(false);
    expect((await b.app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ needsSetup: false, needsCode: false });
    expect((await setup(b, { ...owner, email: "x@example.com", setupCode: code })).statusCode).toBe(409);
  });

  it("keeps the same code across restarts, so a printed link still works", async () => {
    const dir = temp();
    const first = await hub(dir);
    const code = first.setupCode.code;
    await first.app.close(); built.splice(0);
    const again = await hub(dir);
    expect(again.setupCode.code).toBe(code);
  });

  it("takes a cloud server's key as a header", async () => {
    const b = await hub(temp(), "cloud-key-from-the-desktop-app");
    expect((await setup(b, owner)).statusCode).toBe(403);
    expect((await setup(b, owner, { "x-warren-setup-key": "cloud-key-from-the-desktop-app" })).statusCode).toBe(200);
  });

  it("forgets the code on a Wisp that already has an owner", async () => {
    const dir = temp();
    const b = await hub(dir, false);
    expect((await setup(b, owner)).statusCode).toBe(200);
    await b.app.close(); built.splice(0);
    fs.writeFileSync(path.join(dir, "setup-code"), "left-over-code-1234\n");
    const again = await hub(dir);
    expect(again.setupCode.required).toBe(false);
    expect(fs.existsSync(path.join(dir, "setup-code"))).toBe(false);
  });
});

describe("uploaded files", () => {
  it("only shows plain media in the browser, and never lets an upload run as Wisp", async () => {
    const b = await hub(temp(), false);
    const token = (await setup(b, owner)).json().token;
    const auth = { authorization: `Bearer ${token}` };
    const upload = async (mime: string, body: string) =>
      (await b.app.inject({ method: "POST", url: "/api/files", payload: Buffer.from(body), headers: { ...auth, "content-type": "application/octet-stream", "x-filename": "f", "x-mime-type": mime } })).json().id as string;
    const get = (id: string) => b.app.inject({ method: "GET", url: `/api/files/${id}`, headers: auth });

    const xml = await get(await upload("text/xml", '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'));
    expect(xml.headers["content-type"]).toBe("application/octet-stream");
    expect(xml.headers["content-disposition"]).toMatch(/^attachment/);
    expect(String(xml.headers["content-security-policy"])).toContain("sandbox");

    const png = await get(await upload("image/png", "not really a png"));
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["content-disposition"]).toMatch(/^inline/);
    expect(String(png.headers["content-security-policy"])).toContain("sandbox");
    expect(png.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("strangers using up memory", () => {
  it("turns away huge login emails, and git uploads without a sync token before reading them", async () => {
    const b = await hub(temp(), false);
    expect((await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a".repeat(10_000), password: "x" } })).statusCode).toBe(400);
    const push = await b.app.inject({ method: "POST", url: "/git/vault.git/git-receive-pack", payload: Buffer.alloc(1024 * 1024), headers: { "content-type": "application/x-git-receive-pack-request" } });
    expect(push.statusCode).toBe(401);
  });
});

describe("turning public access off", () => {
  const HOST = "box.tail1234.ts.net";
  const status = { BackendState: "Running", CurrentTailnet: { Name: "me" }, Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.80.1.2"], CapMap: { https: null, funnel: null } } };
  const funnel = { Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4747" } } } }, AllowFunnel: { [`${HOST}:443`]: true } };

  it("says so when Tailscale didn't actually turn it off", async () => {
    // tailscale refuses (no permission), so the funnel stays on
    const run: Run = async (_b, args) =>
      args[0] === "status" ? { code: 0, stdout: JSON.stringify(status), stderr: "" }
      : args[0] === "serve" && args[1] === "status" ? { code: 0, stdout: JSON.stringify(funnel), stderr: "" }
      : { code: 1, stdout: "", stderr: "Access denied: serve config denied" };
    const reach = new Reach(4747, run, () => true);
    expect(await reach.act("unfunnel")).toMatchObject({ funnel: true, error: expect.stringMatching(/couldn't turn off public access/) });
    expect(await reach.act("unserve")).toMatchObject({ serving: true, error: expect.stringMatching(/couldn't turn off/) });
  });

  it("waits for cloudflared to exit, forces it if it won't, and says when it still won't", async () => {
    const children: any[] = [];
    const stubborn = { value: false };
    const spawnChild = vi.fn(() => {
      const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
      child.kill = vi.fn((signal?: string) => { if (!stubborn.value || signal === "SIGKILL") setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM")); });
      children.push(child);
      return child;
    });
    const cf = new Cloudflare(4747, () => true, { spawn: spawnChild as unknown as typeof spawn, stopWaitMs: 20 });
    cf.configure(temp());

    cf.start("a-valid-cloudflare-credential");
    expect(await cf.stop()).toMatchObject({ state: "stopped" });
    expect(children[0].kill).toHaveBeenCalledTimes(1);

    stubborn.value = true;
    cf.start("a-valid-cloudflare-credential");
    expect(await cf.stop()).toMatchObject({ state: "stopped" });
    expect(children[1].kill).toHaveBeenLastCalledWith("SIGKILL");

    // a process that ignores even SIGKILL (stuck in the kernel) is reported, not hidden
    const frozen = vi.fn(() => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: vi.fn() }));
    const stuck = new Cloudflare(4747, () => true, { spawn: frozen as unknown as typeof spawn, stopWaitMs: 20 });
    stuck.start("a-valid-cloudflare-credential");
    expect(await stuck.stop()).toMatchObject({ state: "error", error: expect.stringMatching(/didn't stop/) });
  });
});
