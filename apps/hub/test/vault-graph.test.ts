import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;
let token: string;
let member: string;
let nodeToken: string;
let atlas: any;

async function api<T = any>(method: string, url: string, body?: unknown, auth = token, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}
const write = (p: string, content: string, auth = token, headers: Record<string, string> = {}) => api("PUT", "/api/vault/note", { path: p, content }, auth, headers);
const edges = (g: any) => g.edges.map((e: any) => `${e.source} -> ${e.target}`).sort();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-graph-"));
  const built = await buildHub({ dataDir: dir });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  token = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", workspaceName: "Test" }, "")).data.token;
  await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" });
  member = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
  const n = await api("POST", "/api/nodes", { name: "box" });
  nodeToken = n.data.token;
  atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "claude-code", nodeId: n.data.node.id })).data;

  await write("shared/Roadmap.md", "---\ntype: project\n---\n# Roadmap\nShip [[Launch]] with [[Plan]]. See [[Nowhere]] and ![[diagram.png]]. Also [[Roadmap]].");
  await write("shared/Plan.md", "# Shared plan\nBack to [[Roadmap|the roadmap]] and [[roadmap#Goals]]. #planning");
  await write("Projects/Launch.md", "# Launch\nPart of [[Roadmap]].");
  await write(`agents/${atlas.id}/Plan.md`, "# Atlas's plan", nodeToken, { "x-warren-agent": atlas.id });
  await write(`agents/${atlas.id}/Notes.md`, "# Notes\nMy [[Plan]], the [[Roadmap]] and [[Launch]].", nodeToken, { "x-warren-agent": atlas.id });
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("memory graph", () => {
  it("links notes Obsidian-style: by name, preferring the linking note's own folder", async () => {
    const g = (await api<any>("GET", "/api/vault/graph")).data;
    expect(edges(g)).toEqual(
      [
        "Projects/Launch.md -> shared/Roadmap.md",
        `agents/${atlas.id}/Notes.md -> Projects/Launch.md`,
        `agents/${atlas.id}/Notes.md -> agents/${atlas.id}/Plan.md`,
        `agents/${atlas.id}/Notes.md -> shared/Roadmap.md`,
        "shared/Plan.md -> shared/Roadmap.md",
        "shared/Roadmap.md -> Projects/Launch.md",
        "shared/Roadmap.md -> ghost:nowhere",
        "shared/Roadmap.md -> shared/Plan.md",
      ].sort(),
    );
    const node = (id: string) => g.nodes.find((n: any) => n.id === id);
    expect(node("shared/Roadmap.md")).toMatchObject({ title: "Roadmap", kind: "shared", type: "project", inbound: 3, links: 4 });
    expect(node("shared/Plan.md")).toMatchObject({ title: "Shared plan", tags: ["planning"] });
    expect(node("Projects/Launch.md").kind).toBe("other");
    expect(node(`agents/${atlas.id}/Plan.md`).kind).toBe("agents");
    expect(node("ghost:nowhere")).toMatchObject({ path: null, kind: "ghost", title: "nowhere", inbound: 1 });
    // skills and souls are machinery, not knowledge
    expect(g.nodes.some((n: any) => /(SKILL|SOUL)\.md$/.test(n.id))).toBe(false);
    // attachments aren't notes
    expect(g.nodes.some((n: any) => n.id.includes("diagram"))).toBe(false);
  });

  it("only shows notes the viewer can read, and a hidden note never leaks in", async () => {
    const asAtlas = (await api<any>("GET", "/api/vault/graph", undefined, nodeToken, { "x-warren-agent": atlas.id })).data;
    const ids = asAtlas.nodes.map((n: any) => n.id);
    expect(ids).not.toContain("Projects/Launch.md");
    // Atlas can't see Projects/Launch.md, so its [[Launch]] link is a ghost for it
    expect(edges(asAtlas)).toContain(`agents/${atlas.id}/Notes.md -> ghost:launch`);
    expect(asAtlas.edges.every((e: any) => e.source !== "Projects/Launch.md")).toBe(true);

    expect((await api("PUT", "/api/access", { path: "Projects", subject: { kind: "members" }, level: "none" })).status).toBe(200);
    const sam = (await api<any>("GET", "/api/vault/graph", undefined, member)).data;
    expect(sam.nodes.map((n: any) => n.id)).not.toContain("Projects/Launch.md");
    expect(sam.nodes.map((n: any) => n.id)).toContain("shared/Roadmap.md");
    expect(edges(sam)).toContain("shared/Roadmap.md -> ghost:launch");
  });

  it("lets owners, and only owners, view the graph as an agent", async () => {
    const viewed = (await api<any>("GET", `/api/vault/graph?as=agent:${atlas.id}`)).data;
    const own = (await api<any>("GET", "/api/vault/graph", undefined, nodeToken, { "x-warren-agent": atlas.id })).data;
    expect(edges(viewed)).toEqual(edges(own));
    expect((await api("GET", `/api/vault/graph?as=agent:${atlas.id}`, undefined, member)).status).toBe(403);
    expect((await api("GET", "/api/vault/graph", undefined, "")).status).toBe(401);
  });

  it("seeds a Welcome note that points to the built-in graph, not only Obsidian", async () => {
    const welcome = (await api<any>("GET", "/api/vault/note?path=shared/Welcome.md")).data;
    expect(welcome.content).toContain("**Graph** on the Memory page");
    // the `[[Note name]]` example in it is code, not a link to a missing note
    expect(welcome.links).toEqual([]);
  });
});
