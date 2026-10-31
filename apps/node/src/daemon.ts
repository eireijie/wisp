import { migrateHome } from "./migrate-home.ts";
import { migrateServices } from "./migrate-services.ts";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { CONNECTOR_CATALOG, HubToNode, SETTINGS_HARNESSES, harnessInfo, harnessLabel, readTunnelFrame, tunnelFrame, type AccessLevel, type HarnessAccountOp, type HarnessSettings, type Agent, type ConnectorSpec, type HarnessCatalog, type NodeToHub, type RunRequest } from "@wisp/core";
import { HarnessAccounts, changeHarnessSettings, deviceAdapters, harnessConfigured, loginCommand, scanShelf, harnessConfigPath, readHarnessSettings, readHarnessSkill, type DeviceHarness, type HarnessAdapter, type McpServerSpec } from "@wisp/adapters";
import { WispClient, WispError } from "@wisp/sdk";
import { runUpdate, version } from "@wisp/update";
import { ComputerHost, type Tunnel } from "./computers/index.ts";
import { RemoteDesktopServer, type RemoteDesktopConfig } from "./computers/remote-desktop.ts";
import type { RustdeskConfig } from "./rustdesk.ts";
import { detectRemoteApps } from "./remote-apps.ts";
import { ScreenLock, type ScreenCode } from "./screen-lock.ts";
import { HarnessLogins } from "./harness-login.ts";
import { type DockerVm } from "./computers/docker.ts";
import { mcpBundle } from "./vm-tools.ts";
import { NO_NODE, findNpmDir, withDir } from "./npm.ts";
import { discoverAgents, readDiscovered } from "./discover.ts";
import { agentFolder } from "./agent-dir.ts";
import { bringBack, mergeBranch, prepareCheckout, prepareClone } from "./git.ts";

const MCP_BIN = fileURLToPath(new URL("../../../bin/wisp-mcp.mjs", import.meta.url));

export interface NodeConfig {
  hub: string;
  token: string;
  name: string;
  /** waiting to become a device of the hub on this same computer (`--local`), until it hands over a token */
  local?: boolean;
  /** the joined Wisp stable id, to find it again on the Wi-Fi when its address changes */
  hubId?: string;
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
   * Offer this device's own screen to its owner and to agents that run here. Off by default, and
   * only someone at the device can turn it on (`wisp node screen on`), not the hub.
   */
  shareScreen?: boolean;
  /** never offer this device's own screen, whatever shareScreen says (older setting) */
  noScreen?: boolean;
  /** the code (hashed) that opens this screen from Wisp; set at the device, never sent to the hub */
  screenCode?: ScreenCode;
  /** Remote Desktop: this device's own VNC server for its screen (`wisp node screen remote`) */
  remoteDesktop?: RemoteDesktopConfig;
  /** RustDesk, set up with `wisp node rustdesk`: its ID goes to the hub for the device's owner */
  rustdesk?: RustdeskConfig;
  /** `wisp node pause`: take no work from the hub (no agent runs, no computer use) until resumed */
  paused?: boolean;
  /** where to look for existing agents (default: the home folder); for tests */
  discoverHome?: string;
  /** don't get the VM image ready when connecting (it's fetched when the first VM starts instead) */
  noPrepare?: boolean;
  /** the home folder whose harness configs Settings → Harnesses reads and changes (default: this user's); for tests */
  harnessHome?: string;
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
  /** agents whose harness is running right here (not in a VM), with how many runs each: they may use this screen */
  private runningHere = new Map<string, number>();
  private sessions: Record<string, string>;
  private api: WispClient;
  private catalog: Promise<HarnessCatalog[]> | null = null;
  private catalogIncomplete = false;
  private registry: Record<string, HarnessAdapter>;
  readonly computers: ComputerHost;
  private tunnels = new Map<string, Tunnel>();
  /** per-agent tokens for harnesses, so a harness never holds this device's own token */
  private agentTokens: Record<string, string>;
  /** harnesses given by the caller (tests), not read from node.json */
  private fixedRegistry: boolean;
  /** which version of Wisp's tools each VM has (by container name) */
  private vmTools = new Map<string, string>();
  /** the switches people flip at the device, as last read from node.json (people change them there with the CLI) */
  private local: { shareScreen: boolean; paused: boolean; code?: ScreenCode; remote?: RemoteDesktopConfig; rustdesk?: RustdeskConfig };
  /** the screen's code: checked here, with its own count of wrong tries */
  private lock: ScreenLock;
  private remoteServer: RemoteDesktopServer;
  /** tunnels opened with the screen's code */
  private codeTunnels = new Set<string>();
  /** each harness's logins here, and which agent uses which */
  private accounts: HarnessAccounts;
  /** sign-ins running for those accounts */
  private logins = new HarnessLogins();
  /** run results that couldn't be sent (the hub was away); sent as soon as it's back */
  private outbox: NodeToHub[] = [];
  /** when the hub replaced this connection with another one using the same token */
  private replaced: number[] = [];
  /** called once the hub turns this device's token down for good (the device was removed, say) */
  onRejected?: () => void;
  /** asked after a few failed connections: the new address of the Wisp, if it moved */
  relocate?: () => Promise<string | null>;
  private failures = 0;

