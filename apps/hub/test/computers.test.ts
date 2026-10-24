import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { ComputerSpec, DeviceCapabilities, KeyCombo, Message } from "@wisp/core";
import { vncAuthResponse } from "../src/vnc-relay.ts";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { ComputerHost } from "../../node/src/computers/index.ts";
import type { Driver, Shot } from "../../node/src/computers/driver.ts";
import { localFiles } from "../../node/src/computers/transfer.ts";
import { mkdirSync } from "node:fs";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { hashCode } from "../../node/src/screen-lock.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

// a 1x1 JPEG
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

/** Everything the fake computers were asked to do. */
const did: { computer: string; op: string; args: unknown[] }[] = [];
let rfbPort = 0;

function fakeDriver(spec: ComputerSpec): Driver {
  const log = (op: string, ...args: unknown[]) => void did.push({ computer: spec.id, op, args });
  const vmHome = path.join(dir, "vm-homes", spec.id);
  mkdirSync(vmHome, { recursive: true });
  let clip = "";
  return {
    clipboard: { get: async () => clip, set: async (t) => void (clip = t) },
    files: localFiles(vmHome),
    label: "fake",
    screenSize: async () => ({ width: 2560, height: 1600 }),
    screenshot: async (): Promise<Shot> => (log("screenshot"), { jpeg: JPEG, width: 1280, height: 800 }),
    move: async (x, y) => log("move", x, y),
    click: async (x, y, b, n) => log("click", x, y, b, n),
    mouse: async (x, y, b, down) => log("mouse", x, y, b, down),
    drag: async (x, y, tx, ty) => log("drag", x, y, tx, ty),
    scroll: async (x, y, d, n) => log("scroll", x, y, d, n),
    type: async (t) => log("type", t),
    key: async (c: KeyCombo) => log("key", c),
    open: async (t) => log("open", t),
    run: spec.kind === "vm" ? async (cmd) => (log("run", cmd), { exitCode: 0, output: `ran ${cmd}` }) : undefined,
    start: spec.kind === "vm" ? async () => log("start") : undefined,
    stop: async () => log("stop"),
    destroy: async () => log("destroy"),
    vnc: spec.kind === "vm" ? async () => net.connect(rfbPort, "127.0.0.1") : undefined,
  };
}

class FakeHost extends ComputerHost {
  private fakes = new Map<string, Driver>();
  async capabilities(): Promise<DeviceCapabilities> {
    return { platform: "linux", arch: "x64", screen: { ok: true, detail: "fake screen" }, vm: { ok: true, detail: "fake docker" } };
  }
  async driver(spec: ComputerSpec): Promise<Driver> {
    let d = this.fakes.get(spec.id);
    if (!d) this.fakes.set(spec.id, (d = fakeDriver(spec)));
    return d;
  }
}

const calls: RunInput[] = [];
/** what the fake harness does during a run, besides answering */
let duringRun: ((input: RunInput) => Promise<string | void>) | null = null;
const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input) {
    calls.push(input);
    const said = duringRun ? await duringRun(input) : undefined;
    return { finalText: said || `ok ${calls.length}`, sessionId: "s" };
  },
};

let dir: string;
let home: string;
let url: string;
let hub: Hub;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let agentApi: WispClient;
let nodeId: string;
let agentId: string;
let rfb: net.Server;
/** a fake Orgo websockify: wants the password as ?token=, then again as VNC authentication, then echoes */
let websockify: WebSocketServer;
let nodeDir: string;
let member: WispClient;
const orgoCalls: { method: string; url: string; body: any }[] = [];

const waitFor = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

