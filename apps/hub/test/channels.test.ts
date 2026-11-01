import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let guest: string;
let me: any;
let sam: any;
let atlas: any;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const channelNamed = async (name: string) => (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === name);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-channels-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  me = (await api("GET", "/api/me")).data.user;
  sam = (await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" })).data;
  await api("POST", "/api/members", { email: "gus@example.com", name: "Gus", password: "password123", role: "guest" });
  guest = (await api("POST", "/api/auth/login", { email: "gus@example.com", password: "password123" }, "")).data.token;
  atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("channel members", () => {
  it("lists, adds and removes people and agents", async () => {
    const ch = (await api("POST", "/api/channels", { name: "launch" })).data;
    expect((await api("GET", `/api/channels/${ch.id}/members`)).data).toEqual([{ kind: "user", id: me.id, name: "Alex", handle: null, role: "owner" }]);

    await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    const added = await api<any[]>("PUT", `/api/channels/${ch.id}/members/user/${sam.id}`);
    expect(added.status).toBe(200);
    expect(added.data.map((m) => `${m.kind}:${m.name}`)).toEqual(["user:Alex", "user:Sam", "agent:Atlas"]);
    // adding twice is fine
    expect((await api<any[]>("PUT", `/api/channels/${ch.id}/members/user/${sam.id}`)).data).toHaveLength(3);
    expect((await channelNamed("launch")).memberCount).toBe(3);

    // guests can look, not change
    expect((await api("GET", `/api/channels/${ch.id}/members`, undefined, guest)).data).toHaveLength(3);
    expect((await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`, undefined, guest)).status).toBe(403);
    expect((await api("DELETE", `/api/channels/${ch.id}/members/user/${sam.id}`, undefined, guest)).status).toBe(403);

    // only people and agents of this workspace
    expect((await api("PUT", `/api/channels/${ch.id}/members/agent/agt_nope`)).status).toBe(404);
    expect((await api("PUT", `/api/channels/${ch.id}/members/user/usr_nope`)).status).toBe(404);
    expect((await api("PUT", `/api/channels/${ch.id}/members/bot/${atlas.id}`)).status).toBe(400);

    await api("DELETE", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    await api("DELETE", `/api/channels/${ch.id}/members/user/${sam.id}`);
    // removing the last member leaves an empty channel, not a missing one
    const empty = await api<any[]>("DELETE", `/api/channels/${ch.id}/members/user/${me.id}`);
    expect(empty.data).toEqual([]);
    expect((await channelNamed("launch")).memberCount).toBe(0);
  });

  it("doesn't change who's in a DM", async () => {
    const dm = (await api("POST", `/api/dm/${atlas.id}`)).data;
    expect((await api("GET", `/api/channels/${dm.id}/members`)).data).toHaveLength(2);
    expect((await api("PUT", `/api/channels/${dm.id}/members/user/${sam.id}`)).status).toBe(404);
  });

  it("wakes an agent added to a channel when it's mentioned there", async () => {
    const ch = (await api("POST", "/api/channels", { name: "ops" })).data;
    await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    const msg = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "@atlas status?" })).data;
    const run = hub.store.db.prepare("SELECT status FROM runs WHERE trigger_message_id = ?").get(msg.id) as { status: string } | undefined;
    expect(run?.status).toBe("queued");
  });
});

describe("deleting channels", () => {
  it("deletes a channel with its messages, stops its work and lets go of its tasks", async () => {
    const ch = (await api("POST", "/api/channels", { name: "scratch" })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "hello" });
    const task = (await api("POST", "/api/tasks", { to: "atlas", title: "Tidy up", brief: "now", channelId: ch.id })).data;
    expect(task.channelId).toBe(ch.id);

    expect((await api("DELETE", `/api/channels/${ch.id}`, undefined, guest)).status).toBe(403);
    expect((await api("DELETE", `/api/channels/${ch.id}`)).data).toEqual({ ok: true });
    expect(await channelNamed("scratch")).toBeUndefined();
    expect((await api("GET", `/api/channels/${ch.id}/messages`)).status).toBe(404);
    expect((hub.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(ch.id) as { n: number }).n).toBe(0);
    expect((hub.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE channel_id = ? AND status IN ('queued', 'running')").get(ch.id) as { n: number }).n).toBe(0);
    const after = (await api<any[]>("GET", "/api/tasks")).data.find((t) => t.id === task.id);
    expect(after.channelId).toBeNull();
    // the name is free again
    expect((await api("POST", "/api/channels", { name: "scratch" })).status).toBe(200);
  });

  it("keeps DMs", async () => {
    const dm = (await api("POST", `/api/dm/${atlas.id}`)).data;
    expect((await api("DELETE", `/api/channels/${dm.id}`)).status).toBe(404);
  });
});

describe("who answers in a channel", () => {
  const post = async (channelId: string, body: string, threadId?: string, token = owner) => (await api("POST", `/api/channels/${channelId}/messages`, { body, threadId }, token)).data;
  let nova: any;
  beforeAll(async () => {
    nova = (await api("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "custom" })).data;
  });

  it("only wakes @mentioned agents until the channel has a default agent", async () => {
    const ch = (await api("POST", "/api/channels", { name: "support" })).data;
    expect(ch.settings).toEqual({ defaultAgentId: null, replyInThread: false, instructions: "", team: null });
    expect(hub.targets(await post(ch.id, "anyone around?"), ch.workspaceId)).toEqual([]);

    const set = await api("PATCH", `/api/channels/${ch.id}`, { settings: { defaultAgentId: atlas.id, instructions: "Keep it short." } });
    expect(set.status).toBe(200);
    expect(set.data.settings).toEqual({ defaultAgentId: atlas.id, replyInThread: false, instructions: "Keep it short.", team: null });
    // the default agent joins the channel it answers in
    expect((await api<any[]>("GET", `/api/channels/${ch.id}/members`)).data.some((m) => m.id === atlas.id)).toBe(true);

    expect(hub.targets(await post(ch.id, "anyone around?"), ch.workspaceId)).toEqual([atlas.id]);
    // an @mention of someone else goes to them instead
    expect(hub.targets(await post(ch.id, "@nova can you look?"), ch.workspaceId)).toEqual([nova.id]);

    // and the agent hears the channel's notes
    const msg = await post(ch.id, "@atlas hi");
    const prompt = await hub.buildPrompt(atlas.id, ch.id, null, msg.id);
    expect(prompt).toContain("## This channel");
    expect(prompt).toContain("Keep it short.");

    // removing the agent from the channel stops it answering there
    await api("DELETE", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    expect((await channelNamed("support")).settings.defaultAgentId).toBeNull();
  });

  it("rejects an agent from somewhere else", async () => {
    const ch = (await api("POST", "/api/channels", { name: "elsewhere" })).data;
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { defaultAgentId: "agt_nope" } })).status).toBe(400);
  });

  it("sends a plain reply in a thread to the agent already in it", async () => {
    const ch = (await api("POST", "/api/channels", { name: "threads" })).data;
    const root = await post(ch.id, "@nova draft the release notes");
    // nobody answered yet: the agent asked at the start hears the follow-up
    expect(hub.targets(await post(ch.id, "and keep them short", root.id), ch.workspaceId)).toEqual([nova.id]);
    // once another agent speaks there, it's that one
    hub.postMessage({ channelId: ch.id, threadId: root.id, author: { kind: "agent", id: atlas.id }, body: "I'll take it", route: false });
    expect(hub.targets(await post(ch.id, "thanks, go ahead", root.id), ch.workspaceId)).toEqual([atlas.id]);
  });

  it("creates a channel with members, a default agent and threaded replies", async () => {
    const res = await api("POST", "/api/channels", { name: "ops-team", private: true, settings: { defaultAgentId: nova.id, replyInThread: true }, members: [{ kind: "user", id: sam.id }] });
    expect(res.status).toBe(200);
    expect(res.data.private).toBe(true);
    const members = (await api<any[]>("GET", `/api/channels/${res.data.id}/members`)).data.map((m) => m.name);
    expect(members).toEqual(["Alex", "Sam", "Nova"]);
    expect((await api("POST", "/api/channels", { name: "ops-team-2", members: [{ kind: "agent", id: "agt_nope" }] })).status).toBe(400);
  });
});

describe("private channels", () => {
  it("are only seen by their members (and owners)", async () => {
    const ch = (await api("POST", "/api/channels", { name: "secret", private: true })).data;
    const samToken = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
    const visible = async (token: string) => (await api<any[]>("GET", "/api/channels", undefined, token)).data.some((c) => c.id === ch.id);
    expect(await visible(owner)).toBe(true);
    expect(await visible(samToken)).toBe(false);
    expect((await api("GET", `/api/channels/${ch.id}/messages`, undefined, samToken)).status).toBe(404);
    expect((await api("POST", `/api/channels/${ch.id}/join`, undefined, samToken)).status).toBe(404);
    await api("PUT", `/api/channels/${ch.id}/members/user/${sam.id}`);
    expect(await visible(samToken)).toBe(true);
  });

  it("can't be #general", async () => {
    const general = await channelNamed("general");
    expect((await api("PATCH", `/api/channels/${general.id}`, { private: true })).status).toBe(409);
    expect((await api("PATCH", `/api/channels/${general.id}`, { name: "everyone" })).status).toBe(409);
  });
});

describe("archiving channels", () => {
  it("makes a channel read-only and brings it back", async () => {
    const ch = (await api("POST", "/api/channels", { name: "old-launch", settings: { defaultAgentId: atlas.id } })).data;
    const archived = await api("POST", `/api/channels/${ch.id}/archive`, { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.data.archivedAt).toBeTruthy();
    expect((await api("POST", `/api/channels/${ch.id}/messages`, { body: "hello?" })).status).toBe(409);
    // still listed, so it can be found and brought back
    expect((await channelNamed("old-launch")).archivedAt).toBeTruthy();
    const back = await api("POST", `/api/channels/${ch.id}/archive`, { archived: false });
    expect(back.data.archivedAt).toBeNull();
    expect((await api("POST", `/api/channels/${ch.id}/messages`, { body: "hello again" })).status).toBe(200);
  });

  it("keeps guests out", async () => {
    const ch = await channelNamed("launch");
    expect((await api("POST", `/api/channels/${ch.id}/archive`, {}, guest)).status).toBe(403);
  });
});

describe("your own channel settings and pins", () => {
  it("stars and mutes a channel just for you", async () => {
    const ch = await channelNamed("general");
    expect(ch).toMatchObject({ notify: "default", starred: false, pinnedIds: [] });
    expect((await api("PUT", `/api/channels/${ch.id}/prefs`, { starred: true, notify: "mute" })).status).toBe(200);
    expect(await channelNamed("general")).toMatchObject({ notify: "mute", starred: true });
    expect((await api("PUT", `/api/channels/${ch.id}/prefs`, { notify: "loud" })).status).toBe(400);
    expect(hub.push.recipients({ author: { kind: "agent", id: atlas.id }, channelId: ch.id, parts: [] } as any, { workspaceId: ch.workspaceId, kind: "channel" }, me.id)).toEqual([]);
    await api("PUT", `/api/channels/${ch.id}/prefs`, { notify: "default" });
    expect(hub.push.recipients({ author: { kind: "agent", id: atlas.id }, channelId: ch.id, parts: [] } as any, { workspaceId: ch.workspaceId, kind: "channel" }, me.id)).toEqual([me.id]);
  });

  it("pins and unpins messages", async () => {
    const ch = await channelNamed("general");
    const msg = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "The launch doc is in shared/launch.md" })).data;
    expect((await api("PUT", `/api/messages/${msg.id}/pin`)).data).toEqual({ ok: true, pinned: true });
    expect((await channelNamed("general")).pinnedIds).toEqual([msg.id]);
    const pins = (await api<any[]>("GET", `/api/channels/${ch.id}/pins`)).data;
    expect(pins.map((p) => p.message.body)).toEqual(["The launch doc is in shared/launch.md"]);
    expect((await api("PUT", `/api/messages/${msg.id}/pin`, undefined, guest)).status).toBe(403);
    await api("DELETE", `/api/messages/${msg.id}/pin`);
    expect((await channelNamed("general")).pinnedIds).toEqual([]);
  });
});

describe("editing and deleting messages", () => {
  const runCount = () => (hub.store.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  let samToken: string;
  beforeAll(async () => {
    samToken = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
  });

  it("lets the author fix a message without asking agents again", async () => {
    const ch = await channelNamed("general");
    const msg = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "teh plan" })).data;
    const runs = runCount();
    const edited = await api("PATCH", `/api/messages/${msg.id}`, { body: "@atlas the plan" });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ id: msg.id, body: "@atlas the plan" });
    expect(edited.data.editedAt).toBeTruthy();
    expect(runCount()).toBe(runs);
    const listed = (await api("GET", `/api/channels/${ch.id}/messages`)).data.messages.find((m: any) => m.id === msg.id);
    expect(listed.editedAt).toBe(edited.data.editedAt);
    expect((await api("PATCH", `/api/messages/${msg.id}`, { body: "  " })).status).toBe(400);
  });

  it("only lets the author edit, and the author or an owner delete", async () => {
    const ch = await channelNamed("general");
    const mine = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "owner's note" })).data;
    const sams = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "sam's note" }, samToken)).data;
    expect((await api("PATCH", `/api/messages/${mine.id}`, { body: "hijacked" }, samToken)).status).toBe(403);
    expect((await api("DELETE", `/api/messages/${mine.id}`, undefined, samToken)).status).toBe(403);
    // owners can tidy up, but can't put words in someone's mouth
    expect((await api("PATCH", `/api/messages/${sams.id}`, { body: "edited by owner" })).status).toBe(403);
    expect((await api("DELETE", `/api/messages/${sams.id}`)).data).toEqual({ ok: true, kept: false });
    expect((await api("DELETE", `/api/messages/${mine.id}`)).data).toEqual({ ok: true, kept: false });
    const ids = (await api("GET", `/api/channels/${ch.id}/messages`)).data.messages.map((m: any) => m.id);
    expect(ids).not.toContain(mine.id);
    expect(ids).not.toContain(sams.id);
    expect((await api("DELETE", `/api/messages/${mine.id}`)).status).toBe(404);
  });

  it("keeps a deleted thread root while it has replies", async () => {
    const ch = await channelNamed("general");
    const root = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "release notes?" })).data;
    const reply = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "on it", threadId: root.id }, samToken)).data;
    await api("PUT", `/api/messages/${root.id}/pin`);
    expect((await api("DELETE", `/api/messages/${root.id}`)).data).toEqual({ ok: true, kept: true });
    const top = (await api("GET", `/api/channels/${ch.id}/messages`)).data;
    const blank = top.messages.find((m: any) => m.id === root.id);
    expect(blank).toMatchObject({ body: "", parts: [] });
    expect(blank.deletedAt).toBeTruthy();
    expect(top.replyCounts[root.id]).toBe(1);
    expect((await channelNamed("general")).pinnedIds).not.toContain(root.id);
    expect((await api("GET", `/api/channels/${ch.id}/messages?thread=${root.id}`)).data.messages.map((m: any) => m.body)).toEqual(["", "on it"]);
    // can't edit or delete it twice
    expect((await api("PATCH", `/api/messages/${root.id}`, { body: "back" })).status).toBe(404);
    // once the last reply goes, so does the root
    await api("DELETE", `/api/messages/${reply.id}`, undefined, samToken);
    expect((await api("GET", `/api/channels/${ch.id}/messages`)).data.messages.some((m: any) => m.id === root.id)).toBe(false);
  });

  it("refuses in archived channels", async () => {
    const ch = (await api("POST", "/api/channels", { name: "frozen" })).data;
    const msg = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "last words" })).data;
    await api("POST", `/api/channels/${ch.id}/archive`, { archived: true });
    expect((await api("PATCH", `/api/messages/${msg.id}`, { body: "new words" })).status).toBe(409);
    expect((await api("DELETE", `/api/messages/${msg.id}`)).status).toBe(409);
  });

  it("counts only members who still exist, matching the member list", async () => {
    const ch = (await api("POST", "/api/channels", { name: "headcount" })).data;
    const gone = (await api("POST", "/api/agents", { handle: "gone", name: "Gone", harness: "custom" })).data;
    await api("PUT", `/api/channels/${ch.id}/members/agent/${gone.id}`);
    await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    // rows left behind by older versions: a deleted agent and a removed person
    hub.store.db.prepare("INSERT INTO channel_members (channel_id, member_kind, member_id) VALUES (?, 'agent', 'agt_deleted'), (?, 'user', 'usr_removed')").run(ch.id, ch.id);
    const listed = async () => (await api<any[]>("GET", `/api/channels/${ch.id}/members`)).data;
    expect((await channelNamed("headcount")).memberCount).toBe((await listed()).length);
    await api("DELETE", `/api/agents/${gone.id}`);
    const after = await listed();
    expect((await channelNamed("headcount")).memberCount).toBe(after.length);
    expect((hub.store.db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ? AND member_id = ?").get(ch.id, gone.id) as { n: number }).n).toBe(0);
  });

  it("keeps an image shared in the team as its icon, and refuses any other file", async () => {
    const upload = async (channelId: string | null, mime: string) => {
      const res = await fetch(base + "/api/files", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/octet-stream", "x-filename": "i", "x-mime-type": mime, ...(channelId ? { "x-channel-id": channelId } : {}) }, body: Buffer.from(mime + channelId) });
      return ((await res.json()) as { id: string }).id;
    };
    const ch = (await api("POST", "/api/channels", { name: "icon-team" })).data;
    const icon = await upload(ch.id, "image/png");
    const set = await api("PATCH", `/api/channels/${ch.id}`, { settings: { iconFileId: icon } });
    expect(set.status).toBe(200);
    expect(set.data.settings.iconFileId).toBe(icon);
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { iconFileId: await upload(ch.id, "text/plain") } })).status).toBe(400);
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { iconFileId: await upload(null, "image/png") } })).status).toBe(400);
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { iconFileId: "file_nope" } })).status).toBe(400);
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { iconFileId: null } })).data.settings.iconFileId).toBeNull();
  });
});