  constructor(
    private cfg: NodeConfig,
    private log: Log = (m) => console.log(`[wisp] ${m}`),
    registry?: Record<string, HarnessAdapter>,
    computers?: ComputerHost,
  ) {
    if ([".wisp", ".warren"].includes(path.basename(cfg.dir))) {
      const migrated = migrateHome({ home: path.dirname(cfg.dir), log });
      cfg = { ...cfg, dir: migrated.dir };
      migrateServices({ home: path.dirname(cfg.dir), log });
    }
    this.cfg = cfg = { ...cfg, hub: normalizeHubUrl(cfg.hub) };
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.sessions = readJson(this.sessionsFile, {});
    this.agentTokens = readJson(this.tokensFile, {});
    this.local = this.readLocal();
    this.lock = new ScreenLock(cfg.dir, () => this.local.code);
    this.remoteServer = new RemoteDesktopServer(cfg.dir, log);
    this.api = new WispClient({ url: cfg.hub, token: cfg.token });
    this.accounts = new HarnessAccounts(cfg.dir, { home: cfg.harnessHome });
    this.registry = registry ?? deviceAdapters(cfg.harnesses);
    this.fixedRegistry = !!registry;
    this.computers =
      computers ??
      new ComputerHost({ dir: cfg.dir, vmEngine: cfg.vmEngine, allowDeviceShell: cfg.allowFullAccess, log, remoteDesktop: () => this.local.remote, onVmStatus: (computerId, status, text) => this.send({ type: "computer_status", computerId, status, text }) });
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
    return {
      shareScreen: !!(file.shareScreen ?? this.cfg.shareScreen) && !(file.noScreen ?? this.cfg.noScreen),
      paused: !!(file.paused ?? this.cfg.paused),
      code: file.screenCode ?? this.cfg.screenCode,
      // these are removed from the file to turn them off, so once there's a file, it alone decides
      remote: fs.existsSync(this.configFile) ? file.remoteDesktop : this.cfg.remoteDesktop,
      rustdesk: fs.existsSync(this.configFile) ? file.rustdesk : this.cfg.rustdesk,
    };
  }

  /** Remote Desktop's server runs while the screen is on and the device isn't paused. */
  private applyRemoteServer() {
    this.remoteServer.set(this.local.shareScreen && !this.local.paused ? this.local.remote : null);
  }

  private closeTunnels() {
    for (const t of this.tunnels.values()) t.close();
    this.tunnels.clear();
    for (const id of this.codeTunnels) this.lock.lock(`tunnel:${id}`);
    this.codeTunnels.clear();
  }

  /** A code was entered for this screen: tell its owner when it was wrong. */
  private codeResult(r: { ok: boolean; lockedOut?: boolean; triesLeft?: number }) {
    if (r.ok) return;
    if (r.lockedOut) this.send({ type: "screen_event", alert: true, text: "Too many wrong codes were entered for this screen, so it stopped taking codes for a while. If that wasn't you, change your Wisp password." });
    else if (r.triesLeft !== undefined) this.send({ type: "screen_event", alert: r.triesLeft <= 2, text: `A wrong code was entered for this screen (${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left before it locks).` });
  }