const allMessages = async (): Promise<Message[]> => {
  const out: Message[] = [];
  for (const ch of await owner.channels()) out.push(...(await owner.messages(ch.id, { limit: 100 })).messages);
  return out;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-computers-"));
  // a fake VNC server: says hello like RFB, then echoes
  rfb = net.createServer((s) => {
    s.write("RFB 003.008\n");
    s.on("data", (d) => s.write(d));
  });
  await new Promise<void>((r) => rfb.listen(0, "127.0.0.1", r));
  rfbPort = (rfb.address() as net.AddressInfo).port;

  websockify = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => websockify.once("listening", r));
  websockify.on("connection", (s, req) => {
    if (new URL(req.url ?? "/", "http://x").searchParams.get("token") !== "pw/1") return s.close(4401, "bad token");
    const challenge = Buffer.from("0123456789abcdef");
    let step = 0;
    let got = Buffer.alloc(0);
    s.send("RFB 003.008\n");
    s.on("message", (d) => {
      got = Buffer.concat([got, Buffer.from(d as Buffer)]);
      if (step === 0 && got.length >= 12) {
        got = got.subarray(12);
        step = 1;
        s.send(Buffer.from([1, 2])); // one security type: VNC authentication
      }
      if (step === 1 && got.length >= 1) {
        if (got[0] !== 2) return s.close(4400, "not vnc auth");
        got = got.subarray(1);
        step = 2;
        s.send(challenge);
      }
      if (step === 2 && got.length >= 16) {
        const ok = got.subarray(0, 16).equals(vncAuthResponse(challenge, "pw/1"));
        got = got.subarray(16);
        step = 3;
        s.send(Buffer.from([0, 0, 0, ok ? 0 : 1]));
        if (!ok) return s.close(4403, "wrong password");
      }
      if (step === 3 && got.length) {
        s.send(got);
        got = Buffer.alloc(0);
      }
    });
  });

  // existing agents on the "device"
  home = path.join(dir, "home");
  await fs.mkdir(path.join(home, ".hermes", "memories"), { recursive: true });
  await fs.writeFile(path.join(home, ".hermes", "SOUL.md"), "# Mac Helper\n\nWarm and brief.");
  await fs.writeFile(path.join(home, ".hermes", "memories", "MEMORY.md"), "- The user likes short answers.");
  await fs.mkdir(path.join(home, ".claude", "agents"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\nmodel: opus\n---\nYou review pull requests carefully.");

  const built = await buildHub({ dataDir: path.join(dir, "hub") });
  hub = built.hub;
  hub.orgoWs = `ws://127.0.0.1:${(websockify.address() as net.AddressInfo).port}`;
  hub.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    orgoCalls.push({ method: init?.method ?? "GET", url: u, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (auth !== "Bearer sk_good") return json({ error: "Invalid API key" }, 401);
    if (u.endsWith("/workspaces") && init?.method === "GET") return json({ workspaces: [] });
    if (u.endsWith("/workspaces")) return json({ id: "ws-orgo" });
    if (u.endsWith("/computers") && init?.method === "POST") return json({ id: "11111111-1111-4111-8111-111111111111", name: body.name, status: "running", instance_id: "inst-1" });
    if (u.includes("/vnc-password")) return json({ password: "pw/1" });
    if (u.includes("/screenshot")) return json({ success: true, image: JPEG.toString("base64"), width: 1280, height: 800 });
    return json({ success: true });
  }) as typeof fetch;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();

  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const created = await owner.request("POST", "/api/nodes", { name: "box" });
  nodeId = created.node.id;
  const agent = await owner.request("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "custom", nodeId, settings: { respondTo: "anyone" } });
  agentId = agent.id;
  agentApi = new WispClient({ url, token: (await owner.request("POST", `/api/agents/${agentId}/token`)).token });
  nodeDir = path.join(dir, "node");
  daemon = new NodeDaemon({ hub: url, token: created.token, name: "box", dir: nodeDir, discoverHome: home }, () => {}, { custom: fake }, new FakeHost({ dir: nodeDir }));
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  rfb?.close();
  websockify?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("computers", () => {
  it("knows what each device offers and which agents already live there", async () => {
    const node = await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes")).find((n) => n.capabilities && n.discovered.length));
    // a device's own screen is off until someone at the device turns it on
    expect(node.capabilities).toMatchObject({ screen: { ok: false, off: true }, vm: { ok: true } });
    expect(node.discovered.map((d: any) => d.key).sort()).toEqual(["claude-code:reviewer", "hermes:default"]);
    // contents stay on the device until someone imports one
    expect(node.discovered[0].soul).toBeUndefined();
  });

  it("gives an agent a VM it can see and use, with coordinates from its screenshots", async () => {
    const vm = await owner.request("POST", "/api/computers", { kind: "vm", nodeId, name: "Nova's desk" });
    await owner.request("POST", "/api/members", { email: "m@example.com", name: "Mem", password: "password123", role: "member" });
    const memberToken = (await (await fetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "m@example.com", password: "password123" }) })).json()).token;
    member = new WispClient({ url, token: memberToken });
    // someone else's device takes VMs only once its owner shares it, and never a custom image from a member
    await expect(member.request("POST", "/api/computers", { kind: "vm", nodeId, name: "x" })).rejects.toThrow(/Me's device/);
    await owner.request("PATCH", `/api/nodes/${nodeId}`, { shared: true });
    await expect(member.request("POST", "/api/computers", { kind: "vm", nodeId, name: "x", image: "evil/miner" })).rejects.toThrow(/only owners/);
    await owner.request("PATCH", `/api/nodes/${nodeId}`, { shared: false });
    expect(vm).toMatchObject({ kind: "vm", transport: "vnc", online: true });
    await waitFor(async () => (await owner.request("GET", `/api/computers/${vm.id}`)).status === "ready");
    expect(did.some((d) => d.computer === vm.id && d.op === "start")).toBe(true);

    await owner.request("PATCH", `/api/agents/${agentId}`, { computerId: vm.id });
    const shot = await agentApi.computer({ action: "screenshot" });
    expect(shot).toMatchObject({ mime: "image/jpeg", width: 1280, height: 800 });
    await agentApi.computer({ action: "click", x: 100, y: 50, space: { width: 1280, height: 800 } });
    expect(did.at(-1)).toEqual({ computer: vm.id, op: "click", args: [200, 100, "left", 1] });
    await agentApi.computer({ action: "key", keys: "ctrl+L" });
    expect(did.at(-1)?.args[0]).toEqual({ mods: ["ctrl"], key: "l" });
    expect(await agentApi.computer({ action: "run", command: "ls" })).toEqual({ exitCode: 0, output: "ran ls" });
    // agents can't throw their computer away
    await expect(agentApi.computer({ action: "destroy" })).rejects.toThrow(/only people/);

    // the next run knows about the computer and works in the folder it shares with the VM
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const before = calls.length;
    await owner.send(general.id, "@nova what do you see?");
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain("## Your computer");
    expect(calls.at(-1)!.prompt).toContain("Nova's desk");
    expect(calls.at(-1)!.cwd).toContain(path.join("computers"));
    expect(calls.at(-1)!.cwd).toMatch(/files$/);
  });

  it("holds agents back while a person has control, and wakes the agent that asked for help", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    await agentApi.computerHelp("Sign in to Zendesk so I can work the support queue.");
    const card = await waitFor(async () => (await allMessages()).find((m) => m.parts.some((p) => p.type === "computer" && p.request?.includes("Zendesk"))));
    expect(card.author).toEqual({ kind: "agent", id: agentId });
    expect((await owner.request("GET", `/api/computers/${vm.id}`)).help).toMatchObject({ agentId, request: expect.stringContaining("Zendesk") });

    // people need control before they can type
    await expect(owner.request("POST", `/api/computers/${vm.id}/act`, { action: { action: "type", text: "hi" } })).rejects.toThrow(/take control/);
    await owner.request("POST", `/api/computers/${vm.id}/control`, { take: true });
    await expect(agentApi.computer({ action: "click", x: 1, y: 1 })).rejects.toThrow(/Me is using/);
    await owner.request("POST", `/api/computers/${vm.id}/act`, { action: { action: "type", text: "secret" } });
    expect(did.at(-1)).toMatchObject({ op: "type", args: ["secret"] });
    // screenshots still work, so the agent can see what's happening
    await agentApi.computer({ action: "screenshot" });

    const before = calls.length;
    await owner.request("POST", `/api/computers/${vm.id}/control`, { take: false, note: "Signed in." });
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain("@nova Signed in.");
    expect((await owner.request("GET", `/api/computers/${vm.id}`)).help).toBeNull();
    await agentApi.computer({ action: "click", x: 1, y: 1 });
  });

  it("drops a help request once the agent is working again without it", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    // someone skips the request and messages the agent instead
    await agentApi.computerHelp("Enter the 2FA code for me.");
    await waitFor(async () => (await owner.request("GET", `/api/computers/${vm.id}`)).help);
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    await owner.send(general.id, "@nova never mind, skip that site");
    await waitFor(async () => (await owner.request("GET", `/api/computers/${vm.id}`)).help === null);

    // or the agent goes ahead on the computer by itself
    await agentApi.computerHelp("Accept the cookie banner?");
    await waitFor(async () => (await owner.request("GET", `/api/computers/${vm.id}`)).help);
    await agentApi.computer({ action: "click", x: 1, y: 1 });
    expect((await owner.request("GET", `/api/computers/${vm.id}`)).help).toBeNull();
  });

  it("lets an agent take its computer back from a person who stopped using it", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    await owner.request("POST", `/api/computers/${vm.id}/control`, { take: true });
    await expect(agentApi.computer({ action: "click", x: 1, y: 1 })).rejects.toThrow(/is using/);
    // taking it again while you have it only says you're still there
    await owner.request("POST", `/api/computers/${vm.id}/control`, { take: true });
    expect((await owner.request("GET", `/api/computers/${vm.id}`)).controller).toMatchObject({ kind: "user" });

    // half a minute without touching it, and the agent that needs it gets it back
    (hub.computers as any).control.get(vm.id).touched -= 31_000;
    await agentApi.computer({ action: "click", x: 1, y: 1 });
    expect((await owner.request("GET", `/api/computers/${vm.id}`)).controller).toBeNull();
  });

  it("serves the screen as an image", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    const res = await fetch(`${url}/api/computers/${vm.id}/screen`, { headers: { authorization: `Bearer ${(owner as any).opts.token}` } });
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("moves clipboard text and files between a person's device and a VM, without taking control", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    await owner.request("PUT", `/api/computers/${vm.id}/clipboard`, { text: "héllo from my laptop" });
    expect(await owner.request("GET", `/api/computers/${vm.id}/clipboard`)).toEqual({ text: "héllo from my laptop" });

    const send = (name: string, body: Buffer, folder = "~/Desktop") =>
      fetch(`${url}/api/computers/${vm.id}/files?folder=${encodeURIComponent(folder)}`, { method: "POST", headers: { authorization: `Bearer ${(owner as any).opts.token}`, "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) }, body: new Uint8Array(body) });
    const upRes = await send("report.pdf", Buffer.from([0, 1, 2, 255]));
    const up = await upRes.json();
    expect(up).toEqual({ path: expect.any(String) });
    expect(up.path).toMatch(/Desktop[/\\]report\.pdf$/);
    // a name that's taken gets a number, never overwrites
    expect((await (await send("report.pdf", Buffer.from("again"))).json()).path).toMatch(/report \(1\)\.pdf$/);
    expect((await send("../escape.txt", Buffer.from("x"))).status).toBe(400);
    await owner.request("POST", `/api/computers/${vm.id}/files/folder`, { folder: "~", name: "Projects" });

    const home = await owner.request<any>("GET", `/api/computers/${vm.id}/files`);
    expect(home.entries.map((e: any) => [e.name, e.dir])).toEqual([["Desktop", true], ["Projects", true]]);
    expect(home.parent).toBeNull();
    const desktop = await owner.request<any>("GET", `/api/computers/${vm.id}/files?path=${encodeURIComponent("~/Desktop")}`);
    expect(desktop.entries.map((e: any) => e.name)).toEqual(["report (1).pdf", "report.pdf"]);

    const down = await fetch(`${url}/api/computers/${vm.id}/files/download?path=${encodeURIComponent(up.path)}`, { headers: { authorization: `Bearer ${(owner as any).opts.token}` } });
    expect(down.headers.get("content-disposition")).toContain("report.pdf");
    expect(Buffer.from(await down.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
    // nothing outside the computer's home folder
    await expect(owner.request("GET", `/api/computers/${vm.id}/files?path=${encodeURIComponent("/etc")}`)).rejects.toThrow(/home folder/);
    // and it shows in the computer's activity
    expect((await owner.request<any[]>("GET", `/api/computers/${vm.id}/log`)).map((l) => l.text)).toEqual(expect.arrayContaining(["Uploaded report.pdf", "Downloaded report.pdf", "Made the folder Projects"]));
  });

  it("relays a VM's VNC to the browser through the device", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    const view = await owner.request("POST", `/api/computers/${vm.id}/view`);
    expect(view).toMatchObject({ transport: "vnc", direct: false });
    const ws = new WebSocket(url.replace("http", "ws") + view.url);
    const got: Buffer[] = [];
    ws.on("message", (d) => got.push(Buffer.from(d as Buffer)));
    await new Promise((r) => ws.once("open", r));
    ws.send(Buffer.from("ping"));
    await waitFor(() => Buffer.concat(got).toString().includes("ping"));
    expect(Buffer.concat(got).toString()).toBe("RFB 003.008\nping");
    ws.close();
    // the ticket was single-use
    const again = new WebSocket(url.replace("http", "ws") + view.url);
    const code = await new Promise((r) => again.once("close", (c) => r(c)));
    expect(code).toBe(4401);
  });

  it("keeps a device's own screen to its owner, and lends it to agents only for the owner's work", async () => {
    await expect(owner.request("POST", "/api/computers", { kind: "device", nodeId })).rejects.toThrow(/wisp node screen on/);
    // `wisp node screen on`, at the device
    await fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify({ shareScreen: true }));
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.ok);
    await expect(member.request("POST", "/api/computers", { kind: "device", nodeId })).rejects.toThrow(/only Me can use its screen/);
    const screen = await owner.request("POST", "/api/computers", { kind: "device", nodeId });
    expect(screen).toMatchObject({ ownerId: expect.any(String), kind: "device" });

    // to anyone else it isn't there
    expect((await member.request<any[]>("GET", "/api/computers")).map((c) => c.id)).not.toContain(screen.id);
    await expect(member.request("GET", `/api/computers/${screen.id}`)).rejects.toThrow(/not found/);
    await expect(member.request("POST", `/api/computers/${screen.id}/view`)).rejects.toThrow(/not found/);
    await expect(member.request("POST", `/api/computers/${screen.id}/control`, { take: true })).rejects.toThrow(/not found/);
    // and they can't hand it to an agent, or change an agent that runs on someone's device
    await expect(member.request("PATCH", `/api/agents/${agentId}`, { computerId: screen.id })).rejects.toThrow(/only Me can change it/);

    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    await owner.request("PATCH", `/api/agents/${agentId}`, { computerId: screen.id });
    await expect(agentApi.computer({ action: "screenshot" })).rejects.toThrow(/isn't lent/);
    await owner.request("POST", `/api/computers/${screen.id}/lend`, { minutes: 60 });
    // an agent connected with the owner's token works for the owner
    await agentApi.computer({ action: "screenshot" });

    // a member can't ask an agent that runs on someone else's device…
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    await member.send(general.id, "@nova take a look at my screen");
    await waitFor(async () => (await allMessages()).find((m) => m.parts.some((p) => p.type === "status" && p.text.includes("only Me can ask it"))));
    // …and once the owner opens it up, it still can't use the owner's screen for them
    await owner.request("PATCH", `/api/agents/${agentId}`, { settings: { anyoneCanAsk: true } });
    let refused = "";
    duringRun = async (input) => {
      const harness = new WispClient({ url, token: input.mcp!.env.WISP_TOKEN });
      refused = await harness.computer({ action: "screenshot" }).then(() => "", (e: Error) => e.message);
    };
    const before = calls.length;
    await member.send(general.id, "@nova take a look at the screen");
    await waitFor(() => calls.length > before && refused);
    expect(refused).toMatch(/only use it for things Me asked for/);
    // for the owner it works
    refused = "";
    await owner.send(general.id, "@nova take a look at the screen");
    await waitFor(() => calls.length > before + 1);
    await waitFor(async () => !(await owner.agents()).find((a) => a.id === agentId && a.status === "busy"));
    expect(refused).toBe("");
    duringRun = null;

    const log = await owner.request<any[]>("GET", `/api/computers/${screen.id}/log`);
    expect(log.map((l) => l.text)).toEqual(expect.arrayContaining(["Looking at the screen", "Lent it to agents for 1 hour"]));
    await owner.request("POST", `/api/computers/${screen.id}/lend`, { off: true });
    await expect(agentApi.computer({ action: "screenshot" })).rejects.toThrow(/isn't lent/);
    await owner.request("PATCH", `/api/agents/${agentId}`, { computerId: vm.id, settings: { anyoneCanAsk: false } });
  });

  it("stops everything when someone pauses the device there", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    await fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify({ shareScreen: true, paused: true }));
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].paused);
    await expect(agentApi.computer({ action: "screenshot" })).rejects.toThrow(/paused/);
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const before = calls.length;
    await owner.send(general.id, "@nova are you there?");
    await waitFor(async () => (await allMessages()).find((m) => m.parts.some((p) => p.type === "status" && p.text.includes("is paused"))));
    expect(calls.length).toBe(before);
    // resuming picks the waiting request up
    await fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify({ shareScreen: true }));
    await waitFor(() => calls.length > before);
    expect((await owner.request("GET", `/api/computers/${vm.id}`)).paused).toBe(false);
  });

  it("streams a device's own screen as frames and takes input from whoever has control", async () => {
    const screen = await owner.request("POST", "/api/computers", { kind: "device", nodeId });
    expect(screen).toMatchObject({ kind: "device", transport: "frames", name: "box" });
    expect((await owner.request("POST", "/api/computers", { kind: "device", nodeId })).id).toBe(screen.id);
    const view = await owner.request("POST", `/api/computers/${screen.id}/view`);
    const ws = new WebSocket(url.replace("http", "ws") + view.url);
    const msgs: any[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await waitFor(() => msgs.find((m) => m.type === "frame"));
    expect(msgs.find((m) => m.type === "frame")).toMatchObject({ width: 1280, height: 800 });

    ws.send(JSON.stringify({ type: "input", action: { action: "click", x: 0.5, y: 0.5, space: { width: 1, height: 1 } } }));
    await waitFor(() => msgs.find((m) => m.type === "error"));
    await owner.request("POST", `/api/computers/${screen.id}/control`, { take: true });
    ws.send(JSON.stringify({ type: "input", action: { action: "click", x: 0.5, y: 0.5, space: { width: 1, height: 1 } } }));
    await waitFor(() => did.find((d) => d.computer === screen.id && d.op === "click"));
    expect(did.find((d) => d.computer === screen.id && d.op === "click")!.args).toEqual([1280, 800, "left", 1]);
    ws.close();
    await owner.request("POST", `/api/computers/${screen.id}/control`, { take: false });
  });
});

