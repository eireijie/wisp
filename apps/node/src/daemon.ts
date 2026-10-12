import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HubToNode, readTunnelFrame, tunnelFrame, type AccessLevel, type Agent, type HarnessCatalog, type NodeToHub, type RunRequest } from "@warren/core";
import { deviceAdapters, type DeviceHarness, type HarnessAdapter, type McpServerSpec } from "@warren/adapters";
import { WarrenClient } from "@warren/sdk";
import { runUpdate, version } from "@warren/update";
import { ComputerHost, type Tunnel } from "./computers/index.ts";
import { discoverAgents, readDiscovered } from "./discover.ts";
import { mergeBranch, prepareCheckout } from "./git.ts";

const MCP_BIN = fileURLToPath(new URL("../../../bin/warren-mcp.mjs", import.meta.url));

export interface NodeConfig {
  hub: string;
  token: string;
  name: string;
  dir: string; // state + agent working directories
  /** per-harness extras passed to adapters */
  harnessOptions?: Record<string, Record<string, string>>;
  /**
   * Let agents on this device run with "full" access (no sandbox, no permission checks).
   * Off by default: the device owner opts in here, not the hub. It also lets agents run shell
   * commands through this device's screen computer.
   */
  allowFullAccess?: boolean;
  /** change how ACP harnesses start here, or add this device's own ("acp:<name>") */
  harnesses?: Record<string, DeviceHarness>;
  /** "docker" or "podman" for VMs; default: whichever is installed */
  vmEngine?: string;
  /**
   * Offer this device's own screen to its owner, who can lend it to agents. Off by default, and
   * only someone at the device can turn it on (`warren node screen on`), not the hub.
   */
  shareScreen?: boolean;
  /** never offer this device's own screen, whatever shareScreen says (older setting) */
  noScreen?: boolean;
  /** `warren node pause`: take no work from the hub (no agent runs, no computer use) until resumed */
  paused?: boolean;
  /** where to look for existing agents (default: the home folder); for tests */
  discoverHome?: string;
}

type Log = (msg: string) => void;

/**
 * The node daemon. Keeps an outbound WebSocket to the hub, runs each agent's
 * harness headlessly when it is mentioned, and streams the output back.
 */
export class NodeDaemon {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  private queues = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  private sessions: Record<string, string>;
  private api: WarrenClient;
  private catalog: Promise<HarnessCatalog[]> | null = null;
  private registry: Record<string, HarnessAdapter>;
  readonly computers: ComputerHost;
  private tunnels = new Map<string, Tunnel>();
  /** per-agent tokens for harnesses, so a harness never holds this device's own token */
  private agentTokens: Record<string, string>;
  /** shareScreen and paused, as last read from node.json (people change them there with the CLI) */
  private local: { shareScreen: boolean; paused: boolean };

  constructor(
    private cfg: NodeConfig,
    private log: Log = (m) => console.log(`[warren] ${m}`),
    registry?: Record<string, HarnessAdapter>,
    computers?: ComputerHost,
  ) {
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.sessions = readJson(this.sessionsFile, {});
    this.agentTokens = readJson(this.tokensFile, {});
    this.local = this.readLocal();
    this.api = new WarrenClient({ url: cfg.hub, token: cfg.token });
    this.registry = registry ?? deviceAdapters(cfg.harnesses);
    this.computers = computers ?? new ComputerHost({ dir: cfg.dir, vmEngine: cfg.vmEngine, allowDeviceShell: cfg.allowFullAccess, log });
  }

  private get sessionsFile() {
    return path.join(this.cfg.dir, "sessions.json");
  }

  private get tokensFile() {
    return path.join(this.cfg.dir, "agent-tokens.json");
  }

  private get configFile() {
    return path.join(this.cfg.dir, "node.json");
  }

  /** The switches people flip at the device: node.json wins over what this process started with. */
  private readLocal() {
    const file = readJson<Partial<NodeConfig>>(this.configFile, {});
    return { shareScreen: !!(file.shareScreen ?? this.cfg.shareScreen) && !(file.noScreen ?? this.cfg.noScreen), paused: !!(file.paused ?? this.cfg.paused) };
  }