  /** Someone ran `wisp node screen …` or `wisp node pause/resume`: apply it now. */
  private onLocalChange = () => {
    const before = this.local;
    this.local = this.readLocal();
    const codeChanged = before.code?.hash !== this.local.code?.hash;
    const remoteChanged = JSON.stringify(before.remote) !== JSON.stringify(this.local.remote);
    if (codeChanged || remoteChanged) {
      // a new code (or none) or a new server: whatever the old one opened closes
      this.lock.lockAll();
      this.closeTunnels();
      this.computers.stopAll();
    }
    this.applyRemoteServer();
    if (before.shareScreen === this.local.shareScreen && before.paused === this.local.paused) {
      if (codeChanged || remoteChanged || before.rustdesk?.id !== this.local.rustdesk?.id) void this.sendCapabilities();
      return;
    }
    if (this.local.paused && !before.paused) {
      this.log("paused: stopping agents and computers until `wisp node resume`");
      for (const a of this.aborts.values()) a.abort("paused");
    }
    if (this.local.paused || !this.local.shareScreen) {
      this.computers.stopAll();
      this.closeTunnels();
      this.lock.lockAll();
    }
    if (!before.paused && !this.local.paused) this.log(`this screen is now ${this.local.shareScreen ? "shared with you in Wisp (and agents that run here)" : "off"}`);
    if (before.paused && !this.local.paused) this.log("resumed");
    void this.sendCapabilities();
  };

  private async sendCapabilities() {
    const caps = await this.computers.capabilities();
    if (!this.local.shareScreen && caps.screen.ok) caps.screen = { ok: false, off: true, detail: "Off. Only someone at this device can turn it on: `wisp node screen on`" };
    else if (caps.screen.ok) {
      if (this.local.remote) caps.screen.remote = true;
      if (this.local.code) caps.screen.code = this.local.code.kind;
    }
    if (this.local.rustdesk) caps.rustdesk = this.local.rustdesk;
    const apps = await detectRemoteApps().catch(() => []);
    if (apps.length) caps.remoteApps = apps;
    caps.paused = this.local.paused;
    caps.commands = this.commandsHere();
    this.send({ type: "capabilities", capabilities: caps });
  }

