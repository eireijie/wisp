import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserProxy } from "../src/computers/browser-proxy.ts";

/** A tiny stand-in for Playwright MCP: answers initialize, lists one tool, echoes calls. */
const FAKE_MCP = `
const rl = require("readline").createInterface({ input: process.stdin });
let inited = false;
rl.on("line", (l) => {
  const m = JSON.parse(l);
  const out = (r) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }) + "\\n");
  if (m.method === "initialize") { inited = true; return out({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pw" } } }); }
  if (!inited) return out({ error: { code: -1, message: "not initialized" } });
  if (m.method === "tools/list") return out({ result: { tools: [{ name: "browser_navigate", inputSchema: { type: "object" } }] } });
  if (m.method === "tools/call") return out({ result: { content: [{ type: "text", text: "went to " + m.params.arguments.url }] } });
});`;

function setup(cache?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-proxy-"));
  const toolsFile = path.join(dir, "tools.json");
  if (cache) fs.writeFileSync(toolsFile, JSON.stringify(cache));
  const out: any[] = [];
  let starts = 0;
  const proxy = new BrowserProxy({ command: [process.execPath, "-e", FAKE_MCP], toolsFile, start: async () => void starts++, write: (m) => void out.push(m) });
  const reply = async (id: number) => {
    for (let i = 0; i < 200 && !out.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 10));
    return out.find((m) => m.id === id);
  };
  return { proxy, out, reply, toolsFile, starts: () => starts };
}

describe("browser tools for a computer that may be off", () => {
  it("answers the handshake and tool list without starting the computer", async () => {
    const t = setup({ tools: [{ name: "browser_navigate" }] });
    await t.proxy.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await t.proxy.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    await t.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await t.reply(1)).result.protocolVersion).toBe("2025-06-18");
    expect((await t.reply(2)).result.tools[0].name).toBe("browser_navigate");
    expect(t.starts()).toBe(0);
    t.proxy.close();
  });

  it("starts the computer on the first browser call, then relays to the real tools", async () => {
    const t = setup({ tools: [{ name: "browser_navigate" }] });
    await t.proxy.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await t.proxy.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "etsy.com" } } });
    expect((await t.reply(3)).result.content[0].text).toBe("went to etsy.com");
    await t.proxy.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "x.com" } } });
    expect((await t.reply(4)).result.content[0].text).toBe("went to x.com");
    expect(t.starts()).toBe(1);
    t.proxy.close();
  });

  it("without a saved list, gets it from the real tools once and keeps it", async () => {
    const t = setup();
    await t.proxy.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await t.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await t.reply(2)).result.tools[0].name).toBe("browser_navigate");
    expect(JSON.parse(fs.readFileSync(t.toolsFile, "utf8")).tools[0].name).toBe("browser_navigate");
    t.proxy.close();
  });

  it("says why when the computer can't start", async () => {
    const t = setup({ tools: [{ name: "browser_navigate" }] });
    const proxy = new BrowserProxy({ command: ["false"], toolsFile: t.toolsFile, start: async () => Promise.reject(new Error("the device is offline")), write: (m) => void t.out.push(m) });
    await proxy.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_navigate", arguments: {} } });
    expect((await t.reply(5)).error.message).toMatch(/device is offline/);
  });
});