describe("approvals", () => {
  it("posts an Approve / Deny card and wakes the agent with the answer", async () => {
    const a = await agentApi.requestApproval("Send 3 intros to the Acme team", "Drafts:\n1. …");
    expect(a.status).toBe("pending");
    const card = await waitFor(async () => (await allMessages()).find((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === a.id)));
    expect(card.body).toContain("Send 3 intros");
    await expect(agentApi.request("POST", `/api/approvals/${a.id}/decide`, { approve: true })).rejects.toThrow();
    const before = calls.length;
    const decided = await owner.request("POST", `/api/approvals/${a.id}/decide`, { approve: true, note: "Use the short version." });
    expect(decided).toMatchObject({ status: "approved", note: "Use the short version." });
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain('Approved: go ahead with "Send 3 intros to the Acme team". Use the short version.');
    await expect(owner.request("POST", `/api/approvals/${a.id}/decide`, { approve: false })).rejects.toThrow(/already approved/);
  });

  it("keeps an approval between the people in the conversation it was asked in", async () => {
    const a = await agentApi.requestApproval("Delete the old drafts", "");
    await owner.request("POST", "/api/members", { email: "pat@example.com", name: "Pat", password: "password123", role: "member" });
    const login = await (await fetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pat@example.com", password: "password123" }) })).json();
    const pat = new WispClient({ url, token: login.token });
    // asked in the agent's DM with the owner: Pat isn't in it
    expect((await owner.request("GET", "/api/approvals?status=pending")).map((x: any) => x.id)).toContain(a.id);
    expect((await pat.request("GET", "/api/approvals?status=pending")).map((x: any) => x.id)).not.toContain(a.id);
    await expect(pat.request("GET", `/api/approvals/${a.id}`)).rejects.toThrow();
    await expect(pat.request("POST", `/api/approvals/${a.id}/decide`, { approve: true })).rejects.toThrow();
    expect((await owner.request("POST", `/api/approvals/${a.id}/decide`, { approve: false })).status).toBe("denied");
  });
});

describe("borrowing a device", () => {
  const nodeJson = async (cfg: object) => fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify(cfg));
  const screenOf = async () => (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "device");
  const pushed: any[] = [];
  let kai: WispClient;

  /** the agent asks, the owner answers; returns the approval */
  const ask = async (reason: string, minutes: number | null | "deny") => {
    const { approvalId } = await agentApi.requestDevice("box", reason);
    const before = calls.length;
    const body = minutes === "deny" ? { approve: false } : { approve: true, minutes };
    const decided = await owner.request("POST", `/api/approvals/${approvalId}/decide`, body);
    await waitFor(() => calls.length > before);
    return { approvalId, decided };
  };

  it("can't ask for a device whose screen is off, or that is paused", async () => {
    await nodeJson({});
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.off);
    await expect(agentApi.requestDevice("box", "enter the sales")).rejects.toThrow(/screen is off.*wisp node screen on/);
    expect(await agentApi.borrowableDevices()).toEqual([expect.objectContaining({ name: "box", owner: "Me", available: false })]);
    await expect(agentApi.requestDevice("nope", "x")).rejects.toThrow(/no device called "nope".*"box"/);
    await nodeJson({ shareScreen: true, paused: true });
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].paused);
    await expect(agentApi.requestDevice("box", "x")).rejects.toThrow(/paused.*wisp node resume/);
    await nodeJson({ shareScreen: true });
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.ok && !(await owner.request<any[]>("GET", "/api/nodes"))[0].paused);
    expect((await agentApi.borrowableDevices())[0].available).toBe(true);
  });

  it("asks the owner, who alone decides, and lends the screen to that agent only", async () => {
    hub.push.send = async (sub, payload) => void pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload as string) });
    await owner.request("POST", "/api/push/subscribe", { endpoint: "https://push.example.com/owner", keys: { p256dh: "BNcR", auth: "tBHI" } });
    kai = new WispClient({ url, token: (await owner.request("POST", `/api/agents/${(await owner.request("POST", "/api/agents", { handle: "kai", name: "Kai", harness: "custom", nodeId })).id}/token`)).token });

    const { approvalId } = await agentApi.requestDevice("Box", "Enter today's sales in the POS app");
    await expect(agentApi.requestDevice("box", "again")).rejects.toThrow(/already asked/);
    // the card is in the owner's DM with the agent, and reaches their phone
    const card = await waitFor(async () => (await allMessages()).find((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === approvalId)));
    expect(card.body).toContain("Can I use box's screen? Enter today's sales");
    expect((await owner.channels()).find((c) => c.id === card.channelId)?.kind).toBe("dm");
    await waitFor(() => pushed.find((p) => p.payload.title.includes("wants your OK")));
    const pending = await owner.request("GET", `/api/approvals/${approvalId}`);
    expect(pending.loan).toMatchObject({ deviceName: "box", reason: "Enter today's sales in the POS app" });

    // nobody else can say yes: not another member, not the agent, not another agent
    // the card is in the owner's DM, so another member doesn't even see it
    await expect(member.request("POST", `/api/approvals/${approvalId}/decide`, { approve: true, minutes: 60 })).rejects.toThrow(/not found/);
    await expect(agentApi.request("POST", `/api/approvals/${approvalId}/decide`, { approve: true })).rejects.toThrow();
    await expect(kai.request("POST", `/api/approvals/${approvalId}/decide`, { approve: true })).rejects.toThrow();
    expect((await screenOf())?.config.loan).toBeUndefined();
    await expect(agentApi.computer({ action: "screenshot" }, "box")).rejects.toThrow(/aren't borrowing "box"/);

    const before = calls.length;
    const decided = await owner.request("POST", `/api/approvals/${approvalId}/decide`, { approve: true, minutes: 15, note: "Back by 4." });
    expect(decided.status).toBe("approved");
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain('Approved: you can use "box" for 15 minutes');
    expect(calls.at(-1)!.prompt).toContain('computer: "box"');

    const screen = await screenOf();
    const until = new Date(screen.config.loan.until).getTime();
    expect(screen.config.loan).toMatchObject({ agentId });
    expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);

    // with `computer` it acts on the device; without, on the agent's own VM
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    await agentApi.computer({ action: "click", x: 10, y: 10, space: { width: 1280, height: 800 } }, "box");
    expect(did.at(-1)).toMatchObject({ computer: screen.id, op: "click" });
    await agentApi.computer({ action: "click", x: 10, y: 10, space: { width: 1280, height: 800 } });
    expect(did.at(-1)).toMatchObject({ computer: vm.id, op: "click" });
    // a borrowed screen is a screen, not a shell, and it isn't kai's
    await expect(agentApi.computer({ action: "run", command: "ls" }, "box")).rejects.toThrow(/screen, not a shell/);
    await expect(kai.computer({ action: "screenshot" }, "box")).rejects.toThrow(/aren't borrowing/);
    // and the prompt says what's on loan
    expect(hub.borrowSection(agentId)).toContain('borrowing right now: "box"');
    const log = await owner.request<any[]>("GET", `/api/computers/${screen.id}/log`);
    expect(log.map((l) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^Lent it to @nova until/), "Clicking"]));
    // nobody else can have it meanwhile
    await expect(kai.requestDevice("box", "x")).rejects.toThrow(/lent to @nova until/);

    // the owner can take control (the agent waits), and hand back; the loan goes on
    await owner.request("POST", `/api/computers/${screen.id}/control`, { take: true });
    await expect(agentApi.computer({ action: "click", x: 1, y: 1, space: { width: 1280, height: 800 } }, "box")).rejects.toThrow(/is using box right now/);
    await owner.request("POST", `/api/computers/${screen.id}/control`, { take: false });
    await agentApi.computer({ action: "screenshot" }, "box");

    // the agent hands it back
    await expect(kai.returnDevice()).rejects.toThrow(/aren't borrowing/);
    expect(await agentApi.returnDevice()).toMatchObject({ deviceName: "box" });
    expect((await screenOf()).config.loan).toBeUndefined();
    await expect(agentApi.computer({ action: "screenshot" }, "box")).rejects.toThrow(/aren't borrowing/);
    expect((await owner.request<any[]>("GET", `/api/computers/${screen.id}/log`)).map((l) => l.text)).toContain("@nova handed it back");
  });

  it("ends by itself when the time is up, and tells the agent", async () => {
    await ask("Check the till report", 1);
    const screen = await screenOf();
    expect(screen.config.loan).toBeTruthy();
    // time runs out: use is refused right away, even before anything sweeps
    hub.store.updateComputer(screen.id, { config: { ...screen.config, loan: { ...screen.config.loan, until: new Date(Date.now() - 1000).toISOString() } } });
    const before = calls.length;
    await expect(agentApi.computer({ action: "screenshot" }, "box")).rejects.toThrow(/aren't borrowing|time on box is up/);
    expect((await screenOf()).config.loan).toBeUndefined();
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain('Your time on "box" is up');

    // a sweep also ends loans nobody tried to use
    await ask("Again", 5);
    const again = await screenOf();
    hub.store.updateComputer(again.id, { config: { ...again.config, loan: { ...again.config.loan, until: new Date(Date.now() - 1000).toISOString() } } });
    const mark = calls.length;
    hub.computers.sweepLoans();
    expect((await screenOf()).config.loan).toBeUndefined();
    await waitFor(() => calls.length > mark);
    expect(calls.at(-1)!.prompt).toContain("is up");
  });

  it("lets the owner take it back at any moment, and ends it if the screen is turned off", async () => {
    await ask("Print the invoice", null);
    const screen = await screenOf();
    // "until it hands it back" is still capped
    expect(new Date(screen.config.loan.until).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600_000);
    await expect(member.request("POST", `/api/computers/${screen.id}/loan/end`)).rejects.toThrow(/not found/);
    const before = calls.length;
    await owner.request("POST", `/api/computers/${screen.id}/loan/end`);
    expect((await screenOf()).config.loan).toBeUndefined();
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain('Me took "box" back');
    await expect(agentApi.computer({ action: "screenshot" }, "box")).rejects.toThrow(/aren't borrowing/);

    // "Stop lending" also covers a loan
    await ask("One more", 30);
    await owner.request("POST", `/api/computers/${screen.id}/lend`, { off: true });
    expect((await screenOf()).config.loan).toBeUndefined();

    // turning the screen off at the device ends it
    await ask("Last one", 30);
    await nodeJson({});
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.off);
    await expect(agentApi.computer({ action: "screenshot" }, "box")).rejects.toThrow(/screen off|turned off/);
    expect((await screenOf()).config.loan).toBeUndefined();
    await nodeJson({ shareScreen: true });
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.ok);
  });

  it("tells the agent when the owner says no", async () => {
    const { decided } = await ask("Look around", "deny");
    expect(decided.status).toBe("denied");
    expect(calls.at(-1)!.prompt).toContain('Denied: Me didn\'t lend you "box"');
    expect((await screenOf()).config.loan).toBeUndefined();
  });
});

