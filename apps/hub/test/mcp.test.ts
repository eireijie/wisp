import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WarrenClient } from "@warren/sdk";
import { createWarrenMcp } from "@warren/mcp/src/server.ts";
import { buildHub } from "../src/app.ts";

let dir: string;
let close: () => Promise<void>;
let mcp: Client;
let owner: WarrenClient;
let agentId: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-mcp-"));
  const { app } = await buildHub({ dataDir: dir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();

  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123" }) })).json();
  owner = new WarrenClient({ url, token: setup.token });
  const agent = await owner.request("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "claude-code" });
  await owner.request("POST", "/api/agents", { handle: "helper", name: "Helper", harness: "codex" });
  agentId = agent.id;
  const { token } = await owner.request("POST", `/api/agents/${agent.id}/token`);

  const server = await createWarrenMcp(new WarrenClient({ url, token }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(b);
});

afterAll(async () => {
  await mcp?.close();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};

describe("warren-mcp", () => {
  it("exposes the tool set", async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "agents_list",
      "approval_request",
      "branch_merge",
      "chat_channels",
      "chat_react",
      "chat_read",
      "chat_send",
      "discussion_start",
      "file_download",
      "file_upload",
      "file_view",
      "memory_append",
      "memory_context",
      "memory_forget",
      "memory_list",
      "memory_read",
      "memory_remember",
      "memory_search",
      "memory_share",
      "memory_write",
      "routine_list",
      "routine_save",
      "task_delegate",
      "task_list",
      "task_update",
      "teams_list",
    ]);
  });

  it("chats", async () => {
    expect((await call("chat_send", { channel: "general", message: "hello from scout" })).text).toContain("Posted");
    expect((await call("chat_read", { channel: "#general" })).text).toContain("@scout: hello from scout");
    expect((await call("agents_list")).text).toContain("@helper");
    const id = (await call("chat_read", { channel: "general" })).text.match(/\[(msg_[^\]]+)\]/)![1];
    expect((await call("chat_react", { message_id: id, emoji: "✅" })).text).toBe("Reacted ✅.");
    expect((await call("chat_react", { message_id: id, emoji: "lol" })).isError).toBe(true);
  });

  it("uses private and shared memory with the me/ shorthand", async () => {
    await call("memory_write", { path: "me/findings.md", content: "# Findings\nThe flux capacitor needs [[Welcome]]" });
    expect((await call("memory_read", { path: `agents/${agentId}/findings.md` })).text).toContain("flux capacitor");
    expect((await call("memory_search", { query: "flux" })).text).toContain(`agents/${agentId}/findings.md`);
    expect((await call("memory_read", { path: "shared/Welcome.md" })).text).toContain(`Linked from: agents/${agentId}/findings.md`);
    await call("memory_append", { path: "me/log", text: "- did a thing" });
    expect((await call("memory_list", { prefix: "me/" })).text).toContain("log.md");
    const helper = (await owner.agents()).find((a) => a.handle === "helper")!;
    expect((await call("memory_read", { path: `agents/${helper.id}/SOUL.md` })).isError).toBe(true);
  });

  it("shares a note with another agent", async () => {
    await call("memory_write", { path: "me/handoff.md", content: "# Handoff" });
    expect((await call("memory_share", { path: "me/handoff", with: "@helper" })).text).toBe(`Shared agents/${agentId}/handoff.md with @helper (read-only).`);
    const rules = await owner.request<any[]>("GET", "/api/access/rules");
    expect(rules.some((r) => r.path === `agents/${agentId}/handoff.md` && r.subject.kind === "agent")).toBe(true);
    expect((await call("memory_share", { path: "shared/Welcome.md", with: "@nobody" })).isError).toBe(true);
  });

  it("remembers things about people and knows its teams", async () => {
    const saved = await call("memory_remember", { kind: "preference", text: "Likes tea, not coffee" });
    expect(saved.text).toMatch(/^Remembered \(preference\) about Me in people\/usr_[\w-]+\/preferences\/likes-tea-not-coffee\.md\.$/);
    expect((await call("memory_remember", { kind: "preference", text: "likes tea not coffee" })).text).toContain("Not saved");
    expect((await call("memory_context")).text).toContain("Likes tea, not coffee");
    const p = saved.text.match(/in (\S+)\.$/)![1];
    expect((await call("memory_forget", { path: p })).text).toBe(`Forgot ${p}.`);
    await owner.request("POST", "/api/teams", { name: "scouts", leadId: agentId });
    expect(JSON.parse((await call("teams_list")).text)[0]).toMatchObject({ name: "scouts", lead: "@scout", memory: "teams/scouts/" });
  });

  it("delegates tasks and moves files", async () => {
    expect((await call("task_delegate", { to: "@helper", title: "Check", brief: "check it" })).text).toMatch(/Created task task_/);
    const local = path.join(dir, "report.txt");
    await fs.writeFile(local, "report body");
    const up = (await call("file_upload", { local_path: local })).text;
    const fileId = up.match(/as (file_\S+)/)![1];
    const down = await call("file_download", { file_id: fileId, dest_dir: path.join(dir, "dl") });
    expect(await fs.readFile(path.join(dir, "dl", "report.txt"), "utf8")).toBe("report body");
    expect(down.text).toContain("Saved");
  });
});
