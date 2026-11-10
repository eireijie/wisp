import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * The browser tools of an agent whose computer may be off. Harnesses start their MCP servers as a
 * run begins, and the real browser tools (Playwright MCP) run inside the VM: starting them there
 * would start the computer for every chat reply. This stands in until a browser tool is used:
 * it answers the handshake and the tool list (from the last time the real one ran here), and on
 * the first call asks the hub to start the computer (which shows "Starting the computer…" in
 * chat), then starts the real tools in the VM and relays everything both ways.
 *
 * Agents on the shared computer share its one Chrome (that's how they share sign-ins), and each
 * agent's tools would otherwise drive the same tab, so one agent's page load cuts off another's.
 * So each run opens a tab of its own as the tools start, and closes it when the run ends.
 */

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

export interface ProxyOptions {
  /** the real tools: a command that runs Playwright MCP in the VM */
  command: string[];
  /** the tool list saved from the last real run, so listing tools doesn't start the computer */
  toolsFile: string;
  /** start the computer (through the hub, so it counts as use and shows in chat) */
  start: () => Promise<void>;
  write: (m: Msg) => void;
  spawnChild?: (command: string[]) => ChildProcess;
}

export class BrowserProxy {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private init: Msg | null = null;
  private listIds = new Set<number | string>();
  private nextId = 1;
  /** answers to calls this proxy makes itself (its own tab), kept from the harness */
  private own = new Map<string, (r: Msg) => void>();

  constructor(private o: ProxyOptions) {}

  private cachedTools(): unknown[] | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.o.toolsFile, "utf8")) as { tools?: unknown[] };
      return Array.isArray(v.tools) && v.tools.length ? v.tools : null;
    } catch {
      return null;
    }
  }

  async handle(m: Msg): Promise<void> {
    if (m.method === "initialize") {
      this.init = m;
      const asked = (m.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-06-18";
      return this.o.write({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: "wisp-browser", version: "1" } } });
    }
    if (m.method === "notifications/initialized") return;
    if (!this.child && m.method === "tools/list") {
      const tools = this.cachedTools();
      if (tools) return this.o.write({ jsonrpc: "2.0", id: m.id, result: { tools } });
    }
    if (!this.child && m.method === "ping") return this.o.write({ jsonrpc: "2.0", id: m.id, result: {} });
    // anything that needs the real tools: start the computer and them, then pass it on
    if (!this.child && m.id === undefined) return; // a notification for tools that aren't running yet
    try {
      await this.up();
    } catch (err) {
      if (m.id !== undefined) this.o.write({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `couldn't start the computer for the browser: ${(err as Error).message}` } });
      return;
    }
    if (m.method === "tools/list" && m.id !== undefined) this.listIds.add(m.id);
    this.child!.stdin!.write(JSON.stringify(m) + "\n");
  }

  private up(): Promise<void> {
    if (this.child) return Promise.resolve();
    this.starting ??= (async () => {
      await this.o.start();
      const child = (this.o.spawnChild ?? ((c) => spawn(c[0], c.slice(1), { stdio: ["pipe", "pipe", "inherit"] })))(this.o.command);
      // the real tools get the same handshake the harness gave this one; its answer stays here
      const initId = `wisp-init-${this.nextId++}`;
      const ready = new Promise<void>((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          let r: Msg;
          try {
            r = JSON.parse(line) as Msg;
          } catch {
            return;
          }
          const mine = typeof r.id === "string" ? this.own.get(r.id) : undefined;
          if (mine) {
            this.own.delete(r.id as string);
            mine(r);
            return;
          }
          if (r.id === initId) {
            if (r.error) reject(new Error(JSON.stringify(r.error)));
            else resolve();
            return;
          }
          if (r.id !== undefined && this.listIds.delete(r.id)) this.saveTools(r);
          this.o.write(r);
        });
        child.once("exit", (code) => {
          reject(new Error(`the browser tools stopped (exit ${code})`));
          if (this.child === child) this.child = null;
        });
        child.once("error", reject);
      });
      const params = (this.init?.params as object | undefined) ?? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wisp", version: "1" } };
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: initId, method: "initialize", params }) + "\n");
      await ready;
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      this.child = child;
      // a tab of its own, so other agents on this computer don't navigate it away
      await this.ask("tools/call", { name: "browser_tabs", arguments: { action: "new" } }, 30_000).catch(() => {});
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  private saveTools(r: Msg) {
    const tools = (r.result as { tools?: unknown[] } | undefined)?.tools;
    if (!Array.isArray(tools) || !tools.length) return;
    try {
      fs.mkdirSync(path.dirname(this.o.toolsFile), { recursive: true });
      fs.writeFileSync(this.o.toolsFile, JSON.stringify({ tools }));
    } catch {}
  }

  /** A call of this proxy's own to the real tools; its answer doesn't reach the harness. */
  private ask(method: string, params: unknown, ms: number): Promise<Msg> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("not running"));
    const id = `wisp-own-${this.nextId++}`;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.own.delete(id);
        reject(new Error("timed out"));
      }, ms);
      this.own.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Close its own tab (the one it's on), then stop the real tools. */
  async close() {
    if (!this.child) return;
    try {
      const r = await this.ask("tools/call", { name: "browser_tabs", arguments: { action: "list" } }, 5000);
      const text = ((r.result as { content?: { text?: string }[] } | undefined)?.content ?? []).map((c) => c.text ?? "").join("\n");
      const tabs = text.match(/^- \d+:/gm)?.length ?? 0;
      const current = text.match(/^- (\d+): \(current\)/m)?.[1];
      // never the last tab: closing it would close the browser for everyone
      if (current !== undefined && tabs > 1) await this.ask("tools/call", { name: "browser_tabs", arguments: { action: "close", index: Number(current) } }, 5000);
    } catch {}
    this.child?.kill();
  }
}

/** Run as the harness's MCP server: env WISP_URL, WISP_TOKEN, WISP_RUN, WISP_BROWSER_CMD (JSON), WISP_BROWSER_TOOLS. */
export async function main() {
  const env = process.env;
  const command = JSON.parse(env.WISP_BROWSER_CMD ?? "[]") as string[];
  const hub = (env.WISP_URL ?? "").replace(/\/+$/, "");
  const proxy = new BrowserProxy({
    command,
    toolsFile: env.WISP_BROWSER_TOOLS ?? "",
    write: (m) => process.stdout.write(JSON.stringify(m) + "\n"),
    start: async () => {
      const res = await fetch(`${hub}/api/computers/mine/act`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.WISP_TOKEN}`, ...(env.WISP_RUN ? { "x-wisp-run": env.WISP_RUN } : {}) },
        body: JSON.stringify({ action: { action: "start" } }),
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the hub said ${res.status}`);
    },
  });
  const lines = readline.createInterface({ input: process.stdin });
  // one at a time, in order, like a real server reading its input
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    let m: Msg;
    try {
      m = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    chain = chain.then(() => proxy.handle(m)).catch(() => {});
  });
  const end = () =>
    void chain.finally(async () => {
      await proxy.close();
      process.exit(0);
    });
  lines.on("close", end);
  process.once("SIGTERM", end);
}