describe("a screen's code", () => {
  const nodeJson = async (cfg: object) => fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify(cfg));
  // the device's own screen (made once, then the same one comes back)
  const screenOf = async () => owner.request("POST", "/api/computers", { kind: "device", nodeId });

  it("opens the screen only with the code picked at the device, which the device checks", async () => {
    await nodeJson({ shareScreen: true, screenCode: hashCode("pin", "246810") });
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.code === "pin");
    const screen = await screenOf();

    // signed in as its owner isn't enough
    await expect(owner.request("POST", `/api/computers/${screen.id}/view`)).rejects.toThrow(/Enter box's PIN/);
    await expect(owner.request("POST", `/api/computers/${screen.id}/view`, { code: "111111" })).rejects.toThrow(/Wrong PIN. 4 tries left/);
    await expect(owner.request("GET", `/api/computers/${screen.id}/screen?maxAge=1000`)).rejects.toThrow(/locked with its code/);
    const view = await owner.request("POST", `/api/computers/${screen.id}/view`, { code: "246810" });
    const ws = new WebSocket(url.replace("http", "ws") + view.url);
    const msgs: any[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await waitFor(() => msgs.find((m) => m.type === "frame"));
    // while it's open, its thumbnail works too; once the viewer leaves, the device closes it again
    await owner.request("GET", `/api/computers/${screen.id}/screen?maxAge=1000`);
    ws.close();
    await waitFor(() => owner.request("GET", `/api/computers/${screen.id}/screen?maxAge=1000`).then(() => false, (e: Error) => /locked/.test(e.message)));
  });

  it("needs the code to lend it, or to let an agent borrow it", async () => {
    const screen = await screenOf();
    await expect(owner.request("POST", `/api/computers/${screen.id}/lend`, { minutes: 30 })).rejects.toThrow(/Enter box's PIN/);
    await owner.request("POST", `/api/computers/${screen.id}/lend`, { minutes: 30, code: "246810" });
    expect((await screenOf()).config.lend.until).toBeTruthy();
    await owner.request("POST", `/api/computers/${screen.id}/lend`, { off: true });

    const { approvalId } = await agentApi.requestDevice("box", "Check the shop's sales");
    await expect(owner.request("POST", `/api/approvals/${approvalId}/decide`, { approve: true, minutes: 15 })).rejects.toThrow(/Enter box's PIN/);
    expect((await owner.request("GET", `/api/approvals/${approvalId}`)).status).toBe("pending");
    const before = calls.length;
    await owner.request("POST", `/api/approvals/${approvalId}/decide`, { approve: true, minutes: 15, code: "246810" });
    await waitFor(() => calls.length > before);
    await agentApi.computer({ action: "screenshot" }, "box");
    // taking it back closes it at the device too
    await owner.request("POST", `/api/computers/${screen.id}/loan/end`);
    await waitFor(() => owner.request("GET", `/api/computers/${screen.id}/screen?maxAge=1000`).then(() => false, (e: Error) => /locked/.test(e.message)));
  });

  it("stops taking codes after too many wrong ones, and tells its owner", async () => {
    const screen = await screenOf();
    for (let i = 0; i < 4; i++) await expect(owner.request("POST", `/api/computers/${screen.id}/view`, { code: "000000" })).rejects.toThrow(/Wrong PIN/);
    await expect(owner.request("POST", `/api/computers/${screen.id}/view`, { code: "000000" })).rejects.toThrow(/Too many wrong codes/);
    await expect(owner.request("POST", `/api/computers/${screen.id}/view`, { code: "246810" })).rejects.toThrow(/Too many wrong codes/);
    await waitFor(async () => (await owner.request<any[]>("GET", `/api/computers/${screen.id}/log`)).find((l) => /stopped taking codes/.test(l.text)));
    // done: no code again, and the count cleared
    await fs.rm(path.join(nodeDir, "screen-lock.json"), { force: true });
    await nodeJson({ shareScreen: true });
    await waitFor(async () => !(await owner.request<any[]>("GET", "/api/nodes"))[0].capabilities?.screen.code);
  });
});

describe("routines", () => {
  it("runs a routine on its schedule, once per minute, with its steps in the prompt", async () => {
    const r = await owner.request("POST", "/api/routines", { agentId, name: "Weekly reporting", steps: "1. Open the dashboard\n2. Export the CSV", schedule: "30 9 * * 1", timezone: "America/New_York" });
    expect(r).toMatchObject({ status: "ready", schedule: "30 9 * * 1" });
    await expect(owner.request("POST", "/api/routines", { agentId, name: "Bad", steps: "x", schedule: "every day" })).rejects.toThrow(/valid schedule/);

    const before = calls.length;
    // Monday 2026-10-12 09:30 in New York is 13:30 UTC
    await hub.routines.tick(new Date("2026-10-12T13:30:20Z"));
    await hub.routines.tick(new Date("2026-10-12T13:30:50Z"));
    await hub.routines.tick(new Date("2026-10-12T13:31:10Z"));
    await waitFor(() => calls.length > before);
    await new Promise((res) => setTimeout(res, 200));
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)!.prompt).toContain("## Routine to run now: Weekly reporting");
    expect(calls.at(-1)!.prompt).toContain("Export the CSV");
  });

  it("learns a routine from a person's recording", async () => {
    const vm = (await owner.request<any[]>("GET", "/api/computers")).find((c) => c.kind === "vm");
    const before = calls.length;
    const r = await owner.request("POST", "/api/routines/teach", {
      agentId,
      name: "File expenses",
      computerId: vm.id,
      durationMs: 52_000,
      narration: "Receipts are in the shared inbox.",
      steps: [
        { at: 1200, kind: "click", x: 40, y: 80, element: { url: "https://expenses.example.com/", role: "button", name: "New expense", selector: "#new" } },
        { at: 4000, kind: "type", text: "receipts" },
        { at: 5000, kind: "key", keys: "Enter" },
      ],
    });
    expect(r).toMatchObject({ status: "learning", notePath: `agents/${agentId}/routines/file-expenses.md` });
    const rec = await owner.readNote(`agents/${agentId}/routines/file-expenses.recording.md`);
    expect(rec.content).toContain('2. [0:04] typed "receipts"');
    // what was clicked on a web page, not only where
    expect(rec.content).toContain('1. [0:01] clicked at (40, 80) on the button "New expense" (#new) at https://expenses.example.com/');
    expect(rec.content).toContain("Receipts are in the shared inbox.");
    await waitFor(() => calls.length > before);
    expect(calls.at(-1)!.prompt).toContain("## Learning a routine: File expenses");
    // a routine that's still being learned can't run
    await expect(owner.request("POST", `/api/routines/${r.id}/run`)).rejects.toThrow(/still learning/);

    const saved = await agentApi.saveRoutine({ routineId: r.id, steps: "1. Open the shared inbox\n2. Search for receipts" });
    expect(saved.status).toBe("ready");
    expect((await owner.readNote(r.notePath)).content).toContain("Search for receipts");
    const ran = await owner.request("POST", `/api/routines/${r.id}/run`);
    expect(ran.ok).toBe(true);
  });
});

