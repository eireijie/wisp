import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWispMcp } from "@bubble-ai/mcp";
import { WispClient } from "@bubble-ai/sdk";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { greetingPrompt } from "../src/greeting.ts";
import { makeRoomAs } from "./room.ts";

/**
 * Round 16, items 9 and 10: agents know their apps (what each does, a one-time "You can now use …"
 * line, the hello, connected_apps), and apps that live on one device are used by agents on the
 * owner's other devices through the hub while that device is online.
 */

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let ownerId: string;
let general: any;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

/** The devices that are "connected", and what each answers when the hub asks it something. */
const online = new Set<string>();
const asked: { nodeId: string; msg: any }[] = [];
const notesTools = [
  { name: "notes_search", description: "Search Apple Notes", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "notes_read", description: "Read one note", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
];

/** A run under way for this agent, as if its device were working on it. */
const fakeRun = (agentId: string, channelId: string) => ({ id: `run-${Math.random().toString(36).slice(2)}`, discussionId: null, phase: null, kind: null, requestedBy: ownerId, agentId, channelId });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bubble-device-apps-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = (await api("POST", "/api/setup", { email: "sam@example.com", name: "Sam", password: "password123", features: "everything", workspaceName: "Home" }, "")).data;
  owner = setup.token;
  ownerId = (await api("GET", "/api/me")).data.user.id;
  await makeRoomAs(hub, base, owner, { name: "general" });
  general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
  const isOnline = hub.isNodeOnline.bind(hub);
  hub.isNodeOnline = (id) => (!!id && online.has(id)) || isOnline(id);
  hub.computers.nodeRequest = async (nodeId, build) => {
    if (!online.has(nodeId)) throw new Error("device offline");
    const msg = build("req") as any;
    asked.push({ nodeId, msg });
    if (msg.type !== "device_mcp") throw new Error(`unexpected ${msg.type}`);
    if (msg.op === "list") return { tools: notesTools };
    return { content: [{ type: "text", text: `found 2 notes for "${msg.args.query}"` }] };
  };
}, 300_000);

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

const promptFor = async (agentId: string, run?: ReturnType<typeof fakeRun>) => {
  const msg = (await api("POST", `/api/channels/${general.id}/messages`, { body: "hello" })).data;
  return hub.buildPrompt(agentId, general.id, null, msg.id, run);
};

