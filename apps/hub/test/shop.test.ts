import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RegistryServer } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let orgId: string;
let owner: string;
let other: string;
let agentId: string;
let nodeId: string;

async function api<T = any>(method: string, url: string, body?: unknown, token: string | null = owner): Promise<{ status: number; data: T; res: Response }> {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data, res };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-shop-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", workspaceName: "Lab" }, null)).data;
  owner = setup.token;
  orgId = setup.workspace.id;
  await api("PUT", "/api/features", { invite: true });
  const invite = (await api("POST", "/api/invites", { role: "member", days: 1 })).data;
  other = (await api("POST", "/api/invites/accept", { code: invite.code, email: "you@example.com", name: "You", password: "password123" }, null)).data.token;
  expect(other).toBeTruthy();
  nodeId = (await api("POST", "/api/nodes", { name: "MacBook" })).data.node.id;
  agentId = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "claude-code", nodeId })).data.id;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("logos", () => {
  it("serves a brand's logo in its color, without a sign-in", async () => {
    const seen: string[] = [];
    hub.fetchImpl = async (url) => {
      seen.push(String(url));
      if (String(url).endsWith("/data/simple-icons.json")) return json([{ title: "Notion", hex: "000000" }, { title: "Google Calendar", slug: "googlecalendar", hex: "4285F4" }]);
      if (String(url).endsWith("/icons/googlecalendar.svg")) return new Response('<svg role="img" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>');
      return new Response("", { status: 404 });
    };
    const r = await api("GET", "/api/logo?for=Google%20Calendar%20MCP&for=mintmcp", undefined, null);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.data).toBe('<svg fill="#4285F4" role="img" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>');
    expect((await api("GET", "/api/logo?for=Square%20Root%20Calculator", undefined, null)).status).toBe(404);
    // the list and the SVG are fetched once
    await api("GET", "/api/logo?for=Google%20Calendar", undefined, null);
    expect(seen.filter((u) => u.endsWith("simple-icons.json")).length).toBe(1);
    expect(seen.filter((u) => u.endsWith("googlecalendar.svg")).length).toBe(1);
  });
});

describe("apps", () => {
  it("reads several pages of search results and gives each a logo and a shelf", async () => {
    const server = (n: number): RegistryServer => ({ name: `com.acme${n}/mcp`, description: "Send email from your inbox", remotes: [{ type: "streamable-http", url: `https://mcp.acme${n}.com/mcp` }] });
    const seen: string[] = [];
    hub.fetchImpl = async (url) => {
      seen.push(String(url));
      const page = String(url).includes("cursor=") ? 2 : 1;
      const servers = Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({ server: server(page * 1000 + i) }));
      return json({ servers, metadata: page === 1 ? { nextCursor: "next" } : {} });
    };
    const r = await api("GET", "/api/marketplace?q=acme");
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain("&cursor=next");
    expect(r.data.entries.length).toBe(103);
    expect(r.data.entries[0]).toMatchObject({ category: "Email and calendar", logos: [expect.stringMatching(/^\/api\/logo\?for=/)] });
  });
});

