import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@warren/adapters";
import { WarrenClient } from "@warren/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WarrenClient;
const calls: RunInput[] = [];

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: input.sessionId ?? "sess-1" });
    onEvent({ type: "tool_call", name: "memory_search", input: {} });
    if (input.prompt.includes("explode")) throw new Error("harness crashed");
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
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123" }) })).json();
  owner = new WarrenClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  await owner.request("POST", "/api/agents", { handle: "bolt", name: "Bolt", harness: "custom", nodeId: node.id });
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
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
});