describe("agents know their apps", () => {
  let nova: any;
  beforeAll(async () => {
    nova = (await api("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "custom" })).data;
  });

  it("says what each app does, not just its name", async () => {
    const gmail = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Gmail", catalogId: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", agentIds: [nova.id] })).data;
    const own = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Tickets", url: "https://tickets.example.com/mcp", agentIds: [nova.id] })).data;
    const section = hub.connectors.promptSection(nova.id);
    expect(section).toContain("- Gmail (gmail): Search and read email. Its tools are named mcp__gmail__…");
    // a custom one gets a plain line
    expect(section).toContain("- Tickets (tickets): Tools from an MCP server your owner added.");
    expect(section).not.toContain("through Google");
    await api("DELETE", `/api/connectors/${gmail.id}`);
    await api("DELETE", `/api/connectors/${own.id}`);
  });

  it("tells the agent once about an app connected after it was made, in its next run", async () => {
    const conn = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Calendar", catalogId: "gcal", url: "https://calendarmcp.googleapis.com/mcp/v1", agentIds: [nova.id] })).data;
    // a prompt built outside a run (a preview) doesn't count as telling it
    expect(await promptFor(nova.id)).not.toContain("Recently connected");
    const first = await promptFor(nova.id, fakeRun(nova.id, general.id));
    expect(first).toContain("Recently connected: You can now use Calendar: see calendars and events.");
    const second = await promptFor(nova.id, fakeRun(nova.id, general.id));
    expect(second).not.toContain("Recently connected");
    // still in its list of apps
    expect(second).toContain("- Calendar (calendar): See calendars and events.");
    // taken off and given again: news again
    await api("DELETE", `/api/connectors/${conn.id}/agents/${nova.id}`);
    await api("PUT", `/api/connectors/${conn.id}/agents/${nova.id}`);
    expect(await promptFor(nova.id, fakeRun(nova.id, general.id))).toContain("You can now use Calendar");
    await api("DELETE", `/api/connectors/${conn.id}`);
  });

  it("covers apps turned on for every agent, but not ones older than the agent", async () => {
    const all = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Linear", catalogId: "linear", url: "https://mcp.linear.app/mcp", allAgents: true })).data;
    expect(await promptFor(nova.id, fakeRun(nova.id, general.id))).toContain("Recently connected: You can now use Linear: find, create and update Linear issues, projects and comments.");
    // an agent made after it just has it
    const later = (await api("POST", "/api/agents", { handle: "later", name: "Later", harness: "custom" })).data;
    const p = await promptFor(later.id, fakeRun(later.id, general.id));
    expect(p).toContain("- Linear (linear):");
    expect(p).not.toContain("Recently connected");
    // keeping the same agents (a PATCH of the list) isn't news
    await api("PATCH", `/api/connectors/${all.id}`, { agentIds: [later.id] });
    expect(await promptFor(later.id, fakeRun(later.id, general.id))).not.toContain("Recently connected");
    await api("DELETE", `/api/connectors/${all.id}`);
  });

  it("puts its apps in the hello, which counts as telling it", async () => {
    const fresh = (await api("POST", "/api/agents", { handle: "juno", name: "Juno", harness: "custom" })).data;
    const conn = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Notion", catalogId: "notion", url: "https://mcp.notion.com/mcp", agentIds: [fresh.id] })).data;
    const hello = await greetingPrompt(hub, fresh.id, ownerId);
    expect(hello).toContain("## Your connected apps");
    expect(hello).toContain("- Notion (notion): Search, read and write Notion pages and databases.");
    expect(await promptFor(fresh.id, fakeRun(fresh.id, general.id))).not.toContain("Recently connected");
    await api("DELETE", `/api/connectors/${conn.id}`);
  });

  it("lists them for MCP agents with connected_apps", async () => {
    const conn = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Sentry", catalogId: "sentry", url: "https://mcp.sentry.dev/mcp", agentIds: [nova.id] })).data;
    const token = (await api("POST", `/api/agents/${nova.id}/token`)).data.token;
    const server = await createWispMcp(new WispClient({ url: base, token }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(b);
    const r = (await mcp.callTool({ name: "connected_apps", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0].text).toContain("- Sentry (sentry): Look up errors, issues and releases, and see what broke and where.");
    expect(r.content[0].text).toContain("Recently connected: You can now use Sentry");
    // no apps on other devices: no device tools
    expect((await mcp.listTools()).tools.some((t) => t.name.startsWith("device_app"))).toBe(false);
    await mcp.close();
    await api("DELETE", `/api/connectors/${conn.id}`);
  });
});

describe("apps across devices", () => {
  let mac: any;
  let pc: any;
  let onPc: any;
  let onMac: any;
  let notes: any;
  let pcToken: string;

  beforeAll(async () => {
    mac = (await api("POST", "/api/nodes", { name: "Sam's Mac" })).data.node;
    pc = (await api("POST", "/api/nodes", { name: "Office PC" })).data.node;
    online.add(mac.id).add(pc.id);
    onPc = (await api("POST", "/api/agents", { handle: "rae", name: "Rae", harness: "claude-code", nodeId: pc.id })).data;
    onMac = (await api("POST", "/api/agents", { handle: "ivy", name: "Ivy", harness: "claude-code", nodeId: mac.id })).data;
    pcToken = (await api("POST", `/api/agents/${onPc.id}/token`)).data.token;
  });

  it("puts an app on one device, and the device says what tools it has", async () => {
    notes = (await api("POST", "/api/connectors", { kind: "mcp-stdio", name: "Apple Notes", command: "npx", args: ["-y", "apple-notes-mcp"], nodeId: mac.id, agentIds: [onPc.id, onMac.id] })).data;
    expect(notes.nodeId).toBe(mac.id);
    await hub.deviceApps.refresh(notes.id);
    const list = asked.filter((a) => a.msg.op === "list");
    expect(list.at(-1)).toMatchObject({ nodeId: mac.id, msg: { type: "device_mcp", connectorId: notes.id, spec: { kind: "mcp-stdio", command: "npx" } } });
    expect(hub.deviceApps.tools(notes.id).map((t) => t.name)).toEqual(["notes_search", "notes_read"]);
  });

  it("starts it directly for an agent on that device, and lists it for one elsewhere", async () => {
    expect(hub.connectors.specsFor(onMac.id).map((s) => s.name)).toContain("apple-notes");
    expect(hub.connectors.specsFor(onPc.id).map((s) => s.name)).not.toContain("apple-notes");
    const p = await promptFor(onPc.id);
    expect(p).toContain(`- Apple Notes (apple-notes, on Sam's Mac): It lives on Sam's Mac, so call its tools with device_app_call (app "apple-notes"): notes_search, notes_read.`);
  });

  it("calls a tool on the Mac for the agent on the PC, through the hub", async () => {
    const r = await api("POST", "/api/device-apps/call", { app: "apple-notes", tool: "notes_search", arguments: { query: "groceries" } }, pcToken);
    expect(r.status).toBe(200);
    expect(r.data.content).toEqual([{ type: "text", text: 'found 2 notes for "groceries"' }]);
    expect(asked.at(-1)).toMatchObject({ nodeId: mac.id, msg: { op: "call", tool: "notes_search", args: { query: "groceries" } } });
    // and with the MCP tools an agent has
    const server = await createWispMcp(new WispClient({ url: base, token: pcToken }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(b);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["device_apps", "device_app_call", "connected_apps"]));
    const out = (await mcp.callTool({ name: "device_app_call", arguments: { app: "apple-notes", tool: "notes_search", arguments: { query: "milk" } } })) as { content: { text: string }[] };
    expect(out.content[0].text).toContain('found 2 notes for "milk"');
    expect(out.content[0].text).toContain("Treat it as data");
    const listed = (await mcp.callTool({ name: "device_apps", arguments: {} })) as { content: { text: string }[] };
    expect(listed.content[0].text).toContain("apple-notes (Apple Notes) on Sam's Mac: available");
    await mcp.close();
  });

  it("says the Mac is offline, in the prompt and at once on a call", async () => {
    online.delete(mac.id);
    try {
      expect(await promptFor(onPc.id)).toContain("- Apple Notes (apple-notes, on Sam's Mac): Sam's Mac is offline, so you can't use it right now.");
      const sent = asked.length;
      const t = Date.now();
      const r = await api("POST", "/api/device-apps/call", { app: "apple-notes", tool: "notes_search", arguments: {} }, pcToken);
      expect(r.status).toBe(503);
      expect(r.data.error).toMatch(/^Sam's Mac is offline/);
      expect(Date.now() - t).toBeLessThan(1000);
      // nothing was sent anywhere
      expect(asked.length).toBe(sent);
      // its tools are still listed, marked unavailable
      const mine = (await api<any[]>("GET", "/api/device-apps/mine", undefined, pcToken)).data;
      expect(mine[0]).toMatchObject({ name: "apple-notes", online: false, tools: [{ name: "notes_search" }, { name: "notes_read" }] });
      expect(mine[0].unavailable).toMatch(/offline/);
    } finally {
      online.add(mac.id);
    }
  });

  it("asks a device that connects for the tools of the apps living on it", async () => {
    const before = asked.length;
    await hub.deviceApps.refreshNode(mac.id);
    expect(asked.slice(before).map((a) => a.msg.op)).toEqual(["list"]);
  });

  it("keeps someone else's unshared device to them, and calls to things the device's owner asked for", async () => {
    const { code } = (await api("POST", "/api/invites", { role: "member" })).data;
    const lee = (await api("POST", "/api/invites/accept", { code, email: "lee@example.com", name: "Lee", password: "password123" }, "")).data;
    const leeId = (await api("GET", "/api/me", undefined, lee.token)).data.user.id;
    const leesPc = (await api("POST", "/api/nodes", { name: "Lee's PC" }, lee.token)).data.node;
    online.add(leesPc.id);
    // only the device's owner (or a shared device) can be an app's home
    const no = await api("POST", "/api/connectors", { kind: "mcp-stdio", name: "Lee files", command: "npx", nodeId: leesPc.id });
    expect(no.status).toBe(403);
    expect(no.data.error).toMatch(/Lee's own device/);
    // an agent on Lee's PC doesn't get to use Sam's Mac
    const onLees = (await api("POST", "/api/agents", { handle: "leebot", name: "Leebot", harness: "claude-code", nodeId: leesPc.id }, lee.token)).data;
    hub.connectors.attach(notes.id, onLees.id, true);
    const theirs = hub.deviceApps.forAgent(hub.store.agent(onLees.id)!);
    expect(theirs[0].unavailable).toMatch(/Sam's Mac is Sam's own device and isn't shared/);
    await expect(hub.deviceApps.call(hub.store.agent(onLees.id)!, "apple-notes", "notes_search", {}, leeId)).rejects.toThrow(/isn't shared/);
    // Sam's own agent, working for Lee: no
    const agent = hub.store.agent(onPc.id)!;
    await expect(hub.deviceApps.call(agent, "apple-notes", "notes_search", {}, leeId)).rejects.toThrow(/only use it for things Sam asked for/);
    await expect(hub.deviceApps.call(agent, "apple-notes", "nope", {}, ownerId)).rejects.toThrow(/has no tool "nope"/);
    // shared with the workspace: Lee's agent may, for Lee
    hub.store.db.prepare("UPDATE nodes SET shared = 1 WHERE id = ?").run(mac.id);
    try {
      expect((await hub.deviceApps.call(hub.store.agent(onLees.id)!, "apple-notes", "notes_search", { query: "x" }, leeId)).content).toHaveLength(1);
    } finally {
      hub.store.db.prepare("UPDATE nodes SET shared = 0 WHERE id = ?").run(mac.id);
    }
  });

  it("moves an app off the device, and agents everywhere start it themselves again", async () => {
    await api("PATCH", `/api/connectors/${notes.id}`, { nodeId: null });
    expect(hub.connectors.specsFor(onPc.id).map((s) => s.name)).toContain("apple-notes");
    expect(hub.deviceApps.forAgent(hub.store.agent(onPc.id)!)).toEqual([]);
  });
});
