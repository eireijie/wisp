import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter } from "@warren/adapters";
import { WarrenClient } from "@warren/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";

let dir: string;
let home: string;
let url: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WarrenClient;
let sam: WarrenClient;
let nodeId: string;
let atlasId: string;
/** what the agent's harness got back when it tried to change its settings */
const attempts: { status: number; body: any }[] = [];
/** the environment each run got */
const envs: Record<string, string>[] = [];

const config = () => fs.readFile(path.join(home, ".hermes", "config.yaml"), "utf8");

/** Hermes as far as the device can tell: installed, and during a run it asks Warren to switch its model. */
const hermes: HarnessAdapter = {
  id: "hermes",
  label: "Hermes",
  binary: "true",
  async catalog() {
    return { harness: "hermes", version: "1.0", models: [{ id: "gpt-5", label: "GPT-5" }], efforts: [] };
  },
  async run(input) {
    envs.push(input.env ?? {});
    // what it does depends on the message that woke it (the prompt's last line), not the history
    const last = input.prompt.trim().split("\n").pop() ?? "";
    if (last.includes("use the research account")) {
      const res = await fetch(`${input.mcp!.env!.WARREN_URL}/api/agent/harness-settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.mcp!.env!.WARREN_TOKEN}` },
        body: JSON.stringify({ useAccount: "Research" }),
      });
      attempts.push({ status: res.status, body: await res.json() });
    }
    if (last.includes("switch to gpt-5")) {
      const res = await fetch(`${input.mcp!.env!.WARREN_URL}/api/agent/harness-settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.mcp!.env!.WARREN_TOKEN}` },
        body: JSON.stringify({ changes: [{ op: "model", model: "gpt-5" }] }),
      });
      attempts.push({ status: res.status, body: await res.json() });
    }
    return { finalText: "done", sessionId: "s1" };
  },
};