  /** Someone ran `warren node screen …` or `warren node pause/resume`: apply it now. */
  private onLocalChange = () => {
    const before = this.local;
    this.local = this.readLocal();
    if (before.shareScreen === this.local.shareScreen && before.paused === this.local.paused) return;
    if (this.local.paused && !before.paused) {
      this.log("paused: stopping agents and computers until `warren node resume`");
      for (const a of this.aborts.values()) a.abort("paused");
    }
    if (this.local.paused || !this.local.shareScreen) {
      this.computers.stopAll();
      for (const t of this.tunnels.values()) t.close();
      this.tunnels.clear();
    }
    if (!before.paused && !this.local.paused) this.log(`this screen is now ${this.local.shareScreen ? "shared with you in Warren (agents only when you lend it)" : "off"}`);
    if (before.paused && !this.local.paused) this.log("resumed");
    void this.sendCapabilities();
  };

  private async sendCapabilities() {
    const caps = await this.computers.capabilities();
    if (!this.local.shareScreen && caps.screen.ok) caps.screen = { ok: false, off: true, detail: "Off. Only someone at this device can turn it on: `warren node screen on`" };
    caps.paused = this.local.paused;
    this.send({ type: "capabilities", capabilities: caps });
  }

  start() {
    this.stopped = false;
    fs.watchFile(this.configFile, { interval: 1000 }, this.onLocalChange);
    if (this.local.paused) this.log("paused: no agent runs or computer use until `warren node resume`");
    this.connect();
  }

  stop() {
    this.stopped = true;
    fs.unwatchFile(this.configFile, this.onLocalChange);
    for (const a of this.aborts.values()) a.abort();
    this.computers.stopAll();
    for (const t of this.tunnels.values()) t.close();
    this.tunnels.clear();
    this.ws?.close();
  }

  /** Resolves once no agent is running on this device, so a restart doesn't cut one off. */
  async idle(): Promise<void> {
    while (this.aborts.size) await new Promise((r) => setTimeout(r, 2000));
  }

