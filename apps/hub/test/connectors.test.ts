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

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

let atlas: any;
let general: any;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-connectors-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
  general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

const promptFor = async (agentId: string) => {
  const msg = (await api("POST", `/api/channels/${general.id}/messages`, { body: "hello" })).data;
  return hub.buildPrompt(agentId, general.id, null, msg.id);
};

describe("connectors", () => {
  it("includes current device warnings when listing connectors", async () => {
    const { node } = (await api("POST", "/api/nodes", { name: "Laptop" })).data;
    hub.store.setNodeCapabilities(node.id, { platform: "linux", arch: "x64", screen: { ok: false, detail: "" }, vm: { ok: false, detail: "" }, commands: { uvx: false } });
    const agent = (await api("POST", "/api/agents", { handle: "local", name: "Local", harness: "custom", nodeId: node.id })).data;
    const conn = (await api("POST", "/api/connectors", { kind: "mcp-stdio", name: "Local tools", command: "uvx", agentIds: [agent.id] })).data;
    expect(conn.warnings).toHaveLength(1);
    const list = (await api<any[]>("GET", "/api/connectors")).data;
    expect(list.find((c) => c.id === conn.id)?.warnings).toEqual(conn.warnings);
    await api("DELETE", `/api/connectors/${conn.id}/agents/${agent.id}`);
    expect((await api<any[]>("GET", "/api/connectors")).data.find((c) => c.id === conn.id)?.warnings).toEqual([]);
    await api("DELETE", `/api/connectors/${conn.id}`);
  });

  it("keeps secrets masked, fills templates for the agent's runs, and respects enable and detach", async () => {
    const gh = await api("POST", "/api/connectors", {
      kind: "mcp-http",
      name: "GitHub",
      catalogId: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer {{GITHUB_TOKEN}}" },
      env: { GITHUB_TOKEN: "github_pat_supersecret1234" },
      agentIds: [atlas.id],
    });
    expect(gh.status).toBe(200);
    expect(gh.data.env.GITHUB_TOKEN).toBe("••••1234");
    expect(gh.data.headers.Authorization).toBe("Bearer {{GITHUB_TOKEN}}");
    expect(gh.data.agentIds).toEqual([atlas.id]);
    expect(JSON.stringify((await api("GET", "/api/connectors")).data)).not.toContain("supersecret");

    const pg = (await api("POST", "/api/connectors", { kind: "mcp-stdio", name: "Postgres", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "{{DATABASE_URL}}"], env: { DATABASE_URL: "postgres://u:p@h/db" } })).data;
    await api("PUT", `/api/connectors/${pg.id}/agents/${atlas.id}`);
    expect((await api("POST", "/api/connectors", { kind: "secret", name: "github", env: { X: "1" } })).status).toBe(409);

    let specs = hub.connectors.specsFor(atlas.id);
    expect(specs).toEqual([
      { name: "github", kind: "mcp-http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer github_pat_supersecret1234" } },
      { name: "postgres", kind: "mcp-stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://u:p@h/db"], env: { DATABASE_URL: "postgres://u:p@h/db" } },
    ]);

    // sending the masked value back keeps the secret; a new value replaces it
    await api("PATCH", `/api/connectors/${gh.data.id}`, { env: { GITHUB_TOKEN: "••••1234" }, enabled: false });
    specs = hub.connectors.specsFor(atlas.id);
    expect(specs.map((s) => s.name)).toEqual(["postgres"]);
    await api("PATCH", `/api/connectors/${gh.data.id}`, { enabled: true });
    expect(hub.connectors.specsFor(atlas.id)[0].headers).toEqual({ Authorization: "Bearer github_pat_supersecret1234" });

    expect(await promptFor(atlas.id)).toContain("## Your connectors");
    await api("DELETE", `/api/connectors/${pg.id}/agents/${atlas.id}`);
    expect(hub.connectors.specsFor(atlas.id).map((s) => s.name)).toEqual(["github"]);
    expect((await api("DELETE", `/api/connectors/${gh.data.id}`)).status).toBe(200);
    expect(hub.connectors.specsFor(atlas.id)).toEqual([]);
  });

  it("lets guests look but not change", async () => {
    const { code } = (await api("POST", "/api/invites", { role: "guest" })).data;
    const guest = (await api("POST", "/api/invites/accept", { code, email: "g@example.com", name: "Guest", password: "password123" }, "")).data.token;
    expect((await api("GET", "/api/connectors", undefined, guest)).status).toBe(200);
    expect((await api("POST", "/api/connectors", { kind: "secret", name: "x", env: { A: "b" } }, guest)).status).toBe(403);
    expect((await api("POST", "/api/skills", { catalogId: "release-notes" }, guest)).status).toBe(403);
  });
});