const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 6000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => e.status as number);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-harness-settings-"));
  home = path.join(dir, "home");
  await fs.mkdir(path.join(home, ".hermes", "skills", "notes"), { recursive: true });
  await fs.writeFile(path.join(home, ".hermes", "config.yaml"), "model:\n  default: claude-sonnet-5.5\n  provider: openrouter\n");
  await fs.writeFile(path.join(home, ".hermes", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Keep notes\n---\nWrite them down.\n");
  const { app } = await buildHub({ dataDir: path.join(dir, "hub") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  const post = (p: string, body: unknown) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  owner = new WarrenClient({ url, token: (await post("/api/setup", { email: "me@example.com", name: "Me", password: "password123" })).token });
  await owner.request("PUT", "/api/features", { invite: true });
  const inv = await owner.request<{ code: string }>("POST", "/api/invites", { role: "member", days: 1 });
  sam = new WarrenClient({ url, token: (await post("/api/invites/accept", { code: inv.code, name: "Sam", email: "sam@example.com", password: "password123" })).token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  nodeId = node.id;
  // answers anyone, so Sam can ask it too (and be refused by the device check, not by who it answers)
  atlasId = (await owner.request<{ id: string }>("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "hermes", nodeId, settings: { respondTo: "anyone" } })).id;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node"), harnessHome: home, noPrepare: true }, () => {}, { hermes });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("harness settings", () => {
  it("shows the device's owner what its harnesses are set to", async () => {
    const r = await owner.request<any>("GET", `/api/nodes/${nodeId}/harness-settings`);
    expect(r.device.name).toBe("box");
    expect(r.harnesses.map((h: any) => h.harness)).toEqual(["hermes"]);
    expect(r.harnesses[0]).toMatchObject({ model: "claude-sonnet-5.5", provider: "openrouter", skills: [{ id: "notes", enabled: true }] });
    expect(r.agents).toEqual([expect.objectContaining({ handle: "atlas", harness: "hermes" })]);
  });

  it("changes the file on the device", async () => {
    const r = await owner.request<any>("PATCH", `/api/nodes/${nodeId}/harness-settings/hermes`, { changes: [{ op: "provider", provider: "anthropic" }, { op: "toggle", kind: "skill", id: "notes", enabled: false }] });
    expect(r).toMatchObject({ provider: "anthropic", skills: [{ id: "notes", enabled: false }] });
    expect(await config()).toBe("model:\n  default: claude-sonnet-5.5\n  provider: anthropic\nskills:\n  disabled:\n    - notes\n");
  });

  it("hands a skill over to share it", async () => {
    const f = await owner.request<any>("GET", `/api/nodes/${nodeId}/harness-settings/hermes/skills/notes`);
    expect(f).toMatchObject({ name: "notes", description: "Keep notes", content: expect.stringContaining("Write them down.") });
  });

  it("is the device owner's alone, even on a shared device", async () => {
    await owner.request("PATCH", `/api/nodes/${nodeId}`, { shared: true });
    expect(await status(sam.request("GET", `/api/nodes/${nodeId}/harness-settings`))).toBe(403);
    expect(await status(sam.request("PATCH", `/api/nodes/${nodeId}/harness-settings/hermes`, { changes: [{ op: "model", model: "x" }] }))).toBe(403);
    expect(await status(owner.request("PATCH", `/api/nodes/${nodeId}/harness-settings/hermes`, { changes: [{ op: "model", model: "bad\nvalue" }] }))).toBe(400);
    expect(await status(owner.request("PATCH", `/api/nodes/${nodeId}/harness-settings/grok`, { changes: [{ op: "model", model: "x" }] }))).toBe(400);
    // a harness that isn't on the device gets no config made for it
    expect(await status(owner.request("PATCH", `/api/nodes/${nodeId}/harness-settings/gemini`, { changes: [{ op: "model", model: "x" }] }))).toBe(422);
  });

  it("lets an agent change it when the device's owner asks, and no one else", async () => {
    const dm = await owner.request<{ id: string }>("POST", `/api/dm/${atlasId}`);
    await owner.send(dm.id, "@atlas switch to gpt-5 please");
    await waitFor(async () => (attempts.length ? true : undefined));
    expect(attempts[0]).toMatchObject({ status: 200, body: { device: "box", changed: ["model → gpt-5"], model: "gpt-5" } });
    expect(await config()).toContain("default: gpt-5\n");

    // Sam can talk to the agent on the shared device, but it can't change the owner's config for him
    const general = (await sam.channels()).find((c) => c.name === "general")!;
    await sam.send(general.id, "@atlas switch to gpt-5 now");
    await waitFor(async () => (attempts.length > 1 ? true : undefined));
    expect(attempts[1].status).toBe(403);
    expect(attempts[1].body.error).toMatch(/Only Me can change Hermes's settings on box/);
  });

  it("keeps several accounts of a harness, and runs each agent with its own", async () => {
    const added = await owner.request<any>("POST", `/api/nodes/${nodeId}/harness-accounts/hermes`, { op: "add", label: "Work" });
    expect(added).toMatchObject({ id: "work", label: "Work", isDefault: false, signedIn: false });
    await owner.request("POST", `/api/nodes/${nodeId}/harness-accounts/hermes`, { op: "add", label: "Research" });
    // each account has its own settings; the new one started from the default's
    const work = await owner.request<any>("GET", `/api/nodes/${nodeId}/harness-settings?harness=hermes&account=work`);
    expect(work.harnesses[0]).toMatchObject({ account: "work", model: "gpt-5", accounts: [{ id: "default" }, { id: "work" }, { id: "research" }] });
    await owner.request("PATCH", `/api/nodes/${nodeId}/harness-settings/hermes`, { account: "work", changes: [{ op: "model", model: "kimi-k3" }] });
    expect(await fs.readFile(path.join(home, ".hermes", "profiles", "work", "config.yaml"), "utf8")).toContain("default: kimi-k3");
    expect(await config()).toContain("default: gpt-5\n");

    // the agent runs with the account it was given
    await owner.request("POST", `/api/nodes/${nodeId}/harness-accounts/hermes`, { op: "assign", agentId: atlasId, account: "work" });
    const dm = await owner.request<{ id: string }>("POST", `/api/dm/${atlasId}`);
    const before = envs.length;
    await owner.send(dm.id, "@atlas hello");
    await waitFor(async () => (envs.length > before ? true : undefined));
    expect(envs.at(-1)!.HERMES_HOME).toBe(path.join(home, ".hermes", "profiles", "work"));

    // and can move itself to another one when its owner asks
    await owner.send(dm.id, "@atlas use the research account");
    await waitFor(async () => (attempts.length > 2 ? true : undefined));
    expect(attempts[2]).toMatchObject({ status: 200, body: { changed: ["now uses the Research account"], account: "research" } });
    const after = envs.length;
    await owner.send(dm.id, "@atlas hi again");
    await waitFor(async () => (envs.length > after ? true : undefined));
    expect(envs.at(-1)!.HERMES_HOME).toBe(path.join(home, ".hermes", "profiles", "research"));

    // only for agents on this device, and only by the device's owner
    expect(await status(owner.request("POST", `/api/nodes/${nodeId}/harness-accounts/hermes`, { op: "assign", agentId: "agt_nope", account: "work" }))).toBe(400);
    expect(await status(sam.request("POST", `/api/nodes/${nodeId}/harness-accounts/hermes`, { op: "add", label: "Mine" }))).toBe(403);
  });

  it("says how to sign in where it can't from Warren", async () => {
    expect(await status(owner.request("POST", `/api/nodes/${nodeId}/harness-accounts/goose`, { op: "add", label: "Two" }))).toBe(422);
  });
});
