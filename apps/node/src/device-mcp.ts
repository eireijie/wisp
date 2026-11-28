import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ConnectorSpec } from "@bubble-ai/core";

/** A server nobody used for this long is stopped (it starts again on the next call). */
const IDLE_MS = 5 * 60_000;
/** At most this many of this device's apps running at once for agents elsewhere. */
const MAX_RUNNING = 8;

type Running = { key: string; client: Client; lastUsed: number; ready: Promise<void> };

/**
 * Apps that live on this device, run for agents on the owner's other devices: the hub asks for an
 * app's tools or for a call (a `device_mcp` message), and this starts the app's MCP server here
 * (its command, as the connector says) and keeps it running for a few minutes in case more follow.
 */
export class DeviceMcp {
  private running = new Map<string, Running>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private log: (msg: string) => void = () => {}) {}

  async handle(connectorId: string, spec: ConnectorSpec, op: "list" | "call", tool?: string, args?: Record<string, unknown>): Promise<unknown> {
    if (spec.kind !== "mcp-stdio" || !spec.command) throw new Error("only an app that runs a command lives on a device");
    const r = await this.start(connectorId, spec);
    r.lastUsed = Date.now();
    if (op === "list") {
      const { tools } = await r.client.listTools();
      return { tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })) };
    }
    if (!tool) throw new Error("which tool?");
    const out = await r.client.callTool({ name: tool, arguments: args ?? {} });
    r.lastUsed = Date.now();
    return { content: (out.content as unknown[]) ?? [], ...(out.isError ? { isError: true } : {}) };
  }

  private async start(connectorId: string, spec: ConnectorSpec): Promise<Running> {
    // a changed command, arguments or values means a new server
    const key = crypto.createHash("sha256").update(JSON.stringify([spec.command, spec.args ?? [], spec.env ?? {}])).digest("hex");
    const have = this.running.get(connectorId);
    if (have && have.key === key) {
      await have.ready;
      return have;
    }
    if (have) await this.stop(connectorId);
    if (this.running.size >= MAX_RUNNING) {
      const oldest = [...this.running.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) await this.stop(oldest[0]);
    }
    const transport = new StdioClientTransport({ command: spec.command!, args: spec.args ?? [], env: { ...getDefaultEnvironment(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(spec.env ?? {}) }, stderr: "ignore" });
    const client = new Client({ name: "bubble-ai-device", version: "0.1" });
    const r: Running = { key, client, lastUsed: Date.now(), ready: client.connect(transport) };
    this.running.set(connectorId, r);
    transport.onclose = () => {
      if (this.running.get(connectorId) === r) this.running.delete(connectorId);
    };
    try {
      await r.ready;
    } catch (e) {
      this.running.delete(connectorId);
      await client.close().catch(() => {});
      throw new Error(`couldn't start ${spec.name}: ${(e as Error).message}`);
    }
    this.log(`started ${spec.name} for agents on other devices`);
    this.timer ??= setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
    return r;
  }

  private async stop(connectorId: string) {
    const r = this.running.get(connectorId);
    this.running.delete(connectorId);
    await r?.client.close().catch(() => {});
  }

  private sweep() {
    for (const [id, r] of this.running) if (Date.now() - r.lastUsed > IDLE_MS) void this.stop(id);
    if (!this.running.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async close() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