describe("importing existing agents", () => {
  it("brings a Hermes agent in with its soul and notes", async () => {
    const a = await owner.request("POST", "/api/agents/import", { nodeId, key: "hermes:default", handle: "machelper" });
    expect(a).toMatchObject({ handle: "machelper", name: "Mac Helper", harness: "hermes", nodeId });
    expect((await owner.readNote(`agents/${a.id}/SOUL.md`)).content).toContain("Warm and brief.");
    expect((await owner.readNote(`agents/${a.id}/imported/MEMORY.md`)).content).toContain("likes short answers");
    const sub = await owner.request("POST", "/api/agents/import", { nodeId, key: "claude-code:reviewer", handle: "reviewer" });
    expect(sub).toMatchObject({ harness: "claude-code", model: "opus", instructions: "You review pull requests carefully." });
    await expect(owner.request("POST", "/api/agents/import", { nodeId, key: "hermes:nope", handle: "nope" })).rejects.toThrow(/isn't on this device/);
  });
});

describe("Orgo", () => {
  it("checks the key, makes a cloud computer, and drives it with the hub's key", async () => {
    await expect(owner.request("POST", "/api/computers", { kind: "orgo", name: "Cloud" })).rejects.toThrow(/Orgo API key/);
    await expect(owner.request("PUT", "/api/settings/computers", { orgoApiKey: "sk_bad" })).rejects.toThrow(/didn't accept/);
    expect(await owner.request("PUT", "/api/settings/computers", { orgoApiKey: "sk_good" })).toMatchObject({ orgo: { configured: true, hint: "…good" }, defaults: { vmSize: "medium", controlIdleMinutes: 10 } });

    const cloud = await owner.request("POST", "/api/computers", { kind: "orgo", name: "Cloud" });
    expect(cloud).toMatchObject({ kind: "orgo", online: true, transport: "vnc", config: { computerId: "11111111-1111-4111-8111-111111111111", instanceId: "inst-1" } });
    const scout = await owner.request("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "custom", nodeId, computerId: cloud.id });
    const scoutApi = new WispClient({ url, token: (await owner.request("POST", `/api/agents/${scout.id}/token`)).token });
    await scoutApi.computer({ action: "click", x: 640, y: 400, space: { width: 1280, height: 800 }, double: true });
    expect(orgoCalls.at(-1)).toMatchObject({ method: "POST", url: expect.stringContaining("/computers/11111111-1111-4111-8111-111111111111/click"), body: { x: 640, y: 400, button: "left", double: true } });
    await scoutApi.computer({ action: "key", keys: "Enter" });
    expect(orgoCalls.at(-1)!.body).toEqual({ key: "Return" });

    // the live view goes through the hub, which signs in to the screen itself: neither the API key nor the VNC password reaches browsers
    const view = await owner.request("POST", `/api/computers/${cloud.id}/view`);
    expect(view).toMatchObject({ transport: "vnc", direct: false, url: expect.stringMatching(new RegExp(`^/ws/computers/${cloud.id}/vnc\\?ticket=`)) });
    expect(JSON.stringify(view)).not.toContain("pw");
    expect(JSON.stringify(await owner.request("GET", "/api/computers"))).not.toContain("sk_good");
    const ws = new WebSocket(url.replace("http", "ws") + view.url);
    const frames: Buffer[] = [];
    ws.on("message", (d) => frames.push(Buffer.from(d as Buffer)));
    const next = (n: number) => waitFor(() => (frames.length >= n ? frames[n - 1] : undefined));
    expect((await next(1)).toString()).toBe("RFB 003.008\n");
    ws.send("RFB 003.008\n");
    expect([...(await next(2))]).toEqual([1, 1]); // no password asked of the browser
    ws.send(Buffer.from([1]));
    expect([...(await next(3))]).toEqual([0, 0, 0, 0]);
    ws.send(Buffer.from("ping"));
    expect((await next(4)).toString()).toBe("ping"); // through to the screen and back
    ws.close();

    await owner.request("DELETE", `/api/computers/${cloud.id}`);
    expect(orgoCalls.at(-1)).toMatchObject({ method: "DELETE" });
    expect((await owner.agents()).find((a) => a.id === scout.id)!.computerId).toBeNull();
  });
});
