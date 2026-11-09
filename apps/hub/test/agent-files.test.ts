import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WispClient } from "@wisp/sdk";
import { createWispMcp } from "@wisp/mcp/src/server.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

/** A file an agent makes while it answers reaches the chat, attached to its reply. */

let dir: string;
let app: FastifyInstance;
let hub: Hub;
let owner: string;
let n = 0;

async function api(method: "GET" | "POST", url: string, payload?: any, token = owner) {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-agent-files-"));
  ({ app, hub } = await buildHub({ dataDir: dir, setupCode: false }));
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything" }, "")).token;
});
afterAll(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** An agent on a fake device, answering a DM message from its owner. */
async function dmRun(kind?: "background") {
  const i = ++n;
  const { node } = await api("POST", "/api/nodes", { name: `box-${i}` });
  const agent = await api("POST", "/api/agents", { handle: `maker-${i}`, name: `Maker ${i}`, harness: "custom", nodeId: node.id });
  const dm = await api("POST", `/api/dm/${agent.id}`);
  const ask = await api("POST", `/api/channels/${dm.id}/messages`, { body: "make notes.md and send it to me" });
  let run = hub.store.db.prepare("SELECT id FROM runs WHERE trigger_message_id = ?").get(ask.id) as { id: string } | undefined;
  if (kind) {
    hub.store.db.prepare("UPDATE runs SET kind = ? WHERE id = ?").run(kind, run!.id);
  }
  hub.store.setRunStatus(run!.id, "running");
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: () => {}, terminate: () => {} }) as unknown as WebSocket;
  hub.addNode(socket, node.id, agent.workspaceId);
  const token = (await api("POST", `/api/agents/${agent.id}/token`)).token as string;
  const upload = async (name: string, body: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: "POST", url: "/api/files", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-filename": name, "x-mime-type": "text/markdown", "x-wisp-run": run!.id, ...headers }, payload: Buffer.from(body) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { id: string; name: string };
  };
  return {
    agent, dm, token, upload, socket, run: run!,
    finish: (finalText: string) => socket.emit("message", Buffer.from(JSON.stringify({ type: "run_done", runId: run!.id, finalText }))),
    fail: (error: string) => socket.emit("message", Buffer.from(JSON.stringify({ type: "run_failed", runId: run!.id, error }))),
    replies: () => hub.store.messages(dm.id).filter((m) => m.author.kind === "agent" && m.author.id === agent.id),
  };
}

describe("files agents send", () => {
  it("attaches a file uploaded during a run to the reply", async () => {
    const t = await dmRun();
    const f = await t.upload("notes.md", "- one\n- two\n- three\n");
    t.finish("Attached notes.md.");
    const replies = t.replies();
    expect(replies.at(-1)?.body).toBe("Attached notes.md.");
    expect(replies.at(-1)?.parts).toContainEqual({ type: "file", fileId: f.id, name: "notes.md" });
    // and the person can open it
    const got = await app.inject({ method: "GET", url: `/api/files/${f.id}`, headers: { authorization: `Bearer ${owner}` } });
    expect(got.body).toBe("- one\n- two\n- three\n");
    t.socket.emit("close");
  });

  it("finds the run without the run header when the agent has one", async () => {
    const t = await dmRun();
    const f = await t.upload("a.txt", "a", { "x-wisp-run": "" });
    t.finish("Here.");
    expect(t.replies().at(-1)?.parts).toContainEqual({ type: "file", fileId: f.id, name: "a.txt" });
    t.socket.emit("close");
  });

  it("posts the file even when the agent says nothing with it", async () => {
    const t = await dmRun();
    const f = await t.upload("silent.md", "x");
    t.finish("");
    expect(t.replies().at(-1)?.parts).toContainEqual({ type: "file", fileId: f.id, name: "silent.md" });
    t.socket.emit("close");
  });

  it("keeps the file on a failed run's line", async () => {
    const t = await dmRun();
    const f = await t.upload("half.md", "x");
    t.fail("boom");
    expect(t.replies().at(-1)?.parts).toContainEqual({ type: "file", fileId: f.id, name: "half.md" });
    t.socket.emit("close");
  });

  it("doesn't attach a file twice when the agent already posted it with chat_send", async () => {
    const t = await dmRun();
    const f = await t.upload("once.md", "x");
    await api("POST", `/api/channels/${t.dm.id}/messages`, { body: "Here it is", fileIds: [f.id] }, t.token);
    t.finish("Sent it above.");
    const withFile = t.replies().filter((m) => m.parts.some((p) => p.type === "file" && p.fileId === f.id));
    expect(withFile).toHaveLength(1);
    expect(withFile[0].body).toBe("Here it is");
    t.socket.emit("close");
  });

  it("a background check, which posts nothing, keeps no file", async () => {
    const t = await dmRun("background");
    await t.upload("bg.md", "x");
    t.finish("");
    expect(t.replies().some((m) => m.parts.some((p) => p.type === "file"))).toBe(false);
    t.socket.emit("close");
  });
});

describe("file_upload", () => {
  /** wisp-mcp against a hub stand-in: the agent has a computer that holds ~/files/notes.md, which isn't where the tool runs */
  async function mcpWith(computer: boolean) {
    const uploads: { name: string; body: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (u.pathname === "/api/me") return json({ kind: "agent", agent: { id: "agt_1", handle: "maker", name: "Maker", settings: {} }, workspace: { id: "ws_1", name: "Test" } });
      if (u.pathname === "/api/computers/mine") return computer ? json({ id: "cmp_1", name: "Desk", kind: "vm", online: true, status: "running", statusText: "" }) : json({ error: "no computer" }, 404);
      if (u.pathname === "/api/computers/mine/act") {
        const { action } = JSON.parse(String(init.body));
        if (action.action === "file_read" && action.path === "/home/wisp/files/notes.md") return json({ name: "notes.md", size: 6, data: Buffer.from("- one\n").toString("base64") });
        return json({ error: "no such file" }, 404);
      }
      if (u.pathname === "/api/files" && init.method === "POST") {
        const h = init.headers as Record<string, string>;
        uploads.push({ name: decodeURIComponent(h["x-filename"]), body: Buffer.from(init.body as Uint8Array).toString() });
        return json({ id: "file_x", name: decodeURIComponent(h["x-filename"]), size: 6 });
      }
      return json({ error: "not here" }, 404);
    }) as unknown as typeof globalThis.fetch;
    const server = await createWispMcp(new WispClient({ url: "http://hub.test", token: "t", fetch }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(b);
    const call = async (args: Record<string, unknown>) => {
      const r = (await mcp.callTool({ name: "file_upload", arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
    };
    return { call, uploads };
  }

  it("reads a file only the agent's computer has from that computer", async () => {
    const { call, uploads } = await mcpWith(true);
    const r = await call({ local_path: "/home/wisp/files/notes.md" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Sent notes\.md \(6 bytes, file id file_x\)\. It's attached to your reply\.$/);
    expect(uploads).toEqual([{ name: "notes.md", body: "- one\n" }]);
  });

  it("still reads a file where it runs first", async () => {
    const { call, uploads } = await mcpWith(true);
    const local = path.join(dir, "here.txt");
    await fs.writeFile(local, "local!");
    expect((await call({ local_path: local })).isError).toBe(false);
    expect(uploads).toEqual([{ name: "here.txt", body: "local!" }]);
  });

  it("says so plainly when the file is nowhere", async () => {
    const { call, uploads } = await mcpWith(false);
    const r = await call({ local_path: "/home/wisp/files/missing.md" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("There's no file at /home/wisp/files/missing.md");
    expect(uploads).toEqual([]);
  });
});
