import type { Agent, DeviceApp, DeviceTool } from "@bubble-ai/core";
import { now } from "./auth.ts";
import type { Hub } from "./hub.ts";

/** A refusal or failure with words for the agent, and the HTTP status to send. */
export class DeviceAppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** How long listing a device's tools may take (starting the server included). */
const LIST_TIMEOUT_MS = 30_000;
/** How long one tool call may take. */
const CALL_TIMEOUT_MS = 120_000;
/** Most tools kept per app. */
const MAX_TOOLS = 100;

type ToolsRow = { connector_id: string; node_id: string; tools_json: string; error: string | null; checked_at: string };

/**
 * Apps that live on one device: a connector's command that runs there (Connector.nodeId). Agents
 * on that device start it themselves, like any connector. Agents on the owner's other devices (or
 * the server, or a VM) reach its tools through the hub, which asks the device to call them, the way
 * the Apple mod asks the Mac. The device's tools are listed when it connects and kept, so an agent
 * still sees them while it's offline, marked unavailable, and a call fails at once with words to pass on.
 *
 * Who may: the agent has the connector (the usual rules), and the device is its owner's own, or
 * shared with the workspace, or one the agent may use (Use my computers). On someone's own device
 * that isn't shared, it's only for things that device's owner asked for.
 */
export class DeviceApps {
  constructor(private hub: Hub) {}

  private cached(connectorId: string): ToolsRow | undefined {
    return this.hub.store.db.prepare("SELECT * FROM device_tools WHERE connector_id = ?").get(connectorId) as ToolsRow | undefined;
  }

  private save(connectorId: string, nodeId: string, tools: DeviceTool[] | null, error: string | null) {
    const was = this.cached(connectorId);
    const json = tools ? JSON.stringify(tools) : (was?.node_id === nodeId ? was.tools_json : "[]");
    this.hub.store.db
      .prepare("INSERT INTO device_tools (connector_id, node_id, tools_json, error, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(connector_id) DO UPDATE SET node_id = excluded.node_id, tools_json = excluded.tools_json, error = excluded.error, checked_at = excluded.checked_at")
      .run(connectorId, nodeId, json, error, now());
  }

  /** The tools a device-local app offers, as its device last said (empty before it has). */
  tools(connectorId: string): DeviceTool[] {
    const r = this.cached(connectorId);
    return r ? (JSON.parse(r.tools_json) as DeviceTool[]) : [];
  }

  /** Ask a device for the tools of every app that lives on it, and keep them. Errors are kept, not thrown. */
  async refreshNode(nodeId: string): Promise<void> {
    const ids = this.hub.connectors.onDevice(nodeId);
    await Promise.all(ids.map((cid) => this.refresh(cid).catch(() => {})));
    if (ids.length) {
      const ws = this.hub.store.node(nodeId)?.workspaceId;
      if (ws) this.hub.broadcast(ws, { type: "skills_changed" });
    }
  }

