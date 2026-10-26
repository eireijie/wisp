import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { FEATURE_PRESETS } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
/** the owner's sign-in, in the first organization */
let owner: string;
let firstOrg: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function start() {
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
}

const login = async (email: string) => (await api<{ token: string }>("POST", "/api/auth/login", { email, password: "password123" }, "")).data.token;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-orgs-"));
  await start();
  const setup = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", workspaceName: "Home" }, "")).data;
  owner = setup.token;
  firstOrg = setup.workspace.id;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("features", () => {
  it("starts a new organization with the simple set, and /api/me carries it", async () => {
    expect((await api("GET", "/api/features")).data).toEqual({ features: FEATURE_PRESETS.simple });
    expect((await api("GET", "/api/me")).data.features).toEqual(FEATURE_PRESETS.simple);
  });

  it("lets only owners change them, and tells everyone in the organization", async () => {
    const m = (await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123" })).data;
    expect(m.id).toBeTruthy();
    const sam = await login("sam@example.com");
    expect((await api("PUT", "/api/features", { routines: true }, sam)).status).toBe(403);
    expect((await api("PUT", "/api/features", { nope: true })).status).toBe(400);

    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    const events: any[] = [];
    ws.on("message", (d) => events.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "auth", token: sam }));
    await new Promise((r) => setTimeout(r, 100));
    const r = await api("PUT", "/api/features", { routines: true, tasks: true });
    expect(r.data.features).toEqual({ ...FEATURE_PRESETS.simple, routines: true, tasks: true });
    // only what was sent changes
    expect((await api("PUT", "/api/features", { tasks: false })).data.features).toEqual({ ...FEATURE_PRESETS.simple, routines: true });
    for (let i = 0; i < 40 && !events.some((e) => e.type === "features"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(events.find((e) => e.type === "features")?.features).toMatchObject({ routines: true });
    ws.close();
  });

  it("keeps everything on for an organization from before features existed", async () => {
    const saved = hub.store.setting(firstOrg, "features");
    hub.store.setSetting(firstOrg, "features", null);
    expect((await api("GET", "/api/features")).data.features).toEqual(FEATURE_PRESETS.everything);
    hub.store.setSetting(firstOrg, "features", saved);
  });

  it("refuses invites while Invite people is off", async () => {
    const off = await api("POST", "/api/invites", { role: "member" });
    expect(off.status).toBe(403);
    expect(off.data.error).toMatch(/Invite people/);
    await api("PUT", "/api/features", { invite: true });
    expect((await api("POST", "/api/invites", { role: "member" })).status).toBe(200);
    await api("PUT", "/api/features", { invite: false });
  });

  it("holds routine schedules and background checks while their features are off", async () => {
    const agent = (await api("POST", "/api/agents", { handle: "sched", name: "Sched", harness: "custom" })).data;
    const r = (await api("POST", "/api/routines", { agentId: agent.id, name: "Morning", steps: "say hi", schedule: "30 9 * * 1", timezone: "UTC" })).data;
    await api("PUT", "/api/features", { routines: false });
    await hub.routines.tick(new Date("2026-10-12T09:30:20Z"));
    expect(hub.store.routine(r.id)!.lastRunAt).toBeNull();
    await api("PUT", "/api/features", { routines: true });
    await hub.routines.tick(new Date("2026-10-12T09:30:40Z"));
    expect(hub.store.routine(r.id)!.lastRunAt).toBeTruthy();

    const me = (await api("GET", "/api/me")).data.user.id;
    for (const x of hub.store.activeRuns(agent.id)) hub.cancelRun(x.id);
    hub.store.setBackground(agent.id, me, { enabled: true });
    hub.background.tick(new Date("2026-10-14T12:00:00Z"));
    expect(hub.store.activeRuns(agent.id)).toHaveLength(0);
    await api("PUT", "/api/features", { background: true });
    hub.background.tick(new Date("2026-10-14T12:00:00Z"));
    expect(hub.store.activeRuns(agent.id)).toHaveLength(1);
    hub.store.setBackground(agent.id, me, { enabled: false });
    for (const x of hub.store.activeRuns(agent.id)) hub.cancelRun(x.id);
    await api("PUT", "/api/features", { background: false, routines: false });
  });
});

describe("agent defaults", () => {
  it("uses the latest agent's harness until an owner saves defaults, and fills in a new agent with them", async () => {
    // the "sched" agent above runs the custom harness; no devices, so no VM
    expect((await api("GET", "/api/settings/agent-defaults")).data).toEqual({ harness: "custom", model: null, computer: "none", nodeId: null });
    const sam = await login("sam@example.com");
    expect((await api("PUT", "/api/settings/agent-defaults", { harness: "codex" }, sam)).status).toBe(403);
    expect((await api("PUT", "/api/settings/agent-defaults", { harness: "codex", model: "gpt-6" })).data).toMatchObject({ harness: "codex", model: "gpt-6", computer: "none" });
    expect((await api("PUT", "/api/settings/agent-defaults", { nodeId: "node_nope" })).status).toBe(400);

    const a = (await api("POST", "/api/agents", { handle: "dflt", name: "Dflt", useDefaults: true })).data;
    expect(a).toMatchObject({ harness: "codex", model: "gpt-6", computerId: null });
    expect(a.settings).toMatchObject({ headless: true, respondTo: "me" });
    // what you pick wins over the defaults
    expect((await api("POST", "/api/agents", { handle: "picked", name: "Picked", harness: "claude-code", useDefaults: true })).data).toMatchObject({ harness: "claude-code", model: null });
    // without defaults a harness is still needed
    expect((await api("POST", "/api/agents", { handle: "nohar", name: "No" })).status).toBe(400);
  });

  it("saves model IDs up to the shared catalog limit", async () => {
    const model = "m".repeat(150);
    expect((await api("PUT", "/api/settings/agent-defaults", { model })).status).toBe(200);
    expect((await api("GET", "/api/settings/agent-defaults")).data.model).toBe(model);
    expect((await api("PUT", "/api/settings/agent-defaults", { model: "m".repeat(201) })).status).toBe(400);
  });
});

describe("who an agent answers", () => {
  let sam: string;
  let general: string;
  const runs = (agentId: string) => hub.store.activeRuns(agentId).length;
  const say = async (body: string, token: string) => {
    await api("POST", `/api/channels/${general}/messages`, { body }, token);
    await new Promise((r) => setTimeout(r, 30));
  };

  beforeAll(async () => {
    sam = await login("sam@example.com");
    general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general").id;
  });

  it("answers only whoever made it by default, quietly ignoring others", async () => {
    const mine = (await api("POST", "/api/agents", { handle: "mine", name: "Mine", harness: "custom" })).data;
    expect(mine.settings).toMatchObject({ respondTo: "me", createdBy: expect.any(String) });
    const before = (await api<{ messages: any[] }>("GET", `/api/channels/${general}/messages`)).data.messages.length;
    await say("@mine hello from sam", sam);
    expect(runs(mine.id)).toBe(0);
    // nothing is posted about it (only Sam's own message)
    expect((await api<{ messages: any[] }>("GET", `/api/channels/${general}/messages`)).data.messages.length).toBe(before + 1);
    await say("@mine hello from alex", owner);
    expect(runs(mine.id)).toBe(1);
    // a DM from someone else doesn't wake it either
    const dm = (await api("POST", `/api/dm/${mine.id}`, undefined, sam)).data;
    await api("POST", `/api/channels/${dm.id}/messages`, { body: "psst" }, sam);
    await new Promise((r) => setTimeout(r, 30));
    expect(runs(mine.id)).toBe(1);
  });

  it("answers chosen people, or anyone, once its maker says so; others can't change that", async () => {
    const helper = (await api("POST", "/api/agents", { handle: "helper", name: "Helper", harness: "custom" })).data;
    const samId = (await api("GET", "/api/me", undefined, sam)).data.user.id;
    expect((await api("PATCH", `/api/agents/${helper.id}`, { settings: { respondTo: "anyone" } }, sam)).status).toBe(403);
    expect((await api("PATCH", `/api/agents/${helper.id}`, { settings: { respondTo: "people", respondPeople: ["usr_nobody"] } })).status).toBe(400);
    const p = await api("PATCH", `/api/agents/${helper.id}`, { settings: { respondTo: "people", respondPeople: [samId], createdBy: samId } });
    // who made it can't be rewritten
    expect(p.data.settings.createdBy).toBe(helper.settings.createdBy);
    await say("@helper hi from sam", sam);
    expect(runs(helper.id)).toBe(1);
    await say("@helper hi from alex", owner);
    expect(runs(helper.id)).toBe(2);

    const open = (await api("POST", "/api/agents", { handle: "open", name: "Open", harness: "custom", settings: { respondTo: "anyone" } })).data;
    await say("@open hi from sam", sam);
    expect(runs(open.id)).toBe(1);
  });

  it("answers anyone when it has no setting (agents from before), and the owners when nobody made it", async () => {
    const old = (await api("POST", "/api/agents", { handle: "old", name: "Old", harness: "custom" })).data;
    hub.store.db.prepare("UPDATE agents SET settings_json = '{}' WHERE id = ?").run(old.id);
    await say("@old hi from sam", sam);
    expect(runs(old.id)).toBe(1);
    hub.store.db.prepare(`UPDATE agents SET settings_json = '{"respondTo":"me"}' WHERE id = ?`).run(old.id);
    await say("@old again from sam", sam);
    expect(runs(old.id)).toBe(1);
    await say("@old hi from the owner", owner);
    expect(runs(old.id)).toBe(2);
  });
});

describe("organizations", () => {
  let second: { id: string; name: string };
  let secondToken: string;

  it("makes a new organization with its owner, #general, the simple features and its own memory", async () => {
    const r = await api("POST", "/api/orgs", { name: "Side project" });
    expect(r.status).toBe(200);
    second = r.data.org;
    secondToken = r.data.token;
    // the token used to make it moved to the new organization
    expect((await api("GET", "/api/me")).status).toBe(401);
    owner = await login("me@example.com");
    // signing in again goes back to where you were last
    expect((await api("GET", "/api/me")).data.workspace.id).toBe(second.id);

    const me = (await api("GET", "/api/me", undefined, secondToken)).data;
    expect(me).toMatchObject({ role: "owner", workspace: { id: second.id, name: "Side project" }, features: FEATURE_PRESETS.simple });
    expect((await api<any[]>("GET", "/api/channels", undefined, secondToken)).data.map((c) => c.name)).toEqual(["general"]);
    expect((await api<any[]>("GET", "/api/agents", undefined, secondToken)).data).toEqual([]);
    expect((await api<any[]>("GET", "/api/vault/notes", undefined, secondToken)).data.map((n) => n.path)).toEqual(["shared/Welcome.md"]);
    expect(hub.vault(second.id).root).toBe(path.join(dir, "orgs", second.id, "vault"));
    expect(hub.vault(firstOrg).root).toBe(path.join(dir, "vault"));
    await expect(fs.stat(path.join(dir, "orgs", second.id, "vault", ".git"))).resolves.toBeTruthy();
  });

  it("lists the organizations you're in, and switches between them", async () => {
    const list = (await api<any[]>("GET", "/api/orgs", undefined, secondToken)).data;
    expect(list).toEqual([
      { id: firstOrg, name: "Home", role: "owner", members: 2, agents: expect.any(Number), current: false, unread: expect.any(Boolean), canDelete: false },
      { id: second.id, name: "Side project", role: "owner", members: 1, agents: 0, current: true, unread: false, canDelete: true },
    ]);
    const back = (await api("POST", `/api/orgs/${firstOrg}/switch`, undefined, secondToken)).data.token;
    expect((await api("GET", "/api/me", undefined, back)).data.workspace.id).toBe(firstOrg);
    expect((await api("GET", "/api/me", undefined, secondToken)).status).toBe(401);
    secondToken = (await api("POST", `/api/orgs/${second.id}/switch`, undefined, back)).data.token;
    // Sam isn't in the second one
    const sam = await login("sam@example.com");
    expect((await api("POST", `/api/orgs/${second.id}/switch`, undefined, sam)).status).toBe(403);
    expect((await api<any[]>("GET", "/api/orgs", undefined, sam)).data.map((o) => o.id)).toEqual([firstOrg]);
  });

  it("keeps agents, channels and memory apart", async () => {
    const home = await api("POST", `/api/orgs/${firstOrg}/switch`, undefined, owner);
    owner = home.data.token;
    const a = (await api("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "custom" }, secondToken)).data;
    // the same handle is free in the other organization
    expect((await api("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "custom" })).status).toBe(200);
    expect((await api(`PATCH`, `/api/agents/${a.id}`, { name: "Nope" })).status).toBe(404);
    expect((await api("POST", "/api/channels", { name: "side-only" }, secondToken)).status).toBe(200);
    expect((await api<any[]>("GET", "/api/channels")).data.map((c) => c.name)).not.toContain("side-only");

    await api("PUT", "/api/vault/note", { path: "shared/secret-plan.md", content: "# Secret plan\n\nlaunch on friday" }, secondToken);
    expect((await api<any[]>("GET", "/api/vault/notes")).data.map((n) => n.path)).not.toContain("shared/secret-plan.md");
    expect((await api<any[]>("GET", "/api/vault/search?q=friday")).data).toEqual([]);
    expect((await api<any[]>("GET", "/api/vault/search?q=friday", undefined, secondToken)).data.map((h) => h.path)).toEqual(["shared/secret-plan.md"]);
    expect((await api("GET", "/api/vault/note?path=shared/secret-plan.md")).status).toBe(404);
    // the agent's soul went to its own organization's memory
    await expect(hub.vault(second.id).read(`agents/${a.id}/SOUL.md`)).resolves.toBeTruthy();
    await expect(hub.vault(firstOrg).read(`agents/${a.id}/SOUL.md`)).rejects.toThrow();
    // its built-in memory skill lives in its own organization's memory too
    await expect(hub.vault(second.id).read(`agents/${a.id}/skills/memory/SKILL.md`)).resolves.toBeTruthy();
    await expect(hub.vault(firstOrg).read(`agents/${a.id}/skills/memory/SKILL.md`)).rejects.toThrow();
  });

  it("lets someone already signed in join another organization with an invite", async () => {
    await api("PUT", "/api/features", { invite: true }, secondToken);
    const inv = (await api("POST", "/api/invites", { role: "member" }, secondToken)).data;
    const sam = await login("sam@example.com");
    expect((await api("POST", "/api/invites/join", { code: "bogus" }, sam)).status).toBe(404);
    const joined = await api("POST", "/api/invites/join", { code: inv.code }, sam);
    expect(joined.status).toBe(200);
    const me = (await api("GET", "/api/me", undefined, joined.data.token)).data;
    expect(me).toMatchObject({ role: "member", workspace: { id: second.id } });
    expect((await api<any[]>("GET", "/api/channels", undefined, joined.data.token)).data.find((c) => c.name === "general").joined).toBe(true);
    // used up
    expect((await api("POST", "/api/invites/join", { code: inv.code }, owner)).status).toBe(404);
    expect((await api<any[]>("GET", "/api/orgs", undefined, joined.data.token)).data.map((o) => [o.name, o.role])).toEqual([
      ["Home", "member"],
      ["Side project", "member"],
    ]);
  });

  it("lets an owner delete an organization, with its agents, channels and memory", async () => {
    const t = await login("me@example.com");
    const made = (await api("POST", "/api/orgs", { name: "Throwaway" }, t)).data;
    const tok = made.token;
    const a = (await api("POST", "/api/agents", { handle: "temp", name: "Temp", harness: "custom" }, tok)).data;
    await api("PUT", "/api/vault/note", { path: "shared/gone.md", content: "bye" }, tok);
    const folder = path.join(dir, "orgs", made.org.id);
    await expect(fs.stat(folder)).resolves.toBeTruthy();

    // members can't, the name has to match, and the first organization stays
    await api("PUT", "/api/features", { invite: true }, tok);
    const inv = (await api("POST", "/api/invites", { role: "member" }, tok)).data;
    const sam = (await api("POST", "/api/invites/join", { code: inv.code }, await login("sam@example.com"))).data.token;
    expect(sam).toBeTruthy();
    expect((await api("DELETE", `/api/orgs/${made.org.id}`, { name: "Throwaway" }, sam)).status).toBe(403);
    expect((await api("DELETE", `/api/orgs/${made.org.id}`, { name: "throw" }, tok)).status).toBe(400);
    const home = (await api("POST", `/api/orgs/${firstOrg}/switch`, undefined, await login("me@example.com"))).data.token;
    expect((await api("DELETE", `/api/orgs/${firstOrg}`, { name: "Home" }, home)).status).toBe(409);

    const r = await api("DELETE", `/api/orgs/${made.org.id}`, { name: "Throwaway" }, tok);
    expect(r.status).toBe(200);
    // the sign-in that was in it moved somewhere else; the other member's ended
    expect((await api("GET", "/api/me", undefined, r.data.token)).data.workspace.id).not.toBe(made.org.id);
    expect((await api("GET", "/api/me", undefined, tok)).status).toBe(401);
    expect((await api("GET", "/api/me", undefined, sam)).status).toBe(401);
    expect((await api<any[]>("GET", "/api/orgs", undefined, r.data.token)).data.map((o) => o.id)).not.toContain(made.org.id);
    expect(hub.store.agent(a.id)).toBeUndefined();
    await expect(fs.stat(folder)).rejects.toThrow();
    // deleting another organization than the one you're in keeps your sign-in
    const other = (await api("POST", "/api/orgs", { name: "Other" }, r.data.token)).data;
    const back = (await api("POST", `/api/orgs/${firstOrg}/switch`, undefined, other.token)).data.token;
    const r2 = await api("DELETE", `/api/orgs/${other.org.id}`, { name: "Other" }, back);
    expect(r2.data).toEqual({ ok: true });
    expect((await api("GET", "/api/me", undefined, back)).status).toBe(200);
  });

  it("won't delete your only organization", async () => {
    const t = await login("me@example.com");
    const solo = (await api("POST", "/api/members", { email: "solo@example.com", name: "Solo", password: "password123" }, (await api("POST", `/api/orgs/${firstOrg}/switch`, undefined, t)).data.token)).data;
    expect(solo.id).toBeTruthy();
    const s = await login("solo@example.com");
    const own = (await api("POST", "/api/orgs", { name: "Solo's" }, s)).data;
    // leave Home so Solo's is the only one
    hub.store.removeMember(firstOrg, solo.id);
    expect((await api("DELETE", `/api/orgs/${own.org.id}`, { name: "Solo's" }, own.token)).status).toBe(409);
  });

  it("opens every organization's memory again after a restart", async () => {
    await close();
    await start();
    const t = await login("me@example.com");
    const tok = (await api("POST", `/api/orgs/${second.id}/switch`, undefined, t)).data.token;
    expect((await api<any[]>("GET", "/api/vault/notes", undefined, tok)).data.map((n) => n.path)).toContain("shared/secret-plan.md");
    expect((await api<any[]>("GET", "/api/vault/search?q=friday", undefined, tok)).data).toHaveLength(1);
  });
});
