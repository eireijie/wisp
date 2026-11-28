/**
 * Live check for round 16, item 10: an app that lives on one device, used by an agent on another.
 *
 *   HOME=<scratch>/home tsx apps/hub/test/live/device-apps.live.ts <scratch>
 *
 * Starts a throwaway hub in this process and two real devices, each its own process with its own
 * HOME: "Sam's Mac" (B), where a small MCP server lives, and "Office PC" (A), where the agent runs.
 * On A, the agent's own Bubble AI tools (wisp-mcp, as its harness would start them) list the app
 * and call its tool; the hub asks B, which starts the server there and answers. Then B stops, and
 * the same call is answered at once with "Sam's Mac is offline". Writes report.json.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceAdapters } from "@bubble-ai/adapters";
import { WispClient } from "@bubble-ai/sdk";
import { createWispMcp } from "@bubble-ai/mcp/src/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NodeDaemon } from "../../../node/src/daemon.ts";

const dir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: device-apps.live.ts <scratch folder>");
if (!os.homedir().startsWith(dir)) throw new Error(`set HOME under ${dir} first (it is ${os.homedir()})`);
for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete process.env[k];
const role = process.argv[3];

const waitFor = async (what: string, ok: () => boolean | Promise<boolean>, ms = 5 * 60_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
const exists = (p: string) => fs.access(p).then(() => true, () => false);

if (role === "--device") {
  // one device: its own process and HOME, started by the part below
  const [, , , , name, hub, token, nodeDir, agentToken] = process.argv;
  const daemon = new NodeDaemon({ hub, token, name, dir: nodeDir, noPrepare: true }, (m) => console.log(`[${name}] ${m}`), deviceAdapters());
  daemon.start();
  if (agentToken) {
    // the agent on this device, with the Bubble AI tools its harness would start here
    const server = await createWispMcp(new WispClient({ url: hub, token: agentToken }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: "agent-on-office-pc", version: "0" });
    await mcp.connect(b);
    const textOf = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
    for (let i = 1; ; i++) {
      await waitFor(`go-${i}`, () => exists(path.join(nodeDir, `go-${i}`)), 10 * 60_000);
      const t = Date.now();
      const tools = (await mcp.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith("device_") || n === "connected_apps");
      const apps = textOf(await mcp.callTool({ name: "connected_apps", arguments: {} }));
      const listed = textOf(await mcp.callTool({ name: "device_apps", arguments: {} }));
      const t2 = Date.now();
      const called = (await mcp.callTool({ name: "device_app_call", arguments: { app: "mac-notes", tool: "where_am_i", arguments: { note: "groceries" } } })) as { isError?: boolean };
      const ms = Date.now() - t2;
      await fs.writeFile(path.join(nodeDir, `out-${i}.json`), JSON.stringify({ ranOn: name, home: os.homedir(), pid: process.pid, tools, connectedApps: apps, deviceApps: listed, call: { isError: !!called.isError, text: textOf(called), ms }, totalMs: Date.now() - t }, null, 2));
    }
  }
  await new Promise(() => {});
}

// --- the orchestrator: a hub here, two devices as their own processes ---------------------------
const { buildHub } = await import("../../src/app.ts");
const tsx = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/.bin/tsx");
const tsxBin = (await exists(tsx)) ? tsx : "/Users/yugpatel/kodi/node_modules/.bin/tsx";
const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
const { hub } = built;
await built.app.listen({ port: 0, host: "127.0.0.1" });
const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "sam@example.com", name: "Sam", password: `live-${Date.now()}`, features: "everything" }) })).json();
const owner = new WispClient({ url, token: setup.token });
const report: Record<string, unknown> = { hub: url };
const children: ChildProcess[] = [];

/** A device as its own process with its own HOME. */
async function device(name: string, slug: string, agentToken?: string) {
  const { node, token } = await owner.request<{ node: { id: string }; token: string }>("POST", "/api/nodes", { name });
  const home = path.join(dir, `home-${slug}`);
  const nodeDir = path.join(dir, `node-${slug}`);
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(nodeDir, { recursive: true });
  const env = { ...process.env, HOME: home };
  const child = spawn(tsxBin, [fileURLToPath(import.meta.url), dir, "--device", name, url, token, nodeDir, ...(agentToken ? [agentToken] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  child.stdout!.on("data", (d) => log.push(String(d).trim()));
  child.stderr!.on("data", (d) => log.push(String(d).trim()));
  children.push(child);
  await waitFor(`${name} to connect`, () => hub.isNodeOnline(node.id));
  return { node, nodeDir, home, child, log };
}

try {
  // B: the Mac, where the app lives. Its MCP server is a small script that says where it runs.
  const mac = await device("Sam's Mac", "mac");
  const sdk = path.dirname(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js")));
  const serverFile = path.join(dir, "mac-notes-server.mjs");
  await fs.writeFile(
    serverFile,
    `import os from "node:os";
import { McpServer } from ${JSON.stringify(path.join(sdk, "mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(path.join(sdk, "stdio.js"))};
import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
const s = new McpServer({ name: "mac-notes", version: "1" });
s.registerTool("where_am_i", { description: "Say which computer this runs on, and look up a note", inputSchema: { note: z.string().optional() } }, async ({ note }) => ({ content: [{ type: "text", text: "where_am_i ran with HOME=" + os.homedir() + " pid=" + process.pid + " note=" + (note ?? "") }] }));
await s.connect(new StdioServerTransport());
`,
  );
  const conn = await owner.request<{ id: string; nodeId: string }>("POST", "/api/connectors", { kind: "mcp-stdio", name: "Mac notes", command: process.execPath, args: [serverFile], nodeId: mac.node.id, allAgents: true });
  report.connector = { id: conn.id, nodeId: conn.nodeId, livesOn: "Sam's Mac" };
  await waitFor("the Mac to list the app's tools", () => hub.deviceApps.tools(conn.id).length > 0);
  report.toolsTheMacReported = hub.deviceApps.tools(conn.id).map((t) => t.name);

  // A: the PC, where the agent runs
  const agent = await owner.request<{ id: string }>("POST", "/api/agents", { handle: "rae", name: "Rae", harness: "custom" });
  const { token: agentToken } = await owner.request<{ token: string }>("POST", `/api/agents/${agent.id}/token`);
  const pc = await device("Office PC", "pc", agentToken);
  await owner.request("PATCH", `/api/agents/${agent.id}`, { nodeId: pc.node.id });
  report.agent = { id: agent.id, runsOn: "Office PC", nodeId: hub.store.agent(agent.id)?.nodeId };
  report.promptLine = hub.connectors.promptSection(agent.id, hub.deviceApps.lines(hub.store.agent(agent.id)!)).split("\n").find((l) => l.includes("mac-notes"));

  await fs.writeFile(path.join(pc.nodeDir, "go-1"), "");
  await waitFor("the agent's first call", () => exists(path.join(pc.nodeDir, "out-1.json")), 5 * 60_000);
  report.online = JSON.parse(await fs.readFile(path.join(pc.nodeDir, "out-1.json"), "utf8"));

  // B goes away
  mac.child.kill("SIGTERM");
  await waitFor("the Mac to go offline", () => !hub.isNodeOnline(mac.node.id));
  report.promptLineOffline = hub.connectors.promptSection(agent.id, hub.deviceApps.lines(hub.store.agent(agent.id)!)).split("\n").find((l) => l.includes("mac-notes"));
  await fs.writeFile(path.join(pc.nodeDir, "go-2"), "");
  await waitFor("the agent's call while the Mac is off", () => exists(path.join(pc.nodeDir, "out-2.json")), 5 * 60_000);
  report.offline = JSON.parse(await fs.readFile(path.join(pc.nodeDir, "out-2.json"), "utf8"));
  report.homes = { mac: mac.home, pc: pc.home };
  report.macLog = mac.log.filter((l) => /started|device_mcp|mac-notes/i.test(l)).slice(0, 10);
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  for (const c of children) c.kill("SIGTERM");
  await built.app.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(process.exitCode ?? 0);
}