describe("public skills", () => {
  const SKILL = (name: string, license?: string) => `---\nname: ${name}\ndescription: Use when working with ${name} files.\n${license ? `license: ${license}\n` : ""}---\n\n# ${name}\n\nRead [the guide](reference.md) first.\n`;

  it("lists Anthropic's and OpenAI's skills with their licenses, and installs only open ones", async () => {
    hub.fetchImpl = async (input) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1")
        return json({ tree: ["skills/pdf/SKILL.md", "skills/pdf/LICENSE.txt", "skills/frontend-design/SKILL.md", "skills/frontend-design/LICENSE.txt", "template/SKILL.md"].map((p) => ({ path: p, type: "blob" })) });
      if (url === "https://api.github.com/repos/openai/skills/git/trees/main?recursive=1") return json({ tree: ["skills/.curated/linear/SKILL.md", "skills/.curated/linear/LICENSE.txt", "skills/.system/imagegen/SKILL.md"].map((p) => ({ path: p, type: "blob" })) });
      if (url.startsWith("https://api.github.com/repos/")) return json({ license: null });
      const raw = "https://raw.githubusercontent.com/";
      if (url === `${raw}anthropics/skills/main/skills/pdf/SKILL.md`) return new Response(SKILL("pdf", "Proprietary. LICENSE.txt has complete terms"));
      if (url === `${raw}anthropics/skills/main/skills/pdf/LICENSE.txt`) return new Response("© 2025 Anthropic, PBC. All rights reserved.");
      if (url === `${raw}anthropics/skills/main/skills/frontend-design/SKILL.md`) return new Response(SKILL("frontend-design", "Complete terms in LICENSE.txt"));
      if (url.endsWith("/LICENSE.txt")) return new Response("                                 Apache License\n                           Version 2.0, January 2004");
      if (url === `${raw}openai/skills/main/skills/.curated/linear/SKILL.md`) return new Response(SKILL("linear"));
      return new Response("", { status: 404 });
    };
    const list = (await api("GET", "/api/skill-store")).data;
    expect(list.errors).toEqual([]);
    expect(list.skills.map((s: any) => [s.id, s.name, s.source.label, s.license.label, s.license.open])).toEqual([
      ["anthropic:pdf", "PDF", "Anthropic", "Proprietary", false],
      ["anthropic:frontend-design", "Frontend design", "Anthropic", "Apache-2.0", true],
      ["openai:linear", "Linear", "OpenAI", "Apache-2.0", true],
    ]);
    expect(list.skills[2].url).toBe("https://github.com/openai/skills/tree/main/skills/.curated/linear");

    // a proprietary one is read at its source, never copied
    expect((await api("GET", "/api/skill-store/anthropic:pdf")).data.content).toBeNull();
    const refused = await api("POST", "/api/skills", { storeId: "anthropic:pdf", agentIds: [agentId] });
    expect(refused.status).toBe(403);
    expect(refused.data.error).toContain("https://github.com/anthropics/skills/tree/main/skills/pdf");

    const added = await api("POST", "/api/skills", { storeId: "openai:linear", agentIds: [agentId] });
    expect(added.status).toBe(200);
    expect(added.data).toMatchObject({ name: "Linear", source: "catalog", catalogId: "openai:linear", agentIds: [agentId], tags: ["openai"] });
    expect(added.data.content).toContain("](https://raw.githubusercontent.com/openai/skills/main/skills/.curated/linear/reference.md)");
    expect(added.data.content).toContain("From OpenAI's public skills: https://github.com/openai/skills/tree/main/skills/.curated/linear (Apache-2.0)");
    const file = await hub.vault(orgId).read(`agents/${agentId}/skills/${added.data.slug}/SKILL.md`);
    expect(file.content).toContain("# linear");
    // adding it again gives the same skill
    expect((await api("POST", "/api/skills", { storeId: "openai:linear", agentIds: [] })).data.id).toBe(added.data.id);
  });
});

describe("what your devices already have", () => {
  it("shows a device's skills and apps only to the person who connected it", async () => {
    hub.shelves.set(nodeId, [
      { key: "claude-code:skill:pdf", harness: "claude-code", kind: "skill", name: "pdf", description: "PDFs", path: "~/.claude" },
      { key: "codex:mcp:github", harness: "codex", kind: "mcp", name: "github", path: "~/.codex/config.toml", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], secrets: ["GITHUB_TOKEN"] },
    ]);
    const mine = (await api("GET", "/api/shelf")).data;
    expect(mine).toEqual([{ nodeId, nodeName: "MacBook", online: false, items: expect.any(Array) }]);
    expect(mine[0].items.length).toBe(2);
    expect((await api("GET", "/api/shelf", undefined, other)).data).toEqual([]);
  });

  it("brings a device's skill into Wisp and shares it with agents", async () => {
    const asked: unknown[] = [];
    const real = hub.computers.nodeRequest.bind(hub.computers);
    hub.computers.nodeRequest = async (id, build) => {
      asked.push(build("r1"));
      return { name: "pdf", description: "Work with PDF files", content: "---\nname: pdf\ndescription: Work with PDF files\n---\n\n# PDF\n\nDo things.\n" };
    };
    try {
      const r = await api("POST", "/api/skills", { nodeId, harness: "claude-code", skillId: "pdf", agentIds: [agentId] });
      expect(r.status).toBe(200);
      expect(asked).toEqual([{ type: "harness_skill", requestId: "r1", harness: "claude-code", id: "pdf" }]);
      expect(r.data).toMatchObject({ name: "PDF", description: "Work with PDF files", source: "custom", catalogId: `device:${nodeId}:claude-code:pdf`, content: "# PDF\n\nDo things.", agentIds: [agentId] });
      // someone else can't read your device's skills
      expect((await api("POST", "/api/skills", { nodeId, harness: "claude-code", skillId: "pdf", agentIds: [] }, other)).status).toBe(404);
    } finally {
      hub.computers.nodeRequest = real;
    }
  });
});
