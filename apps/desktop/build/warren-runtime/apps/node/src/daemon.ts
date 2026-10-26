import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { CONNECTOR_CATALOG, HubToNode, harnessInfo, harnessLabel, readTunnelFrame, tunnelFrame, type AccessLevel, type Agent, type ConnectorSpec, type HarnessCatalog, type NodeToHub, type RunRequest } from "@warren/core";
import { deviceAdapters, type DeviceHarness, type HarnessAdapter, type McpServerSpec } from "@warren/adapters";
import { WarrenClient, WarrenError } from "@warren/sdk";
import { runUpdate, version } from "@warren/update";
import { ComputerHost, type Tunnel } from "./computers/index.ts";
import { VM_HOME, type DockerVm } from "./computers/docker.ts";
import { mcpBundle } from "./vm-tools.ts";
import { discoverAgents, readDiscovered } from "./discover.ts";
import { bringBack, mergeBranch, prepareCheckout, prepareClone } from "./git.ts";

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
  /** don't get the VM image ready when connecting (it's fetched when the first VM starts instead) */
  noPrepare?: boolean;
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
  /** harnesses given by the caller (tests), not read from node.json */
  private fixedRegistry: boolean;
  /** which version of Warren's tools each VM has (by container name) */
  private vmTools = new Map<string, string>();
  /** shareScreen and paused, as last read from node.json (people change them there with the CLI) */
  private local: { shareScreen: boolean; paused: boolean };
  /** run results that couldn't be sent (the hub was away); sent as soon as it's back */
  private outbox: NodeToHub[] = [];
  /** when the hub replaced this connection with another one using the same token */
  private replaced: number[] = [];

  constructor(
    private cfg: NodeConfig,
    private log: Log = (m) => console.log(`[warren] ${m}`),
    registry?: Record<string, HarnessAdapter>,
    computers?: ComputerHost,
  ) {
    this.cfg = cfg = { ...cfg, hub: normalizeHubUrl(cfg.hub) };
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.sessions = readJson(this.sessionsFile, {});
    this.agentTokens = readJson(this.tokensFile, {});
    this.local = this.readLocal();
    this.api = new WarrenClient({ url: cfg.hub, token: cfg.token });
    this.registry = registry ?? deviceAdapters(cfg.harnesses);
    this.fixedRegistry = !!registry;
    this.computers =
      computers ??
      new ComputerHost({ dir: cfg.dir, vmEngine: cfg.vmEngine, allowDeviceShell: cfg.allowFullAccess, log, onVmStatus: (computerId, status, text) => this.send({ type: "computer_status", computerId, status, text }) });
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
    caps.commands = this.commandsHere();
    this.send({ type: "capabilities", capabilities: caps });
  }

  start() {
    this.stopped = false;
    this.replaced = [];
    fs.watchFile(this.configFile, { interval: 1000 }, this.onLocalChange);
    if (this.local.paused) this.log("paused: no agent runs or computer use until `warren node resume`");
    this.connect();
  }

  /**
   * Stop: cancel every run, wait (up to `wait` ms) for each to tell the hub it was stopped, then
   * hang up. Without the wait a Ctrl-C would leave the agents "busy" on the hub.
   */
  async stop(wait = 5000) {
    this.stopped = true;
    fs.unwatchFile(this.configFile, this.onLocalChange);
    for (const a of this.aborts.values()) a.abort();
    this.computers.stopAll();
    for (const t of this.tunnels.values()) t.close();
    this.tunnels.clear();
    const end = Date.now() + wait;
    while (this.aborts.size && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
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
      // another daemon with this token took our place; if it keeps happening the two would replace each other forever
      if (code === 4000) {
        this.replaced = [...this.replaced.filter((t) => Date.now() - t < 60_000), Date.now()];
        if (this.replaced.length >= 2) {
          this.log("another `warren node start` is running with this device's token (the installed service, perhaps: `warren service status`). This one stops, so the two don't keep replacing each other.");
          this.stopped = true;
          return;
        }
      }
      this.log(`disconnected (${code}${reason.length ? ` ${reason}` : ""}); retrying in ${Math.round(this.backoff / 1000)}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on("error", (err) => this.log(`connection error: ${err.message}`));
  }

  private send(m: NodeToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws.send(JSON.stringify(m));
    // a run's outcome must reach the hub, or the agent stays "busy" there; everything else is a snapshot the hub asks for again
    if (m.type === "run_done" || m.type === "run_failed") {
      this.outbox.push(m);
      if (this.outbox.length > 200) this.outbox.shift();
      this.log(`hub is away; will report ${m.runId} when it's back`);
    }
  }

  /** The hub is back: deliver what finished while it was away. */
  private flushOutbox() {
    const queued = this.outbox.splice(0);
    for (const m of queued) this.send(m);
    if (queued.length) this.log(`reported ${queued.length} run${queued.length === 1 ? "" : "s"} that finished while the hub was away`);
  }

  /** Which of the commands connectors need are on this device's PATH. */
  private commandsHere(): Record<string, boolean> {
    const wanted = new Set(["node", "npx", "uv", "uvx", "docker", "python3"]);
    for (const c of CONNECTOR_CATALOG) if (c.command) wanted.add(c.command);
    return Object.fromEntries([...wanted].map((cmd) => [cmd, commandExists(cmd)]));
  }

  private async onMessage(msg: HubToNode) {
    if (msg.type === "welcome") {
      const agents = await this.api.request<Agent[]>("GET", "/api/node/agents").catch(() => [] as Agent[]);
      this.log(`connected to ${this.cfg.hub} as "${this.cfg.name}" hosting ${agents.map((a) => "@" + a.handle).join(", ") || "no agents yet"}`);
      this.send({ type: "hello", nodeName: this.cfg.name, agents: agents.map((a) => a.id), version: await version() });
      this.flushOutbox();
      await this.sendCapabilities();
      // agents work on VMs: have the image here before the first one is needed
      if (!this.local.paused && !this.cfg.noPrepare) void this.computers.prepareImage(() => void this.sendCapabilities());
      this.send({ type: "discovered", agents: discoverAgents(this.cfg.discoverHome) });
      this.send({ type: "catalog", catalog: await this.harnessCatalog() });
    } else if (msg.type === "computer") {
      if (this.local.paused) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name} is paused; someone at the device has to run \`warren node resume\`` });
      if (msg.computer.kind === "device" && !this.local.shareScreen) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name}'s screen is off; only someone at the device can turn it on (\`warren node screen on\`)` });
      this.computers.act(msg.computer, msg.action).then(
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
    } else if (msg.type === "refresh") {
      await this.refresh();
    } else if (msg.type === "install_harness") {
      if (this.local.paused) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name} is paused` });
      this.installHarness(msg.harness).then(
        async (output) => {
          await this.refresh();
          this.send({ type: "result", requestId: msg.requestId, ok: true, result: { output } });
        },
        (err) => this.send({ type: "result", requestId: msg.requestId, ok: false, error: (err as Error).message }),
      );
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
    // `warren node pause` while this run waited its turn behind another: it doesn't start either
    if (this.local.paused) return this.send({ type: "run_failed", runId: run.runId, error: `${this.cfg.name} is paused; ask again once someone resumes it there` });
    if (this.stopped) return this.send({ type: "run_failed", runId: run.runId, error: `${this.cfg.name} was stopped before this run started` });
    const agents = await this.api.request<Agent[]>("GET", "/api/node/agents").catch(() => [] as Agent[]);
    const agent = agents.find((a) => a.id === run.agentId);
    if (!agent) return this.send({ type: "run_failed", runId: run.runId, error: "agent is not assigned to this node" });
    const adapter = this.registry[agent.harness];
    if (!adapter) return this.send({ type: "run_failed", runId: run.runId, error: `no headless adapter for ${agent.harness} yet; connect it with warren-mcp instead` });

    // its VM, when it has one here: it runs inside it, or at least gets its browser
    let vm: DockerVm | null = null;
    if (run.computer?.kind === "vm") {
      try {
        vm = await this.computers.vm(run.computer);
        await vm?.ready();
      } catch (err) {
        if (run.inComputer) return this.send({ type: "run_failed", runId: run.runId, error: `couldn't start ${run.computer.name}: ${(err as Error).message}` });
        vm = null;
      }
    }
    const inside = !!run.inComputer && !!vm;
    if (run.inComputer && !vm) return this.send({ type: "run_failed", runId: run.runId, error: "its computer isn't a VM on this device" });
    if (inside) {
      const signed = await vm!.signedIn(agent.harness).catch(() => null);
      if (signed === false) {
        const label = harnessLabel(agent.harness);
        return this.send({ type: "run_failed", runId: run.runId, error: `${label} isn't signed in on ${run.computer!.name} yet. Open @${agent.handle}'s page → Computer and press "Sign in to ${label}" (you only do this once).` });
      }
    }

    // the device owner decides whether "full" access is allowed here, not the hub; inside its own VM the VM is the sandbox
    let access: AccessLevel = agent.settings?.access ?? "edit";
    if (inside) access = access === "read-only" ? "read-only" : "full";
    else if (access === "full" && !this.cfg.allowFullAccess) {
      access = "edit";
      this.send({ type: "run_event", runId: run.runId, event: { type: "status", text: `Full access is off on ${this.cfg.name}; running with edit access.` } });
    }

    // an agent with a VM here works in the folder it shares with the VM, so files go both ways
    let cwd = (run.computer && this.computers.vmFiles(run.computer)) || path.join(this.cfg.dir, "agents", agent.handle);
    fs.mkdirSync(cwd, { recursive: true });
    // coding tasks run in their own checkout of the team repo, on the task's branch
    if (run.workspace) {
      try {
        cwd = inside ? await prepareClone(this.cfg.dir, vm!.filesDir, run.workspace) : await prepareCheckout(this.cfg.dir, agent.handle, run.workspace);
        this.send({ type: "run_event", runId: run.runId, event: { type: "status", text: `Working in ${run.workspace.mode === "work" ? "" : "a read-only checkout of "}branch ${run.workspace.branch}` } });
      } catch (err) {
        return this.send({ type: "run_failed", runId: run.runId, error: `couldn't set up the repo: ${(err as Error).message}` });
      }
    }
    const sessionKey = `${agent.id}:${run.channelId}:${run.threadId ?? "main"}`;
    const abort = new AbortController();
    this.aborts.set(run.runId, abort);
    this.log(`@${agent.handle} (${adapter.label}) working on ${run.runId}${inside ? ` inside ${run.computer!.name}` : ""}`);
    let mcp: McpServerSpec, browser: McpServerSpec | undefined;
    try {
      mcp = inside ? await this.vmMcpSpec(agent.id, vm!) : await this.mcpSpec(agent.id);
      // the VM's Chrome as page-element tools, run inside the VM either way
      if (vm) browser = inside ? { command: "warren-browser-mcp", args: [], env: {} } : { command: vm.engine.bin, args: ["exec", "-i", "-u", "warren", vm.name, "warren-browser-mcp"], env: {} };
    } catch (err) {
      this.aborts.delete(run.runId);
      return this.send({ type: "run_failed", runId: run.runId, error: `couldn't set up its tools: ${(err as Error).message}` });
    }
    // stopping the engine's `exec` doesn't stop what it started in the VM
    if (inside) abort.signal.addEventListener("abort", () => void vm!.stopRun(run.runId), { once: true });

    // a connector whose command isn't here can't start; say so rather than let the harness fail quietly (inside a VM the VM has its own tools)
    let connectors = run.connectors ?? [];
    if (!inside) {
      const missing = connectors.filter((c) => c.kind === "mcp-stdio" && c.command && !commandExists(c.command));
      for (const c of missing) {
        const text = `Connector ${c.name} didn't start: "${c.command}" isn't installed on ${this.cfg.name}.`;
        this.log(`@${agent.handle}: ${text}`);
        this.send({ type: "run_event", runId: run.runId, event: { type: "notice", text } });
      }
      connectors = connectors.filter((c) => !missing.includes(c));
    }

    // did the harness get going (text, a tool call)? A resumed session that failed after that isn't rerun from scratch
    let progressed = false;
    const attempt = async (sessionId: string | null) =>
      adapter.run(
        {
          prompt: run.prompt,
          cwd,
          // a background check can run on its own (usually smaller) model; fast mode is the agent's, for its own model
          model: run.model ?? agent.model,
          effort: run.effort ?? (run.model ? null : (agent.settings?.effort ?? null)),
          fast: run.model ? false : (agent.settings?.fast ?? false),
          access,
          sessionId,
          mcp,
          browser,
          // MCP connectors go to the harness's own config; secrets go in its environment
          connectors: connectors.filter((c: ConnectorSpec) => c.kind !== "secret"),
          env: Object.assign({}, ...connectors.filter((c) => c.kind === "secret").map((c) => c.env ?? {})),
          launch: inside ? vm!.launcher(run.runId) : undefined,
          signal: abort.signal,
          options: this.cfg.harnessOptions?.[agent.harness],
        },
        (e) => {
          if (e.type === "session") {
            // a fresh run is never continued, so there's nothing to remember
            if (run.fresh) return;
            this.sessions[sessionKey] = e.id;
            writeJson(this.sessionsFile, this.sessions);
          } else {
            if (e.type === "text" || e.type === "tool_call" || e.type === "tool_result") progressed = true;
            this.send({ type: "run_event", runId: run.runId, event: e });
          }
        },
      );

    try {
      let result;
      const resumeId = run.fresh ? null : (this.sessions[sessionKey] ?? null);
      try {
        result = await attempt(resumeId);
      } catch (err) {
        // a stale/expired harness session should not break the conversation: when resuming failed
        // before anything happened, start fresh. A failure after real work (a crash, quota) is just
        // a failure; doing the whole prompt again would double the cost and redo what it did.
        if (!resumeId || abort.signal.aborted || progressed) throw err;
        this.log(`@${agent.handle}: resume failed before it got going (${(err as Error).message}); starting a fresh session`);
        delete this.sessions[sessionKey];
        result = await attempt(null);
      }
      // commits made inside the VM go to the device's copy of the repo, for reviews and merges
      if (inside && run.workspace) await bringBack(this.cfg.dir, cwd, run.workspace).catch((err) => this.log(`couldn't bring ${run.workspace!.branch} back from ${run.computer!.name}: ${(err as Error).message}`));
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

  /** Look again at what this device has (someone installed a harness, added one to node.json, started Docker…). */
  private async refresh() {
    if (!this.fixedRegistry) this.registry = deviceAdapters(readJson<Partial<NodeConfig>>(this.configFile, {}).harnesses ?? this.cfg.harnesses);
    this.catalog = null;
    await this.sendCapabilities();
    this.send({ type: "discovered", agents: discoverAgents(this.cfg.discoverHome) });
    this.send({ type: "catalog", catalog: await this.harnessCatalog() });
  }

  /**
   * Install a harness with this device's own recipe: only npm packages Warren knows (see
   * HARNESSES[].install), so the hub can name a harness but never choose what runs here.
   */
  private async installHarness(id: string): Promise<string> {
    const pkg = harnessInfo(id)?.install?.npm;
    if (!pkg) throw new Error(`${harnessLabel(id)} isn't installed with npm; install it on ${this.cfg.name} with its own installer`);
    const npm = process.platform === "win32" ? "npm.cmd" : path.join(path.dirname(process.execPath), "npm");
    this.log(`installing ${harnessLabel(id)} (${pkg})`);
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(fs.existsSync(npm) || process.platform === "win32" ? npm : "npm", ["install", "-g", "--no-audit", "--no-fund", pkg], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
      let text = "";
      child.stdout.on("data", (d) => (text = (text + d).slice(-8000)));
      child.stderr.on("data", (d) => (text = (text + d).slice(-8000)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      child.on("error", (e) => (clearTimeout(timer), resolve({ code: -1, text: e.message })));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, text })));
    });
    if (out.code !== 0) {
      const last = out.text.trim().split("\n").slice(-6).join("\n");
      throw new Error(/EACCES|permission denied/i.test(out.text) ? `npm can't write its global folder on ${this.cfg.name} (permission denied). Install it there yourself: npm install -g ${pkg}` : `npm install -g ${pkg} failed:\n${last}`);
    }
    // npm's global bin may not be on this process's PATH (a background service starts with a short one)
    const prefix = await new Promise<string>((resolve) => execFile(npm, ["prefix", "-g"], (err, stdout) => resolve(err ? "" : stdout.trim())));
    const bin = prefix && (process.platform === "win32" ? prefix : path.join(prefix, "bin"));
    if (bin && !(process.env.PATH ?? "").split(path.delimiter).includes(bin)) process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    this.log(`installed ${harnessLabel(id)}`);
    return out.text.trim().split("\n").slice(-3).join("\n");
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
   * act as this device or its other agents. Only a hub from before agent tokens (it has no such
   * endpoint) gets the device's token; when the hub merely can't answer, the run fails instead.
   */
  private async mcpSpec(agentId: string): Promise<McpServerSpec> {
    const token = await this.harnessToken(agentId);
    // in the desktop app this "node" is the app itself, which runs scripts only when told to
    const asNode: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
    return {
      command: process.execPath,
      args: [MCP_BIN],
      env: token ? { ...asNode, WARREN_URL: this.cfg.hub, WARREN_TOKEN: token } : { ...asNode, WARREN_URL: this.cfg.hub, WARREN_TOKEN: this.cfg.token, WARREN_AGENT: agentId },
    };
  }

  /** warren-mcp for a harness inside a VM: Warren's tools copied into the VM, talking to the hub from in there. */
  private async vmMcpSpec(agentId: string, vm: DockerVm): Promise<McpServerSpec> {
    const token = await this.harnessToken(agentId);
    if (!token) throw new Error("the hub didn't give this agent a token of its own; update the hub");
    const bundle = await mcpBundle();
    const file = `${VM_HOME}/.warren/warren-mcp.mjs`;
    if (this.vmTools.get(vm.name) !== bundle.hash) {
      await vm.writeFile(file, bundle.code);
      this.vmTools.set(vm.name, bundle.hash);
    }
    return { command: "node", args: [file], env: { WARREN_URL: await vm.hubUrl(this.cfg.hub), WARREN_TOKEN: token } };
  }

  private async harnessToken(agentId: string): Promise<string | null> {
    const known = this.agentTokens[agentId];
    if (known && (await this.tokenWorks(known))) return known;
    const r = await this.api.request<{ token: string }>("POST", `/api/node/agents/${agentId}/token`).catch((err) => {
      if (err instanceof WarrenError && err.status === 404) return null; // an older hub
      throw new Error(`the hub couldn't give this agent a token (${(err as Error).message}); try again in a moment`);
    });
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

/**
 * The hub's address as people type it ("my-server:4747", "https://warren.example.com/",
 * "ws://..."), as the http(s) URL the daemon needs. Throws, with a hint, for something that isn't an address.
 */
export function normalizeHubUrl(raw: string): string {
  let s = (raw ?? "").trim().replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(s)) s = s.replace(/^ws/i, "http");
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u: URL | null = null;
  try {
    u = new URL(s);
  } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(`"${raw}" isn't a hub address. It should look like http://my-server:4747 (what you open in the browser).`);
  return u.toString().replace(/\/+$/, "");
}

/** Is `cmd` on this process's PATH (as the harness would find it)? A path to a file counts when it exists. */
export function commandExists(cmd: string): boolean {
  if (!cmd) return false;
  if (cmd.includes("/") || cmd.includes("\\")) return fs.existsSync(cmd);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").concat("") : [""];
  return dirs.some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, cmd + ext))));
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
