import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WarrenClient } from "@wisp/sdk";
import { NodeDaemon, normalizeHubUrl } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";

let dir: string;
let url: string;
let nodeDir: string;
let nodeToken: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WarrenClient;
const calls: RunInput[] = [];
const logs: string[] = [];
/** lets a "slow" run finish */
let release: () => void = () => {};

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    // what it does depends on the message that woke it (the prompt's last line), not on the channel's history
    const last = input.prompt.trim().split("\n").pop() ?? "";
    // a session the harness no longer has: it fails before anything happens
    if (last.includes("stale") && input.sessionId) throw new Error("No conversation found with session ID");
    onEvent({ type: "session", id: input.sessionId ?? "sess-1" });
    onEvent({ type: "tool_call", name: "memory_search", input: {} });
    if (last.includes("explode")) throw new Error("harness crashed");
    // a run that takes as long as the test wants, and stops when cancelled
    if (last.includes("slow"))
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    return { finalText: `reply #${calls.length}`, sessionId: "sess-1" };
  },
};

const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-node-"));
  const { app } = await buildHub({ dataDir: path.join(dir, "hub") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WarrenClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  nodeToken = token;
  nodeDir = path.join(dir, "node");
  await owner.request("POST", "/api/agents", { handle: "bolt", name: "Bolt", harness: "custom", nodeId: node.id });
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: nodeDir }, (m) => logs.push(m), { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("node daemon", () => {
  it("runs the harness, posts the reply, and resumes the session", async () => {
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    await owner.send(general.id, "@bolt first");
    await waitFor(async () => (await owner.messages(general.id)).messages.find((m) => m.body === "reply #1"));
    await owner.send(general.id, "@bolt second");
    await waitFor(async () => (await owner.messages(general.id)).messages.find((m) => m.body === "reply #2"));

    expect(calls[0].sessionId).toBeNull();
    expect(calls[1].sessionId).toBe("sess-1");
    // the harness acts as its agent only, never with the device's own token
    expect(calls[0].mcp?.env.WARREN_TOKEN).toMatch(/^wr_agent_/);
    expect(calls[0].mcp?.env.WARREN_AGENT).toBeUndefined();
    expect(calls[0].cwd).toContain(path.join("agents", "bolt"));
  });

  it("reports harness failures in the channel", async () => {
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    await owner.send(general.id, "@bolt explode");
    const failed = await waitFor(async () => (await owner.messages(general.id)).messages.find((m) => m.parts.some((p) => p.type === "status" && p.text.includes("harness crashed"))));
    expect(failed).toBeTruthy();
  });

  it("passes model, effort and access, and caps full access unless the device allows it", async () => {
    const bolt = (await owner.agents()).find((a) => a.handle === "bolt")!;
    await owner.request("PATCH", `/api/agents/${bolt.id}`, { model: "opus", settings: { effort: "high", access: "full" } });
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const before = calls.length;
    await owner.send(general.id, "@bolt settings check");
    await waitFor(async () => (calls.length > before ? true : undefined));
    expect(calls.at(-1)).toMatchObject({ model: "opus", effort: "high", access: "edit" });
  });

  it("does not retry a brand-new session that fails", async () => {
    const ch = await owner.request("POST", "/api/channels", { name: "fresh" });
    const before = calls.length;
    await owner.send(ch.id, "@bolt explode");
    await waitFor(async () => (await owner.messages(ch.id)).messages.find((m) => m.parts.some((p) => p.type === "status")));
    expect(calls.length - before).toBe(1);
  });

  it("starts a fresh session only when resuming failed before anything happened", async () => {
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const failures = async () => (await owner.messages(general.id)).messages.filter((m) => m.parts.some((p) => p.type === "status" && p.text.includes("harness crashed"))).length;
    // a crash after the harness got going (it made a tool call): reported once, not run again from scratch
    const crashed = await failures();
    let before = calls.length;
    await owner.send(general.id, "@bolt explode");
    await waitFor(async () => ((await failures()) > crashed ? true : undefined));
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.slice(before).map((c) => c.sessionId)).toEqual(["sess-1"]);
    // a session the harness has lost: a fresh one, without the old id
    before = calls.length;
    await owner.send(general.id, "@bolt stale");
    await waitFor(async () => (await owner.messages(general.id)).messages.find((m) => m.body === `reply #${before + 2}`));
    expect(calls.slice(before).map((c) => c.sessionId)).toEqual(["sess-1", null]);
    expect(logs.some((l) => l.includes("resume failed before it got going"))).toBe(true);
  });

  it("takes the hub's address the way people type it", () => {
    expect(normalizeHubUrl("my-server:4747")).toBe("http://my-server:4747");
    expect(normalizeHubUrl("https://warren.example.com/")).toBe("https://warren.example.com");
    expect(normalizeHubUrl("ws://localhost:4747")).toBe("http://localhost:4747");
    expect(normalizeHubUrl(" http://10.0.0.5:4747/warren/ ")).toBe("http://10.0.0.5:4747/warren");
    expect(() => normalizeHubUrl("not a url")).toThrow(/isn't a hub address/);
    expect(() => normalizeHubUrl("")).toThrow(/isn't a hub address/);
  });

  it("reports what it has, so a connector that can't start is caught before a run", async () => {
    const box = await waitFor(async () => (await owner.request("GET", "/api/nodes")).find((n: any) => n.name === "box" && n.capabilities?.commands));
    expect(box.capabilities.commands.node).toBe(true);
    expect(box.capabilities.commands.uvx).toEqual(expect.any(Boolean));
  });

  it("says when a connector didn't start because its command isn't on the device", async () => {
    const bolt = (await owner.agents()).find((a) => a.handle === "bolt")!;
    const conn = await owner.request("POST", "/api/connectors", { kind: "mcp-stdio", name: "Widgets", command: "warren-no-such-command-xyz", args: [], agentIds: [bolt.id] });
    const ch = await owner.request("POST", "/api/channels", { name: "widgets" });
    await owner.send(ch.id, "@bolt use widgets");
    const reply = await waitFor(async () => (await owner.messages(ch.id)).messages.find((m) => m.author.id === bolt.id));
    expect(reply.parts).toContainEqual({ type: "notice", text: `Connector widgets didn't start: "warren-no-such-command-xyz" isn't installed on box.` });
    expect(calls.at(-1)!.connectors ?? []).toEqual([]);
    expect(logs.some((l) => l.includes("Connector widgets didn't start"))).toBe(true);
    await owner.request("DELETE", `/api/connectors/${conn.id}`);
  });

  it("keeps a run's result for the hub when the connection drops, and sends it once it's back", async () => {
    const general = await owner.request("POST", "/api/channels", { name: "away" });
    const n = calls.length + 1;
    await owner.send(general.id, "@bolt slow one");
    await waitFor(async () => (calls.length >= n ? true : undefined));
    // another connection with this device's token bumps the daemon off the hub
    const bump = new WebSocket(url.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${nodeToken}` } });
    await new Promise<void>((resolve) => bump.on("message", () => resolve()));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await waitFor(async () => (logs.some((l) => l.includes("will report")) ? true : undefined));
    bump.close();
    const reply = await waitFor(async () => (await owner.messages(general.id)).messages.find((m) => m.body === `reply #${n}`), 8000);
    expect(reply).toBeTruthy();
    expect(logs.some((l) => l.includes("finished while the hub was away"))).toBe(true);
  });

  it("pausing the device also stops runs that were still waiting their turn", async () => {
    const ch = await owner.request("POST", "/api/channels", { name: "pausing" });
    const n = calls.length + 1;
    await owner.send(ch.id, "@bolt slow two");
    await owner.send(ch.id, "@bolt queued three");
    await waitFor(async () => (calls.length >= n ? true : undefined));
    await fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify({ paused: true }));
    await waitFor(async () => ((await owner.request("GET", "/api/nodes")).find((x: any) => x.name === "box")?.paused === true ? true : undefined), 8000);
    const statuses = await waitFor(async () => {
      const texts = (await owner.messages(ch.id)).messages.flatMap((m) => m.parts).flatMap((p) => (p.type === "status" ? [p.text] : []));
      return texts.filter((t) => t.includes("paused")).length >= 2 ? texts : undefined;
    }, 8000);
    expect(statuses).toContain("Run failed: stopped: box was paused");
    expect(statuses).toContain("Run failed: box is paused; ask again once someone resumes it there");
    // the queued one never ran
    expect(calls.some((c) => c.prompt.includes("queued three"))).toBe(false);
    await fs.writeFile(path.join(nodeDir, "node.json"), JSON.stringify({ paused: false }));
    await waitFor(async () => ((await owner.request("GET", "/api/nodes")).find((x: any) => x.name === "box")?.paused === false ? true : undefined), 8000);
  });

  it("waits for runs in flight to report before stopping", async () => {
    const ch = await owner.request("POST", "/api/channels", { name: "stopping" });
    const n = calls.length + 1;
    await owner.send(ch.id, "@bolt slow four");
    await waitFor(async () => (calls.length >= n ? true : undefined));
    await daemon.stop();
    const status = (await owner.messages(ch.id)).messages.flatMap((m) => m.parts).find((p) => p.type === "status" && p.text.startsWith("Run failed"));
    expect(status).toEqual({ type: "status", text: "Run failed: cancelled" });
    await waitFor(async () => ((await owner.agents()).find((a) => a.handle === "bolt")?.status === "offline" ? true : undefined));
  });

  it("stops when another daemon keeps taking its place on the hub, rather than the two replacing each other forever", async () => {
    const bolt = async () => (await owner.agents()).find((a) => a.handle === "bolt")?.status;
    daemon.start(); // the test above stopped it
    await waitFor(async () => ((await bolt()) === "online" ? true : undefined));
    const bump = async () => {
      const w = new WebSocket(url.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${nodeToken}` } });
      await new Promise<void>((resolve) => w.on("message", () => resolve()));
      return w;
    };
    // once: the daemon comes back after a moment and takes its place again
    const first = await bump();
    await waitFor(async () => (first.readyState === WebSocket.CLOSED ? true : undefined), 8000);
    // twice within a minute: that's another daemon with the same token, so this one gives up
    const second = await bump();
    await waitFor(async () => (logs.some((l) => l.includes("This one stops")) ? true : undefined), 8000);
    second.close();
    await waitFor(async () => ((await bolt()) === "offline" ? true : undefined));
    await new Promise((r) => setTimeout(r, 2500));
    expect(await bolt()).toBe("offline");
  }, 20_000);
});

describe("a device that never connected", () => {
  it("gets a new connection code, and a device with the old one is told it's turned down", async () => {
    const { node, token: old } = await owner.request("POST", "/api/nodes", { name: "spare" });
    const { token } = await owner.request("POST", `/api/nodes/${node.id}/token`);
    expect(token).not.toBe(old);

    let rejected = false;
    const stale = new NodeDaemon({ hub: url, token: old, name: "spare", dir: path.join(dir, "stale") }, () => {}, { custom: fake });
    stale.onRejected = () => (rejected = true);
    stale.start();
    await waitFor(async () => rejected);

    const fresh = new NodeDaemon({ hub: url, token, name: "spare", dir: path.join(dir, "fresh") }, () => {}, { custom: fake });
    fresh.start();
    await waitFor(async () => (await owner.request<any[]>("GET", "/api/nodes")).find((n) => n.id === node.id && n.online));
    // a connected device keeps its code
    await expect(owner.request("POST", `/api/nodes/${node.id}/token`)).rejects.toThrow(/connected already/);
    await fresh.stop();
  });
});