  private connect() {
    const url = this.cfg.hub.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/node";
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.cfg.token}` } });
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 1000;
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const frame = readTunnelFrame(new Uint8Array(raw as Buffer));
        if (frame) this.tunnels.get(frame.tunnelId)?.write(frame.payload);
        return;
      }
      let msg: HubToNode;
      try {
        msg = HubToNode.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    ws.on("close", (code, reason) => {
      // live views and tunnels belong to this connection; the hub asks again after a reconnect
      this.computers.stopAll();
      for (const t of this.tunnels.values()) t.close();
      this.tunnels.clear();
      if (this.stopped) return;
      if (code === 4401) {
        this.log("hub rejected the node token. Create a new node in Warren and run `warren node start` again.");
        this.stopped = true;
        return;
      }
      this.log(`disconnected (${code}${reason.length ? ` ${reason}` : ""}); retrying in ${Math.round(this.backoff / 1000)}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on("error", (err) => this.log(`connection error: ${err.message}`));
  }

  private send(m: NodeToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async onMessage(msg: HubToNode) {
    if (msg.type === "welcome") {
      const agents = await this.api.request<Agent[]>("GET", "/api/node/agents").catch(() => [] as Agent[]);
      this.log(`connected to ${this.cfg.hub} as "${this.cfg.name}" hosting ${agents.map((a) => "@" + a.handle).join(", ") || "no agents yet"}`);
      this.send({ type: "hello", nodeName: this.cfg.name, agents: agents.map((a) => a.id), version: await version() });
      await this.sendCapabilities();
      this.send({ type: "discovered", agents: discoverAgents(this.cfg.discoverHome) });
      this.send({ type: "catalog", catalog: await this.harnessCatalog() });
    } else if (msg.type === "computer") {
      if (this.local.paused) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name} is paused; someone at the device has to run \`warren node resume\`` });
      if (msg.computer.kind === "device" && !this.local.shareScreen) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name}'s screen is off; only someone at the device can turn it on (\`warren node screen on\`)` });
      const status = (text: string) => this.send({ type: "computer_status", computerId: msg.computer.id, status: "starting", text });
      this.computers.act(msg.computer, msg.action, status).then(
        (result) => {
          this.send({ type: "result", requestId: msg.requestId, ok: true, result });
          if (msg.action.action === "start") this.send({ type: "computer_status", computerId: msg.computer.id, status: "ready", text: "" });
        },
        (err) => {
          this.send({ type: "result", requestId: msg.requestId, ok: false, error: (err as Error).message });
          if (msg.action.action === "start") this.send({ type: "computer_status", computerId: msg.computer.id, status: "error", text: (err as Error).message });
        },
      );
    } else if (msg.type === "screen_watch") {
      if (!msg.on) return this.computers.unwatch(msg.computer.id);
      if (this.local.paused || (msg.computer.kind === "device" && !this.local.shareScreen)) return;
      this.computers.watch(
        msg.computer,
        msg.fps ?? 2,
        (f) => this.send({ type: "screen_frame", computerId: msg.computer.id, ...f }),
        (error) => this.send({ type: "computer_status", computerId: msg.computer.id, status: "error", text: error }),
      );
    } else if (msg.type === "tunnel_open") {
      const { tunnelId } = msg;
      if (this.local.paused || (msg.computer.kind === "device" && !this.local.shareScreen)) return this.send({ type: "tunnel_closed", tunnelId, error: this.local.paused ? "the device is paused" : "the screen is off" });
      this.computers
        .tunnel(
          msg.computer,
          (data) => {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(tunnelFrame(tunnelId, data));
          },
          (error) => {
            this.tunnels.delete(tunnelId);
            this.send({ type: "tunnel_closed", tunnelId, error });
          },
        )
        .then(
          (t) => {
            this.tunnels.set(tunnelId, t);
            this.send({ type: "tunnel_ready", tunnelId });
          },
          (err) => this.send({ type: "tunnel_closed", tunnelId, error: (err as Error).message }),
        );
    } else if (msg.type === "tunnel_close") {
      this.tunnels.get(msg.tunnelId)?.close();
      this.tunnels.delete(msg.tunnelId);
    } else if (msg.type === "discover") {
      this.send({ type: "discovered", agents: discoverAgents(this.cfg.discoverHome) });
    } else if (msg.type === "read_agent") {
      const agent = readDiscovered(msg.key, this.cfg.discoverHome);
      this.send(agent ? { type: "result", requestId: msg.requestId, ok: true, result: agent } : { type: "result", requestId: msg.requestId, ok: false, error: "that agent isn't on this device anymore" });
    } else if (msg.type === "update") {
      // finishing writes the update marker, and `warren node start` restarts once agents are done
      runUpdate(undefined, { log: this.log }).then(
        (result) => this.send({ type: "result", requestId: msg.requestId, ok: true, result }),
        (err) => this.send({ type: "result", requestId: msg.requestId, ok: false, error: (err as Error).message }),
      );
    } else if (msg.type === "run") {
      if (this.local.paused) return this.send({ type: "run_failed", runId: msg.run.runId, error: `${this.cfg.name} is paused; ask again once someone resumes it there` });
      // one run at a time per agent so its harness session stays consistent
      const prev = this.queues.get(msg.run.agentId) ?? Promise.resolve();
      const next = prev.then(() => this.execute(msg.run));
      this.queues.set(msg.run.agentId, next.catch(() => undefined));
    } else if (msg.type === "cancel") {
      this.aborts.get(msg.runId)?.abort();
    } else if (msg.type === "merge") {
      this.log(`merging ${msg.branch} into ${msg.base}`);
      mergeBranch(this.cfg.dir, msg).then(
        (output) => this.send({ type: "git_done", requestId: msg.requestId, ok: true, output }),
        (err) => this.send({ type: "git_done", requestId: msg.requestId, ok: false, output: (err as Error).message }),
      );
    }
  }

  private async execute(run: RunRequest) {
    const agents = await this.api.request<Agent[]>("GET", "/api/node/agents").catch(() => [] as Agent[]);
    const agent = agents.find((a) => a.id === run.agentId);
    if (!agent) return this.send({ type: "run_failed", runId: run.runId, error: "agent is not assigned to this node" });
    const adapter = this.registry[agent.harness];
    if (!adapter) return this.send({ type: "run_failed", runId: run.runId, error: `no headless adapter for ${agent.harness} yet; connect it with warren-mcp instead` });

    // the device owner decides whether "full" access is allowed, not the hub
    let access: AccessLevel = agent.settings?.access ?? "edit";
    if (access === "full" && !this.cfg.allowFullAccess) {
      access = "edit";
      this.send({ type: "run_event", runId: run.runId, event: { type: "status", text: `Full access is off on ${this.cfg.name}; running with edit access.` } });
    }

    // an agent with a VM here works in the folder it shares with the VM, so files go both ways
    let cwd = (run.computer && this.computers.vmFiles(run.computer)) || path.join(this.cfg.dir, "agents", agent.handle);
    fs.mkdirSync(cwd, { recursive: true });
    // coding tasks run in their own checkout of the team repo, on the task's branch
    if (run.workspace) {
      try {
        cwd = await prepareCheckout(this.cfg.dir, agent.handle, run.workspace);
        this.send({ type: "run_event", runId: run.runId, event: { type: "status", text: `Working in ${run.workspace.mode === "work" ? "" : "a read-only checkout of "}branch ${run.workspace.branch}` } });
      } catch (err) {
        return this.send({ type: "run_failed", runId: run.runId, error: `couldn't set up the repo: ${(err as Error).message}` });
      }
    }
    const sessionKey = `${agent.id}:${run.channelId}:${run.threadId ?? "main"}`;
    const abort = new AbortController();
    this.aborts.set(run.runId, abort);
    this.log(`@${agent.handle} (${adapter.label}) working on ${run.runId}`);

    const attempt = async (sessionId: string | null) =>
      adapter.run(
        {
          prompt: run.prompt,
          cwd,
          model: agent.model,
          effort: agent.settings?.effort ?? null,
          fast: agent.settings?.fast ?? false,
          access,
          sessionId,
          mcp: await this.mcpSpec(agent.id),
          signal: abort.signal,
          options: this.cfg.harnessOptions?.[agent.harness],
        },
        (e) => {
          if (e.type === "session") {
            this.sessions[sessionKey] = e.id;
            writeJson(this.sessionsFile, this.sessions);
          } else this.send({ type: "run_event", runId: run.runId, event: e });
        },
      );

    try {
      let result;
      const resumeId = this.sessions[sessionKey] ?? null;
      try {
        result = await attempt(resumeId);
      } catch (err) {
        // a stale/expired harness session should not break the conversation
        if (!resumeId || abort.signal.aborted) throw err;
        this.log(`@${agent.handle}: resume failed (${(err as Error).message}); starting a fresh session`);
        delete this.sessions[sessionKey];
        result = await attempt(null);
      }
      this.send({ type: "run_done", runId: run.runId, finalText: result.finalText });
      this.log(`@${agent.handle} finished ${run.runId}`);
    } catch (err) {
      const message = abort.signal.aborted ? (abort.signal.reason === "paused" ? `stopped: ${this.cfg.name} was paused` : "cancelled") : (err as Error).message;
      this.send({ type: "run_failed", runId: run.runId, error: message });
      this.log(`@${agent.handle} failed ${run.runId}: ${message}`);
    } finally {
      this.aborts.delete(run.runId);
    }
  }

  /** Models each installed harness offers here; computed once per process. */
  private harnessCatalog(): Promise<HarnessCatalog[]> {
    this.catalog ??= Promise.all(
      Object.values(this.registry).map(async (a) => {
        try {
          return (await a.catalog?.()) ?? null;
        } catch {
          return null;
        }
      }),
    ).then((list) => list.filter((c): c is HarnessCatalog => !!c && c.version !== null));
    return this.catalog;
  }

  /**
   * The harness gets warren-mcp with a token for its agent alone, so whatever the agent runs can't
   * act as this device or its other agents. Hubs from before agent tokens get the device's token.
   */
  private async mcpSpec(agentId: string): Promise<McpServerSpec> {
    const token = await this.harnessToken(agentId);
    return {
      command: process.execPath,
      args: [MCP_BIN],
      env: token ? { WARREN_URL: this.cfg.hub, WARREN_TOKEN: token } : { WARREN_URL: this.cfg.hub, WARREN_TOKEN: this.cfg.token, WARREN_AGENT: agentId },
    };
  }

  private async harnessToken(agentId: string): Promise<string | null> {
    const known = this.agentTokens[agentId];
    if (known && (await this.tokenWorks(known))) return known;
    const r = await this.api.request<{ token: string }>("POST", `/api/node/agents/${agentId}/token`).catch(() => null);
    if (!r?.token) return null;
    this.agentTokens[agentId] = r.token;
    writeJson(this.tokensFile, this.agentTokens, 0o600);
    return r.token;
  }

  /** Still valid (the agent wasn't moved, deleted or its tokens revoked)? */
  private async tokenWorks(token: string): Promise<boolean> {
    const res = await fetch(`${this.cfg.hub.replace(/\/+$/, "")}/api/computers/mine`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    return !!res && res.status !== 401;
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown, mode?: number) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
}