  /** Ask the app's device for its tools now. */
  async refresh(connectorId: string): Promise<DeviceTool[]> {
    const conn = this.hub.connectors.get(connectorId);
    const spec = this.hub.connectors.specFor(connectorId);
    if (!conn?.nodeId || !spec || conn.kind !== "mcp-stdio") return [];
    if (!this.hub.isNodeOnline(conn.nodeId)) return this.tools(connectorId);
    try {
      const r = (await this.hub.computers.nodeRequest(conn.nodeId, (requestId) => ({ type: "device_mcp", requestId, connectorId, spec, op: "list" }), LIST_TIMEOUT_MS)) as { tools?: DeviceTool[] };
      const tools = (r?.tools ?? []).slice(0, MAX_TOOLS).map((t) => ({ name: String(t.name).slice(0, 128), description: String(t.description ?? "").slice(0, 1000), ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema } : {}) }));
      this.save(connectorId, conn.nodeId, tools, null);
      return tools;
    } catch (e) {
      this.save(connectorId, conn.nodeId, null, (e as Error).message.slice(0, 500));
      throw e;
    }
  }

  /** Why this agent can't use apps on that device at all (someone else's, not shared), or null. */
  private refused(agent: Agent, nodeId: string): string | null {
    const { store } = this.hub;
    const node = store.node(nodeId);
    if (!node || node.workspaceId !== agent.workspaceId) return "Its device was removed from Bubble AI.";
    if (node.shared || !node.ownerId) return null;
    // an agent on the server or the shared computer has no device of its own: the call still has to be for the owner
    const mine = agent.nodeId && this.hub.harnessOnDevice(agent) ? store.node(agent.nodeId)?.ownerId : null;
    if (!mine || mine === node.ownerId || agent.settings.useDevices?.[nodeId]) return null;
    const owner = store.user(node.ownerId);
    return `${node.name} is ${owner?.name ?? "someone"}'s own device and isn't shared, so you can't use its apps. ${owner?.name ?? "They"} can share it under Computers.`;
  }

  /** The agent's apps that live on other devices, with whether each can be used now. */
  forAgent(agent: Agent): DeviceApp[] {
    const { store } = this.hub;
    return this.hub.connectors.deviceRows(agent.id).map((r) => {
      const node = store.node(r.nodeId);
      const device = node?.name ?? "its device";
      const online = this.hub.isNodeOnline(r.nodeId);
      const paused = this.hub.isNodePaused(r.nodeId);
      const unavailable =
        this.refused(agent, r.nodeId) ??
        (!online ? `${device} is offline, so you can't use it right now. If a task needs it, say so.` : paused ? `${device} is paused, so you can't use it right now.` : null);
      return { name: r.name, title: r.title, connectorId: r.id, nodeId: r.nodeId, device, online, unavailable, tools: this.tools(r.id) };
    });
  }

  /** For the prompt's list of apps. */
  lines(agent: Agent) {
    const rows = new Map(this.hub.connectors.deviceRows(agent.id).map((r) => [r.id, r]));
    return this.forAgent(agent).map((d) => ({ ...d, catalogId: rows.get(d.connectorId)?.catalogId ?? null }));
  }

  /**
   * Call a tool of an app living on another device, for work `requester` asked for. Offline, or not
   * allowed, fails at once with words for the agent; the device's answer (MCP content) comes back as is.
   */
  async call(agent: Agent, appName: string, tool: string, args: Record<string, unknown>, requester: string | null): Promise<{ content: unknown[]; isError?: boolean }> {
    const { store } = this.hub;
    const want = appName.trim().toLowerCase();
    const apps = this.forAgent(agent);
    const app = apps.find((a) => a.name === want) ?? apps.find((a) => a.title.toLowerCase() === want);
    if (!app) {
      // it may run where the agent does: then it's an ordinary connector
      throw new DeviceAppError(apps.length ? `There's no app "${appName}" on your other devices. Yours: ${apps.map((a) => a.name).join(", ")}.` : `You have no apps on other devices. Apps where you run are your own MCP tools.`, 404);
    }
    if (app.unavailable) throw new DeviceAppError(app.unavailable, app.online ? 403 : 503);
    const node = store.node(app.nodeId)!;
    if (!node.shared && node.ownerId && requester !== node.ownerId) {
      const owner = store.user(node.ownerId)?.name ?? "its owner";
      throw new DeviceAppError(`${app.title} lives on ${node.name}, ${owner}'s own device, so you can only use it for things ${owner} asked for.`, 403);
    }
    if (app.tools.length && !app.tools.some((t) => t.name === tool)) throw new DeviceAppError(`${app.title} has no tool "${tool}". Its tools: ${app.tools.map((t) => t.name).join(", ")}.`, 404);
    const spec = this.hub.connectors.specFor(app.connectorId);
    if (!spec) throw new DeviceAppError(`${app.title} was removed.`, 404);
    try {
      const r = (await this.hub.computers.nodeRequest(app.nodeId, (requestId) => ({ type: "device_mcp", requestId, connectorId: app.connectorId, spec, op: "call", tool, args }), CALL_TIMEOUT_MS)) as { content?: unknown[]; isError?: boolean };
      return { content: Array.isArray(r?.content) ? r.content : [], ...(r?.isError ? { isError: true } : {}) };
    } catch (e) {
      // it went away mid-call
      if (!this.hub.isNodeOnline(app.nodeId)) throw new DeviceAppError(`${node.name} went offline, so ${app.title} couldn't finish.`, 503);
      throw new DeviceAppError(`${app.title} on ${node.name} failed: ${(e as Error).message}`, 502);
    }
  }
}