  start() {
    this.stopped = false;
    this.replaced = [];
    fs.watchFile(this.configFile, { interval: 1000 }, this.onLocalChange);
    if (this.local.paused) this.log("paused: no agent runs or computer use until `wisp node resume`");
    this.applyRemoteServer();
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
    this.logins.stopAll();
    this.closeTunnels();
    this.remoteServer.stop();
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
      this.failures = 0;
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
      this.closeTunnels();
      if (this.stopped) return;
      if (code === 4401) {
        this.log("hub rejected the node token. Create a new node in Wisp and run `wisp node start` again.");
        this.stopped = true;
        this.onRejected?.();
        return;
      }
      // another daemon with this token took our place; if it keeps happening the two would replace each other forever
      if (code === 4000) {
        this.replaced = [...this.replaced.filter((t) => Date.now() - t < 60_000), Date.now()];
        if (this.replaced.length >= 2) {
          this.log("another `wisp node start` is running with this device's token (the installed service, perhaps: `wisp service status`). This one stops, so the two don't keep replacing each other.");
          this.stopped = true;
          return;
        }
      }
      this.log(`disconnected (${code}${reason.length ? ` ${reason}` : ""}); retrying in ${Math.round(this.backoff / 1000)}s`);
      if (++this.failures % 3 === 0 && this.relocate) {
        void this.relocate().then((url) => {
          if (!url || this.stopped) return;
          this.log(`your Wisp moved to ${url}; connecting there`);
          this.cfg.hub = url;
          this.api = new WispClient({ url, token: this.cfg.token });
          this.backoff = 1000;
        }).catch(() => {});
      }
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
      void this.sendShelf();
    } else if (msg.type === "computer") {
      if (this.local.paused) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name} is paused; someone at the device has to run \`wisp node resume\`` });
      if (msg.computer.kind === "device" && !this.local.shareScreen) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name}'s screen is off; only someone at the device can turn it on (\`wisp node screen on\`)` });
      // an agent running on this device uses its screen without the code, which guards it from Wisp, not from what runs here
      const here = !!msg.agentId && this.runningHere.has(msg.agentId);
      if (msg.computer.kind === "device" && msg.action.action !== "status" && !here && !this.lock.open()) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: `${this.cfg.name}'s screen is locked with its code. Its owner opens it by entering the code in Wisp to watch it; agents that run on this device can use it while they work.` });
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
      if (this.local.paused || (msg.computer.kind === "device" && (!this.local.shareScreen || !this.lock.open()))) return;
      this.computers.watch(
        msg.computer,
        msg.fps ?? 2,
        (f) => this.send({ type: "screen_frame", computerId: msg.computer.id, ...f }),
        (error) => this.send({ type: "computer_status", computerId: msg.computer.id, status: "error", text: error }),
      );
    } else if (msg.type === "tunnel_open") {
      const { tunnelId } = msg;
      if (this.local.paused || (msg.computer.kind === "device" && !this.local.shareScreen)) return this.send({ type: "tunnel_closed", tunnelId, error: this.local.paused ? "the device is paused" : "the screen is off" });
      if (msg.computer.kind === "device" && this.lock.enabled) {
        // the code itself, every time: a screen opened for one viewer doesn't let another in without it
        const r = this.lock.check(msg.code);
        this.codeResult(r);
        if (!r.ok) return this.send({ type: "tunnel_closed", tunnelId, error: r.error });
        this.codeTunnels.add(tunnelId);
        this.lock.grant(`tunnel:${tunnelId}`, Date.now() + 24 * 60 * 60_000);
      }
      const forget = () => {
        if (this.codeTunnels.delete(tunnelId)) this.lock.lock(`tunnel:${tunnelId}`);
      };
      this.computers
        .tunnel(
          msg.computer,
          (data) => {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(tunnelFrame(tunnelId, data));
          },
          (error) => {
            this.tunnels.delete(tunnelId);
            forget();
            this.send({ type: "tunnel_closed", tunnelId, error });
          },
        )
        .then(
          (t) => {
            this.tunnels.set(tunnelId, t);
            this.send({ type: "tunnel_ready", tunnelId });
          },
          (err) => {
            forget();
            this.send({ type: "tunnel_closed", tunnelId, error: (err as Error).message });
          },
        );
    } else if (msg.type === "tunnel_close") {
      this.tunnels.get(msg.tunnelId)?.close();
      this.tunnels.delete(msg.tunnelId);
      if (this.codeTunnels.delete(msg.tunnelId)) this.lock.lock(`tunnel:${msg.tunnelId}`);
    } else if (msg.type === "screen_unlock") {
      if (!this.lock.enabled) return this.send({ type: "result", requestId: msg.requestId, ok: true, result: { until: msg.until } });
      if (this.local.paused || !this.local.shareScreen) return this.send({ type: "result", requestId: msg.requestId, ok: false, error: this.local.paused ? `${this.cfg.name} is paused` : `${this.cfg.name}'s screen is off` });
      const r = this.lock.unlock(msg.purpose, msg.code, Date.parse(msg.until) || 0);
      this.codeResult(r);
      this.send(r.ok ? { type: "result", requestId: msg.requestId, ok: true, result: { until: new Date(r.until!).toISOString() } } : { type: "result", requestId: msg.requestId, ok: false, error: r.error });
    } else if (msg.type === "screen_lock") {
      this.lock.lock(msg.purpose);
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
      // finishing writes the update marker, and `wisp node start` restarts once agents are done
      runUpdate(undefined, { log: this.log }).then(
        (result) => this.send({ type: "result", requestId: msg.requestId, ok: true, result }),
        (err) => this.send({ type: "result", requestId: msg.requestId, ok: false, error: (err as Error).message }),
      );
    } else if (msg.type === "harness_settings" || msg.type === "harness_settings_change" || msg.type === "harness_skill" || msg.type === "harness_open_config" || msg.type === "harness_account") {
      this.harnessSettings(msg).then(
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
    // `wisp node pause` while this run waited its turn behind another: it doesn't start either
    if (this.local.paused) return this.send({ type: "run_failed", runId: run.runId, error: `${this.cfg.name} is paused; ask again once someone resumes it there` });
    if (this.stopped) return this.send({ type: "run_failed", runId: run.runId, error: `${this.cfg.name} was stopped before this run started` });
    const agents = await this.api.request<Agent[]>("GET", "/api/node/agents").catch(() => [] as Agent[]);
    const agent = agents.find((a) => a.id === run.agentId);
    if (!agent) return this.send({ type: "run_failed", runId: run.runId, error: "agent is not assigned to this node" });
    const adapter = this.registry[agent.harness];
    if (!adapter) return this.send({ type: "run_failed", runId: run.runId, error: `no headless adapter for ${agent.harness} yet; connect it with wisp-mcp instead` });

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
    let cwd = (run.computer && this.computers.vmFiles(run.computer)) || path.join(this.cfg.dir, "agents", agentFolder(this.cfg.dir, agent));
    fs.mkdirSync(cwd, { recursive: true });
    // coding tasks run in their own checkout of the team repo, on the task's branch
    if (run.workspace) {
      try {
        cwd = inside ? await prepareClone(this.cfg.dir, vm!.filesDir, run.workspace) : await prepareCheckout(this.cfg.dir, agentFolder(this.cfg.dir, agent), run.workspace);
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
      mcp = inside ? await this.vmMcpSpec(agent.id, run.runId, vm!) : await this.mcpSpec(agent.id, run.runId);
      // the VM's Chrome as page-element tools, run inside the VM either way
      if (vm) {
        const browserBin = vm.user === "warren" ? "warren-browser-mcp" : "wisp-browser-mcp";
        browser = inside ? { command: browserBin, args: [], env: {} } : { command: vm.engine.bin, args: ["exec", "-i", "-u", vm.user, vm.name, browserBin], env: {} };
      }
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
          // the agent's own account of its harness here (its folder), unless it runs inside its VM
          env: Object.assign(inside ? {} : this.accounts.env(agent.harness, this.accounts.accountOf(agent.id, agent.harness)), ...connectors.filter((c) => c.kind === "secret").map((c) => c.env ?? {})),
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

    if (!inside) this.runningHere.set(agent.id, (this.runningHere.get(agent.id) ?? 0) + 1);
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
      if (!inside) {
        const left = (this.runningHere.get(agent.id) ?? 1) - 1;
        if (left > 0) this.runningHere.set(agent.id, left);
        else this.runningHere.delete(agent.id);
      }
    }
  }

  /** Look again at what this device has (someone installed a harness, added one to node.json, started Docker…). */
  private async refresh() {
    if (!this.fixedRegistry) this.registry = deviceAdapters(readJson<Partial<NodeConfig>>(this.configFile, {}).harnesses ?? this.cfg.harnesses);
    this.catalog = null;
    await this.sendCapabilities();
    this.send({ type: "discovered", agents: discoverAgents(this.cfg.discoverHome) });
    this.send({ type: "catalog", catalog: await this.harnessCatalog() });
    await this.sendShelf();
  }

  /** Skills and MCP servers the harnesses here already have, for "On your devices" (secret values stay here). */
  private async sendShelf() {
    const items = await scanShelf({ home: this.cfg.harnessHome }).catch((err) => (this.log(`couldn't look through the harnesses' skills and apps: ${(err as Error).message}`), []));
    this.send({ type: "shelf", items });
  }

  /**
   * Install a harness with this device's own recipe: only npm packages Wisp knows (see
   * HARNESSES[].install), so the hub can name a harness but never choose what runs here.
   */
  private async installHarness(id: string): Promise<string> {
    const pkg = harnessInfo(id)?.install?.npm;
    if (!pkg) throw new Error(`${harnessLabel(id)} isn't installed with npm; install it on ${this.cfg.name} with its own installer`);
    // look again each time: someone may have installed Node.js since the last try, and a GUI-launched app has a short PATH
    const npmDir = findNpmDir();
    if (!npmDir) throw new Error(`${NO_NODE}, and ${harnessLabel(id)} is installed with it. Install Node.js from https://nodejs.org, then try again.`);
    const npm = process.platform === "win32" ? "npm.cmd" : path.join(npmDir, "npm");
    const env = withDir(npmDir);
    this.log(`installing ${harnessLabel(id)} (${pkg})`);
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(npm, ["install", "-g", "--no-audit", "--no-fund", pkg], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", env });
      let text = "";
      child.stdout.on("data", (d) => (text = (text + d).slice(-8000)));
      child.stderr.on("data", (d) => (text = (text + d).slice(-8000)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      child.on("error", (e) => (clearTimeout(timer), resolve({ code: -1, text: (e as NodeJS.ErrnoException).code === "ENOENT" ? "ENOENT" : e.message })));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, text })));
    });
    if (out.code !== 0) {
      if (out.text === "ENOENT") throw new Error(`${NO_NODE}, and ${harnessLabel(id)} is installed with it. Install Node.js from https://nodejs.org, then try again.`);
      const last = out.text.trim().split("\n").slice(-6).join("\n");
      throw new Error(/EACCES|permission denied/i.test(out.text) ? `npm can't write its global folder on ${this.cfg.name} (permission denied). Install it there yourself: npm install -g ${pkg}` : `npm install -g ${pkg} failed:\n${last}`);
    }
    // npm's global bin may not be on this process's PATH (a background service starts with a short one)
    const prefix = await new Promise<string>((resolve) => execFile(npm, ["prefix", "-g"], { env, shell: process.platform === "win32" }, (err, stdout) => resolve(err ? "" : stdout.trim())));
    const bin = prefix && (process.platform === "win32" ? prefix : path.join(prefix, "bin"));
    for (const dir of [bin, npmDir]) if (dir && !(process.env.PATH ?? "").split(path.delimiter).includes(dir)) process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
    this.log(`installed ${harnessLabel(id)}`);
    return out.text.trim().split("\n").slice(-3).join("\n");
  }

  /**
   * The harnesses' own settings (Settings → Harnesses). The hub lets only this device's owner ask;
   * the device reads and writes the files itself, so the hub names a harness and a change, never a path.
   */
  private async harnessSettings(msg: Extract<HubToNode, { type: "harness_settings" | "harness_settings_change" | "harness_skill" | "harness_open_config" | "harness_account" }>) {
    const base = { home: this.cfg.harnessHome };
    const known = (id: string) => {
      if (!(SETTINGS_HARNESSES as readonly string[]).includes(id)) throw new Error(`Wisp can't change ${harnessLabel(id)}'s settings yet`);
    };
    // each account is the harness's own folder somewhere else
    const homes = (harness: string, account = "default") => {
      if (account !== "default" && !this.accounts.list(harness).some((a) => a.id === account)) throw new Error(`${harnessLabel(harness)} has no account "${account}" on ${this.cfg.name}`);
      return { ...base, dirs: { [harness]: this.accounts.dir(harness, account) } };
    };
    const withAccounts = (s: HarnessSettings, account = "default"): HarnessSettings => ({ ...s, account, accounts: this.accounts.list(s.harness), multiAccount: HarnessAccounts.supports(s.harness), agentAccounts: this.accounts.agentAccounts() });
    if (msg.type === "harness_settings") {
      if (this.catalogIncomplete) {
        this.catalog = null;
        void this.harnessCatalog().then((catalog) => this.send({ type: "catalog", catalog }));
      }
      const installed = new Set((await this.harnessCatalog()).map((c) => c.harness));
      const here = await Promise.all(SETTINGS_HARNESSES.map(async (id) => installed.has(id) || (await harnessConfigured(id, base))));
      const ids = SETTINGS_HARNESSES.filter((id, i) => (msg.harness ? id === msg.harness : here[i]));
      return Promise.all(ids.map(async (id) => withAccounts(await readHarnessSettings(id, homes(id, msg.harness === id ? msg.account : undefined)), msg.harness === id ? (msg.account ?? "default") : "default")));
    }
    known(msg.harness);
    // only harnesses this device has (installed, or set up with a config)
    if (!(await this.harnessCatalog()).some((c) => c.harness === msg.harness) && !(await harnessConfigured(msg.harness, base))) throw new Error(`${harnessLabel(msg.harness)} isn't on ${this.cfg.name}`);
    if (msg.type === "harness_skill") return readHarnessSkill(msg.harness, msg.id, homes(msg.harness, msg.account));
    if (msg.type === "harness_open_config") {
      const file = harnessConfigPath(msg.harness, homes(msg.harness, msg.account))!;
      if (!fs.existsSync(file)) throw new Error(`${file} doesn't exist on ${this.cfg.name} yet`);
      const [cmd, args] = process.platform === "darwin" ? ["open", ["-t", file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
      spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      return { path: file };
    }
    if (msg.type === "harness_account") return this.harnessAccount(msg.harness, msg.action);
    if (this.local.paused) throw new Error(`${this.cfg.name} is paused`);
    this.log(`changing ${harnessLabel(msg.harness)}'s settings${msg.account && msg.account !== "default" ? ` (account ${msg.account})` : ""}`);
    const settings = withAccounts(await changeHarnessSettings(msg.harness, msg.changes, homes(msg.harness, msg.account)), msg.account);
    // a new default model shows up in the agent's model picker
    if (msg.changes.some((c) => c.op !== "toggle")) {
      this.catalog = null;
      void this.harnessCatalog().then((catalog) => this.send({ type: "catalog", catalog }));
    }
    return settings;
  }

  /** Accounts of a harness here, and signing them in (the harness's own sign-in, with the account's folder). */
  private async harnessAccount(harness: string, action: HarnessAccountOp): Promise<unknown> {
    const a = this.accounts;
    if (action.op === "login_status") return this.logins.status(action.loginId);
    if (action.op === "login_input") return this.logins.input(action.loginId, action.text);
    if (action.op === "login_cancel") return this.logins.cancel(action.loginId), { ok: true };
    if (this.local.paused) throw new Error(`${this.cfg.name} is paused`);
    if (action.op === "add") {
      this.log(`adding a ${harnessLabel(harness)} account (${action.label})`);
      return a.add(harness, action.label);
    }
    if (action.op === "rename") return a.rename(harness, action.account, action.label), { ok: true };
    if (action.op === "remove") return a.remove(harness, action.account);
    if (action.op === "assign") return a.assign(action.agentId, harness, action.account), { ok: true };
    if (action.account !== "default" && !a.list(harness).some((x) => x.id === action.account)) throw new Error(`${harnessLabel(harness)} has no account "${action.account}"`);
    const cmd = loginCommand(harness, action.provider);
    const env = a.env(harness, action.account);
    // a sign-in that only runs in its own screen: the command to type at the device
    if ("manual" in cmd) return { manual: [...Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ...cmd.manual].join(" ") };
    this.log(`signing in ${harnessLabel(harness)} (account ${action.account})`);
    return this.logins.start(harness, action.account, { command: this.registry[harness]?.binary || cmd.command, args: cmd.args, env });
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
    ).then((list) => {
      const found = list.filter((c): c is HarnessCatalog => !!c && c.version !== null);
      // Codex listing no models (offline or not signed in at start-up) is asked again when settings are opened
      this.catalogIncomplete = found.some((c) => c.models.length === 0 && c.harness === "codex");
      return found;
    });
    return this.catalog;
  }

  /**
   * The harness gets wisp-mcp with a token for its agent alone, so whatever the agent runs can't
   * act as this device or its other agents. Only a hub from before agent tokens (it has no such
   * endpoint) gets the device's token; when the hub merely can't answer, the run fails instead.
   */
  private async mcpSpec(agentId: string, runId: string): Promise<McpServerSpec> {
    const token = await this.harnessToken(agentId);
    // in the desktop app this "node" is the app itself, which runs scripts only when told to
    const asNode: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
    return {
      command: process.execPath,
      args: [MCP_BIN],
      // WISP_RUN: which request its calls belong to, when the agent is answering several at once
      env: token ? { ...asNode, WISP_URL: this.cfg.hub, WISP_TOKEN: token, WISP_RUN: runId } : { ...asNode, WISP_URL: this.cfg.hub, WISP_TOKEN: this.cfg.token, WISP_AGENT: agentId, WISP_RUN: runId },
    };
  }

  /** wisp-mcp for a harness inside a VM: Wisp's tools copied into the VM, talking to the hub from in there. */
  private async vmMcpSpec(agentId: string, runId: string, vm: DockerVm): Promise<McpServerSpec> {
    const token = await this.harnessToken(agentId);
    if (!token) throw new Error("the hub didn't give this agent a token of its own; update the hub");
    const bundle = await mcpBundle();
    const file = `${vm.home}/.wisp/wisp-mcp.mjs`;
    if (this.vmTools.get(vm.name) !== bundle.hash) {
      await vm.writeFile(file, bundle.code);
      this.vmTools.set(vm.name, bundle.hash);
    }
    return { command: "node", args: [file], env: { WISP_URL: await vm.hubUrl(this.cfg.hub), WISP_TOKEN: token, WISP_RUN: runId } };
  }

  private async harnessToken(agentId: string): Promise<string | null> {
    const known = this.agentTokens[agentId];
    if (known && (await this.tokenWorks(known))) return known;
    const r = await this.api.request<{ token: string }>("POST", `/api/node/agents/${agentId}/token`).catch((err) => {
      if (err instanceof WispError && err.status === 404) return null; // an older hub
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
 * The hub's address as people type it ("my-server:4747", "https://wisp.example.com/",
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