describe("skills", () => {
  it("installs a catalog skill into the agent's folder and its prompt, and takes it back out", async () => {
    const s = (await api("POST", "/api/skills", { catalogId: "weekly-status-report", agentIds: [atlas.id] })).data;
    expect(s).toMatchObject({ slug: "weekly-status-report", source: "catalog", agentIds: [atlas.id] });
    const file = await hub.vaults.primary.read(`agents/${atlas.id}/skills/weekly-status-report/SKILL.md`);
    expect(file.content).toMatch(/^---\nname: weekly-status-report\n/);
    expect(file.content).toContain("# Weekly status report");

    const prompt = await promptFor(atlas.id);
    expect(prompt).toContain("## Your skills");
    expect(prompt).toContain("Write a weekly status report (me/skills/weekly-status-report/SKILL.md)");

    // installing the same catalog skill again reuses it
    expect((await api("POST", "/api/skills", { catalogId: "weekly-status-report" })).data.id).toBe(s.id);

    // edits reach the agent's copy
    await api("PATCH", `/api/skills/${s.id}`, { content: "# Weekly status report\n\nKeep it to five bullets." });
    expect((await hub.vaults.primary.read(`agents/${atlas.id}/skills/weekly-status-report/SKILL.md`)).content).toContain("five bullets");

    await api("DELETE", `/api/skills/${s.id}/agents/${atlas.id}`);
    await expect(hub.vaults.primary.read(`agents/${atlas.id}/skills/weekly-status-report/SKILL.md`)).rejects.toThrow();
    expect(await promptFor(atlas.id)).not.toContain("weekly-status-report");
  });

  it("gives every agent the built-in memory skill, which can't be removed", async () => {
    const path = `agents/${atlas.id}/skills/memory/SKILL.md`;
    expect((await hub.vaults.primary.read(path)).content).toMatch(/^---\nname: memory\n[\s\S]*# Keep memory tidy and linked/);
    expect(await promptFor(atlas.id)).toContain("Keep memory tidy and linked (me/skills/memory/SKILL.md)");
    expect(await promptFor(atlas.id)).toContain("follow your memory skill (me/skills/memory/SKILL.md)");
    // the shop can't add it, and a skill of your own can't take its folder
    expect((await api("POST", "/api/skills", { catalogId: "memory" })).status).toBe(404);
    expect((await api("POST", "/api/skills", { name: "Memory", content: "x" })).data.slug).toBe("memory-2");

    // deleted: it's back by the next run; edited: a restart puts the current version back
    await hub.vaults.primary.remove(path, { name: "Me", email: "me@example.com" });
    await promptFor(atlas.id);
    expect((await hub.vaults.primary.read(path)).content).toContain("# Keep memory tidy and linked");
    await hub.vaults.primary.write(path, "changed", { name: "Me", email: "me@example.com" });
    await hub.ensureBuiltinSkills(undefined, true);
    expect((await hub.vaults.primary.read(path)).content).toContain("# Keep memory tidy and linked");

    // the prompt still lists it when the agent has no other skills
    const fresh = (await api("POST", "/api/agents", { handle: "fresh", name: "Fresh", harness: "codex" })).data;
    expect((await hub.vaults.primary.read(`agents/${fresh.id}/skills/memory/SKILL.md`)).content).toContain("memory_remember");
  });

  it("creates your own skill with a unique slug", async () => {
    const a = (await api("POST", "/api/skills", { name: "Ship it", description: "Deploy the app", content: "1. Run deploy" })).data;
    const b = (await api("POST", "/api/skills", { name: "Ship it!", content: "x", agentIds: [atlas.id] })).data;
    expect([a.slug, b.slug, a.source]).toEqual(["ship-it", "ship-it-2", "custom"]);
    expect((await api("POST", "/api/skills", { name: "x", content: "y", agentIds: ["agt_nope"] })).status).toBe(400);
    await api("DELETE", `/api/skills/${b.id}`);
    await expect(hub.vaults.primary.read(`agents/${atlas.id}/skills/ship-it-2/SKILL.md`)).rejects.toThrow();
  });
});
