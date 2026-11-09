import { migrateHome } from "./migrate-home.ts";
import { migrateServices } from "./migrate-services.ts";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { CONNECTOR_CATALOG, HARNESSES, HubToNode, SETTINGS_HARNESSES, VM_HARNESSES, credentialSupport, harnessInfo, harnessLabel, providerLabel, readTunnelFrame, tunnelFrame, withArticle, TERM_PREFIX, type AccessLevel, type HarnessAccountOp, type HarnessSettings, type Agent, type ComputerSpec, type ConnectorSpec, type CommandOption, type HarnessCatalog, type NodeToHub, type RunCredential, type RunRequest, type VmConfig } from "@wisp/core";
import { HARNESS_SPECS, HarnessAccounts, adapters as builtinAdapters, changeHarnessSettings, deviceAdapters, harnessConfigured, localCredentialFs, loginCommand, prepareCredential, scanShelf, harnessConfigPath, readHarnessSettings, readHarnessSkill, type CatalogPlace, type CredentialFs, type DeviceHarness, type HarnessAdapter, type McpServerSpec, type PreparedCredential, type RunPlace } from "@wisp/adapters";
import { WispClient, WispError } from "@wisp/sdk";
import { runUpdate, version } from "@wisp/update";
import { ComputerHost, type Tunnel } from "./computers/index.ts";
import { RemoteDesktopServer, type RemoteDesktopConfig } from "./computers/remote-desktop.ts";
import type { RustdeskConfig } from "./rustdesk.ts";
import { detectRemoteApps } from "./remote-apps.ts";
import { ScreenLock, type ScreenCode } from "./screen-lock.ts";
import { Terminals, deviceShell, sessionName, shellQuote, vmShell } from "./terminals.ts";
import { HarnessLogins } from "./harness-login.ts";
import { ModelLogins } from "./model-login.ts";
import { recipeTag, type DockerVm } from "./computers/docker.ts";
import { mcpBundle } from "./vm-tools.ts";
import { NO_NODE, findNpmDir, withDir } from "./npm.ts";
import { discoverAgents, readDiscovered } from "./discover.ts";
import { agentFolder } from "./agent-dir.ts";
import { bringBack, mergeBranch, prepareCheckout, prepareClone } from "./git.ts";

/** How often a device looks again at whether its harnesses are signed in (someone may do it in a terminal). */
const SIGN_IN_CHECK_MS = 20_000;
const MCP_BIN = fileURLToPath(new URL("../../../bin/wisp-mcp.mjs", import.meta.url));
const BROWSER_BIN = fileURLToPath(new URL("../../../bin/wisp-browser.mjs", import.meta.url));

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
  /** the Code mod's shells, here and in the VMs (keys: "dev:<computer>:<session>" or "vm:…") */
  private terminals = new Terminals();
  /** terminals still starting (a VM coming up), and whether the hub let go of them meanwhile */
  private openingTerms = new Map<string, { end?: boolean; gone?: boolean }>();
  /** each harness's logins here, and which agent uses which */
  private accounts: HarnessAccounts;
  /** whether each harness is signed in, where it runs ("<computer id or nothing>\\n<harness>") */
  private signIns = new Map<string, { accounts: Record<string, boolean | null>; agentAccounts?: Record<string, string> }>();
  private vmSpecs = new Map<string, ComputerSpec>();
  private signInTimer: ReturnType<typeof setInterval> | null = null;
  /** sign-ins running for those accounts */
  private logins = new HarnessLogins();
  /** sign-ins to model providers this device runs for the hub (Settings → Models) */
  private modelLogins: ModelLogins;
  /** connections whose folders may stay (null until the hub says); connections runs here are using right now */
  private keepConnections: Set<string> | null = null;
  private connectionsInUse = new Map<string, number>();
  /** VMs whose harnesses were listed for the hub since this process started (computer id → the listing) */
  private vmCatalogs = new Map<string, Promise<void>>();
  /** each VM's harnesses as last listed (computer id → the listing), to send again with what runs learned */
  private vmLists = new Map<string, HarnessCatalog[]>();
  /** a harness's "/" list as its own sessions reported it (Claude Code), by where it ran: "<computer id or empty>\n<harness>" */
  private runCommands = new Map<string, CommandOption[]>();
  /** which harness made each remembered session (a session id means nothing to another harness) */
  private sessionHarness: Record<string, string>;
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
    this.sessionHarness = readJson(path.join(cfg.dir, "session-harness.json"), {});
    this.agentTokens = readJson(this.tokensFile, {});
    this.modelLogins = new ModelLogins((m) => this.send(m), path.join(cfg.dir, "login-scratch"));
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

  /**
   * A shell for the Code mod, on this device or inside one of its VMs. The hub lets only the
   * computer's owner ask; this device's own shell also needs the screen's code, checked here every time.
   */
  private async openTerminal(msg: Extract<HubToNode, { type: "term_open" }>) {
    const { termId, computer } = msg;
    const closed = (error?: string, exited?: boolean) => this.send({ type: "term_closed", termId, error, exited });
    if (this.local.paused) return closed("the device is paused");
    if (computer.kind !== "device" && computer.kind !== "vm") return closed("this computer has no terminal here");
    if (computer.kind === "device" && this.lock.enabled) {
      const r = this.lock.check(msg.code);
      this.codeResult(r);
      if (!r.ok) return closed(r.error);
    }
    const session = sessionName(msg.session);
    const key = `${computer.kind === "vm" ? "vm" : "dev"}:${computer.id}:${session}`;
    const command = async () => {
      // a harness's CLI in the pane: only ones from Wisp's own list, by name
      const harness = msg.launch ? HARNESSES.find((h) => h.id === msg.launch) : undefined;
      if (msg.launch && !harness) throw new Error(`${msg.launch} isn't a harness Wisp knows`);
      const vm = computer.kind === "vm" ? await this.computers.vm(computer) : null;
      if (computer.kind === "vm" && !vm) throw new Error("this VM isn't on this device");
      await vm?.ready();
      const pane = harness ? await this.terminalLaunch(harness.id, harness.binary, msg.credential, vm, computer.name, msg.harnessOn) : null;
      const cmd = vm ? vmShell({ bin: vm.engine.bin, name: vm.name, user: vm.user, home: vm.home }, session, pane?.launch) : deviceShell(session, { launch: pane?.launch });
      return { ...cmd, ended: pane?.ended };
    };
    const opening: { end?: boolean; gone?: boolean } = {};
    this.openingTerms.set(termId, opening);
    try {
      const { resumed, replay } = await this.terminals.attach(
        key,
        termId,
        { cols: msg.cols, rows: msg.rows },
        command,
        (b) => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(tunnelFrame(termId, b));
        },
        closed,
      );
      if (opening.gone) return this.terminals.detach(termId, opening.end);
      // ready first, so the page clears itself before the recent screen arrives
      this.send({ type: "term_ready", termId, resumed });
      replay();
    } catch (err) {
      closed((err as Error).message);
    } finally {
      this.openingTerms.delete(termId);
    }
  }

  /**
   * What a terminal runs to start a harness's CLI: signed in with the model connection agent runs on
   * that computer use (in the same folder, so a sign-in either renews stays shared), or the harness's
   * own sign-in there. A VM's harness with neither is said in plain words instead of opening its own
   * sign-in prompt.
   */
  private async terminalLaunch(harness: string, binary: string, cred: RunCredential | undefined, vm: DockerVm | null, where: string, harnessOn?: string): Promise<{ launch: string; ended?: () => void }> {
    const label = harnessLabel(harness);
    const support = cred ? credentialSupport(harness, cred.provider, cred.kind) : null;
    // PowerShell has no `. file` for the variables: Windows CLIs use their own sign-in
    if (!cred || !support || (!vm && process.platform === "win32")) {
      if (vm && (await vm.signedIn(harness).catch(() => null)) === false) {
        // the agents here run it on a device, signed in there; that sign-in stays on the device
        if (harnessOn) throw new Error(`The agents on ${where} run ${label} on ${harnessOn}, signed in there. Open ${label} on ${harnessOn}, or run \`${binary} login\` in a shell here to sign ${where} in too.`);
        throw new Error(`${label} isn't signed in on ${where}. Connect a model for it in Settings → Models, or sign in to ${label} once from an agent's page → Computer.`);
      }
      return { launch: binary };
    }
    const id = safeId(cred.connectionId);
    this.keepConnections?.add(id);
    const files = vm ? vmCredentialFs(vm) : localCredentialFs;
    const baseHome = vm ? `${vm.home}/${VM_HARNESS_DIR[harness] ?? ".config"}` : this.accounts.dir(harness, this.accounts.accountOf("", harness));
    const connectionHome = vm ? `${vm.home}/.wisp/connections/${id}/${harness}` : path.join(this.cfg.dir, "connections", id, harness);
    let prepared: PreparedCredential;
    try {
      prepared = await prepareCredential(harness, cred, { fs: files, baseHome, connectionHome });
      // Codex's own screen reads a key only from auth.json (CODEX_API_KEY is for `codex exec`), so it
      // gets one in the connection's folder, as `codex login --with-api-key` writes it
      if (harness === "codex" && cred.kind === "key") {
        if (cred.provider !== "openai") throw new Error(`Codex's own screen can't use ${withArticle(providerLabel(cred.provider))} key`);
        await files.write(files.join(connectionHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: cred.secret.key }, null, 2), 0o600);
        for (const name of ["config.toml", "skills", "AGENTS.md", "rules", "prompts"]) await files.link(files.join(baseHome, name), files.join(connectionHome, name)).catch(() => {});
        prepared = { env: { CODEX_HOME: connectionHome }, refreshed: async () => null };
      }
    } catch (err) {
      throw new Error(`couldn't use the ${providerLabel(cred.provider)} connection: ${(err as Error).message}`);
    }
    // its variables in a private file, read by the CLI's own shell only (not left in the shell after it)
    const file = files.join(connectionHome, "terminal.env");
    await files.write(file, Object.entries(prepared.env).map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join(""), 0o600);
    // a sign-in the CLI renewed goes back to the hub, as a run's does
    const ended = () =>
      void prepared
        .refreshed()
        .then((secret) => secret && this.send({ type: "credential_refreshed", connectionId: cred.connectionId, terminal: true, secret }))
        .catch(() => {});
    return { launch: `(. ${shellQuote(file)}; ${binary})`, ended };
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
      if (codeChanged) this.terminals.killAll("dev:");
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
    if (this.local.paused) this.terminals.killAll();
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
    if (this.signInTimer) clearInterval(this.signInTimer);
    fs.unwatchFile(this.configFile, this.onLocalChange);
    for (const a of this.aborts.values()) a.abort();
    this.computers.stopAll();
    this.logins.stopAll();
    this.modelLogins.stopAll();
    this.closeTunnels();
    this.terminals.killAll();
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
        if (!frame) return;
        if (frame.tunnelId.startsWith(TERM_PREFIX)) this.terminals.write(frame.tunnelId, frame.payload);
        else this.tunnels.get(frame.tunnelId)?.write(frame.payload);
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
      // shells keep running for a while, so the person picks up where they were once it's back
      this.terminals.detachAll();
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
    // a run's outcome must reach the hub, or the agent stays "busy" there; so must a renewed sign-in (the old one
    // is dead once a harness renews it) and a finished model sign-in; everything else is a snapshot the hub asks for again
    if (m.type === "run_done" || m.type === "run_failed" || m.type === "credential_refreshed" || m.type === "model_login_done") {
      this.outbox.push(m);
      if (this.outbox.length > 200) this.outbox.shift();
      if (m.type === "run_done" || m.type === "run_failed") this.log(`hub is away; will report ${m.runId} when it's back`);
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
      await this.sendCatalog();
      void this.sendShelf();
      this.signInTimer ??= setInterval(() => void this.refreshSignIns().catch(() => {}), SIGN_IN_CHECK_MS);
      this.signInTimer.unref?.();
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
          // a VM that just came up: tell the hub which harnesses (and models) it has
          if (msg.action.action === "start" && msg.computer.kind === "vm") {
            void this.sendVmCatalog(msg.computer);
            void this.sweepVmConnections(msg.computer);
          }
          if (msg.action.action === "destroy") {
            this.forgetVm(msg.computer.id);
            this.terminals.killAll(`vm:${msg.computer.id}:`);
          }
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
    } else if (msg.type === "term_open") {
      void this.openTerminal(msg);
    } else if (msg.type === "term_resize") {
      this.terminals.resize(msg.termId, msg.cols, msg.rows);
    } else if (msg.type === "term_close") {
      const opening = this.openingTerms.get(msg.termId);
      if (opening) Object.assign(opening, { gone: true, end: msg.end });
      else this.terminals.detach(msg.termId, msg.end);
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
    } else if (msg.type === "model_login") {
      try {
        if (msg.op === "start") {
          if (this.local.paused) throw new Error(`${this.cfg.name} is paused`);
          if (!msg.provider || !msg.harness) throw new Error("which provider and harness to sign in with?");
          this.log(`signing in to ${providerLabel(msg.provider)} with ${harnessLabel(msg.harness)} for the hub`);
          this.send({ type: "result", requestId: msg.requestId, ok: true, result: this.modelLogins.start(msg.loginId, msg.provider, msg.harness, this.registry[msg.harness]?.binary) });
        } else if (msg.op === "input") this.send({ type: "result", requestId: msg.requestId, ok: true, result: this.modelLogins.input(msg.loginId, msg.text ?? "") });
        else {
          this.modelLogins.cancel(msg.loginId);
          this.send({ type: "result", requestId: msg.requestId, ok: true, result: { ok: true } });
        }
      } catch (err) {
        this.send({ type: "result", requestId: msg.requestId, ok: false, error: (err as Error).message });
      }
    } else if (msg.type === "computer_catalog") {
      void this.sendVmCatalog(msg.computer, true);
    } else if (msg.type === "connections_keep") {
      this.keepConnections = new Set(msg.connectionIds.map(safeId));
      this.sweepConnections();
      for (const c of msg.computers) void this.sweepVmConnections(c);
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
    let agents: Agent[];
    try {
      agents = await this.api.request<Agent[]>("GET", "/api/node/agents");
    } catch (err) {
      // the hub didn't answer: say so, instead of claiming the agent isn't assigned here
      return this.send({ type: "run_failed", runId: run.runId, error: hubUnreachableMessage(this.cfg.name, this.cfg.hub, err) });
    }
    const agent = agents.find((a) => a.id === run.agentId);
    if (!agent) return this.send({ type: "run_failed", runId: run.runId, error: "agent is not assigned to this node" });
    const adapter = this.registry[agent.harness];
    if (!adapter) return this.send({ type: "run_failed", runId: run.runId, error: `no headless adapter for ${agent.harness} yet; connect it with wisp-mcp instead` });

    // its VM, when it has one here: it runs inside it (started now), or gets its browser (the VM starts on first use)
    let vm: DockerVm | null = null;
    if (run.computer?.kind === "vm") {
      try {
        vm = await this.computers.vm(run.computer);
        if (run.inComputer) await vm?.ready();
        else await vm?.identityReady();
      } catch (err) {
        if (run.inComputer) return this.send({ type: "run_failed", runId: run.runId, error: `couldn't start ${run.computer.name}: ${(err as Error).message}` });
        vm = null;
      }
    }
    const inside = !!run.inComputer && !!vm;
    if (run.inComputer && !vm) return this.send({ type: "run_failed", runId: run.runId, error: "its computer isn't a VM on this device" });
    // the model connection the hub sent, if the harness can use it (an older hub sends none)
    const support = run.credential ? credentialSupport(agent.harness, run.credential.provider, run.credential.kind) : null;
    if (run.credential && !support) this.send({ type: "run_event", runId: run.runId, event: { type: "notice", text: `${harnessLabel(agent.harness)} can't use the ${providerLabel(run.credential.provider)} connection, so it ran on its own sign-in here.` } });
    // with a connection it needs no sign-in of its own in there
    if (inside && !support) {
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
    // on the shared computer each agent has its own working folder in the shared files, which the others can still open
    const vmFiles = run.computer ? this.computers.vmFiles(run.computer) : null;
    let cwd = vmFiles ? ((run.computer!.config as VmConfig).shared ? path.join(vmFiles, agentFolder(this.cfg.dir, agent)) : vmFiles) : path.join(this.cfg.dir, "agents", agentFolder(this.cfg.dir, agent));
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
    // each chat (a new one starts after a quiet break) is its own harness session
    const sessionKey = `${agent.id}:${run.channelId}:${run.threadId ?? "main"}${run.conversation ? `:${run.conversation}` : ""}`;
    // a session another harness made can't be continued by this one: it switched, so the reply starts fresh
    if (this.sessions[sessionKey] && (this.sessionHarness[sessionKey] ?? agent.harness) !== agent.harness) {
      delete this.sessions[sessionKey];
      writeJson(this.sessionsFile, this.sessions);
    }
    // the connection goes where the harness reads it: its environment, or a folder of its own (kept, for resuming)
    let credential: PreparedCredential | null = null;
    let usedConnection: string | null = null;
    if (run.credential && support) {
      const used = safeId(run.credential.connectionId);
      this.keepConnections?.add(used);
      this.connectionsInUse.set(used, (this.connectionsInUse.get(used) ?? 0) + 1);
      usedConnection = used;
      try {
        const baseHome = inside ? `${vm!.home}/${VM_HARNESS_DIR[agent.harness] ?? ".config"}` : this.accounts.dir(agent.harness, this.accounts.accountOf(agent.id, agent.harness));
        const connectionHome = inside ? `${vm!.home}/.wisp/connections/${safeId(run.credential.connectionId)}/${agent.harness}` : path.join(this.cfg.dir, "connections", safeId(run.credential.connectionId), agent.harness);
        credential = await prepareCredential(agent.harness, run.credential, { fs: inside ? vmCredentialFs(vm!) : localCredentialFs, baseHome, connectionHome });
      } catch (err) {
        this.connectionDone(usedConnection);
        return this.send({ type: "run_failed", runId: run.runId, error: `couldn't use the ${providerLabel(run.credential.provider)} connection: ${(err as Error).message}` });
      }
    }
    const abort = new AbortController();
    this.aborts.set(run.runId, abort);
    this.log(`@${agent.handle} (${adapter.label}) working on ${run.runId}${inside ? ` inside ${run.computer!.name}` : ""}`);
    let mcp: McpServerSpec, browser: McpServerSpec | undefined;
    try {
      mcp = inside ? await this.vmMcpSpec(agent.id, run.runId, vm!) : await this.mcpSpec(agent.id, run.runId);
      // the VM's Chrome as page-element tools, run inside the VM either way
      if (vm) {
        const browserBin = vm.user === "warren" ? "warren-browser-mcp" : "wisp-browser-mcp";
        browser = inside ? { command: browserBin, args: [], env: {} } : await this.lazyBrowser(agent.id, run.runId, vm, browserBin);
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
        const text = `Connected app ${c.name} didn't start: "${c.command}" isn't installed on ${this.cfg.name}.`;
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
          // on a connection with no model picked: the one the hub chose from what the connection offers
          model: run.model ?? agent.model ?? (credential ? run.credential?.model : undefined) ?? null,
          effort: run.effort ?? (run.model ? null : (agent.settings?.effort ?? null)),
          fast: run.model ? false : (agent.settings?.fast ?? false),
          // off unless the device owner turned it on: the person's own plugins skip Wisp's screen switch and approvals
          ownPlugins: agent.settings?.ownPlugins === true,
          access,
          sessionId,
          mcp,
          browser,
          // MCP connectors go to the harness's own config; secrets go in its environment
          connectors: connectors.filter((c: ConnectorSpec) => c.kind !== "secret"),
          // the agent's own account of its harness here (its folder), unless it runs inside its VM; then its connection, which wins
          env: Object.assign(inside ? {} : this.accounts.env(agent.harness, this.accounts.accountOf(agent.id, agent.harness)), ...connectors.filter((c) => c.kind === "secret").map((c) => c.env ?? {}), credential?.env ?? {}),
          launch: inside ? vm!.launcher(run.runId) : undefined,
          place: inside ? vmPlace(vm!) : undefined,
          connection: credential && run.credential ? { provider: run.credential.provider, kind: run.credential.kind } : undefined,
          signal: abort.signal,
          options: this.cfg.harnessOptions?.[agent.harness],
        },
        (e) => {
          if (e.type === "commands") return void this.learnCommands(agent.harness, inside ? run.computer!.id : null, e.commands);
          if (e.type === "session") {
            // a fresh run is never continued, so there's nothing to remember
            if (run.fresh) return;
            // only the chat going on now is ever continued: earlier chats' sessions (and the one from before chats split) go
            if (run.conversation) {
              const base = sessionKey.slice(0, -(run.conversation.length + 1));
              for (const k of Object.keys(this.sessions)) if (k === base || (k.startsWith(`${base}:`) && k !== sessionKey)) {
                delete this.sessions[k];
                delete this.sessionHarness[k];
              }
            }
            this.sessions[sessionKey] = e.id;
            writeJson(this.sessionsFile, this.sessions);
            this.sessionHarness[sessionKey] = agent.harness;
            writeJson(path.join(this.cfg.dir, "session-harness.json"), this.sessionHarness);
          } else {
            if (e.type === "text" || e.type === "tool_call" || e.type === "tool_result") progressed = true;
            this.send({ type: "run_event", runId: run.runId, event: e });
          }
        },
      );

    // a sign-in the harness renewed during the run goes back to the hub, or the next run anywhere uses a dead one.
    // Before the run's outcome: the outcome is what lets the hub hand the sign-in to the next run waiting.
    const reportRenewal = async () => {
      if (!credential || !run.credential) return;
      const renewed = await credential.refreshed().catch(() => null);
      if (!renewed) return;
      this.send({ type: "credential_refreshed", connectionId: run.credential.connectionId, runId: run.runId, secret: renewed });
      this.log(`@${agent.handle}: ${providerLabel(run.credential.provider)} sign-in renewed; sent to the hub`);
    };

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
      await reportRenewal();
      this.send({ type: "run_done", runId: run.runId, finalText: result.finalText });
      this.log(`@${agent.handle} finished ${run.runId}`);
    } catch (err) {
      const message = abort.signal.aborted ? (abort.signal.reason === "paused" ? `stopped: ${this.cfg.name} was paused` : "cancelled") : (err as Error).message;
      await reportRenewal();
      this.send({ type: "run_failed", runId: run.runId, error: message });
      this.log(`@${agent.handle} failed ${run.runId}: ${message}`);
    } finally {
      this.aborts.delete(run.runId);
      this.connectionDone(usedConnection);
      if (inside) await vm!.cleanupRun(run.runId).catch(() => {});
      // the first run in a VM since this started: tell the hub what's installed in there
      if (inside && run.computer) {
        void this.sendVmCatalog(run.computer);
        void this.sweepVmConnections(run.computer);
      }
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
    await this.sendCatalog();
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
    const withAccounts = async (s: HarnessSettings, account = "default"): Promise<HarnessSettings> => ({ ...s, account, accounts: await this.accounts.listChecked(s.harness, this.registry[s.harness]?.binary), multiAccount: HarnessAccounts.supports(s.harness), agentAccounts: this.accounts.agentAccounts() });
    if (msg.type === "harness_settings") {
      if (this.catalogIncomplete) {
        this.catalog = null;
        void this.sendCatalog();
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
    const settings = await withAccounts(await changeHarnessSettings(msg.harness, msg.changes, homes(msg.harness, msg.account)), msg.account);
    // a new default model shows up in the agent's model picker
    if (msg.changes.some((c) => c.op !== "toggle")) {
      this.catalog = null;
      void this.sendCatalog();
    }
    return settings;
  }

  /** Accounts of a harness here, and signing them in (the harness's own sign-in, with the account's folder). */
  private async harnessAccount(harness: string, action: HarnessAccountOp): Promise<unknown> {
    const a = this.accounts;
    if (action.op === "login_status") {
      const status = this.logins.status(action.loginId);
      if (status.status === "done") {
        a.forgetChecks();
        void this.refreshSignIns();
      }
      return status;
    }
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


  /** A run stopped using a connection: if that connection was removed meanwhile, its folder can go now. */
  private connectionDone(id: string | null) {
    if (!id) return;
    const left = (this.connectionsInUse.get(id) ?? 1) - 1;
    if (left > 0) this.connectionsInUse.set(id, left);
    else this.connectionsInUse.delete(id);
    this.sweepConnections();
  }

  /** Remove this device's folders of connections it may no longer keep (their sign-ins and keys are in them). */
  private sweepConnections() {
    if (!this.keepConnections) return;
    const root = path.join(this.cfg.dir, "connections");
    const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
    for (const name of names) if (!this.keepConnections.has(name) && !this.connectionsInUse.has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }

  /** The same inside a VM, when it's up (one that's down is swept when it next starts). */
  private async sweepVmConnections(spec: ComputerSpec) {
    if (!this.keepConnections || spec.kind !== "vm") return;
    const vm = await this.computers.vm(spec).catch(() => null);
    if (!vm || !(await vm.isRunning().catch(() => false))) return;
    await vm.pruneConnections([...this.keepConnections, ...this.connectionsInUse.keys()]).catch((err) => this.log(`couldn't clear removed connections from ${spec.name}: ${(err as Error).message}`));
  }

  /**
   * The harnesses that come with a VM, as installed in it, with their models: what agents that run
   * inside it use (the device itself may have none of them). Once per VM per process unless `again`;
   * only for a VM that's already up, so asking never starts one.
   */
  private sendVmCatalog(spec: ComputerSpec, again = false): Promise<void> {
    if (spec.kind !== "vm" || this.fixedRegistry) return Promise.resolve();
    const known = this.vmCatalogs.get(spec.id);
    if (known && !again) return known;
    const job = (async () => {
      const vm = await this.computers.vm(spec).catch(() => null);
      if (!vm || !(await vm.isRunning().catch(() => false))) return void this.vmCatalogs.delete(spec.id);
      const place = vmCatalogPlace(vm);
      const list = await Promise.all(
        VM_HARNESSES.map(async (id) => {
          try {
            return (await builtinAdapters[id]?.catalog?.(place)) ?? null;
          } catch {
            return null;
          }
        }),
      );
      const found = list.filter((c): c is HarnessCatalog => !!c && c.version !== null);
      this.vmLists.set(spec.id, found);
      this.vmSpecs.set(spec.id, spec);
      await this.readVmSignIns(spec.id, vm, found);
      this.send({ type: "catalog", computerId: spec.id, catalog: this.withRunCommands(found, spec.id) });
    })().catch(() => void this.vmCatalogs.delete(spec.id));
    this.vmCatalogs.set(spec.id, job);
    return job;
  }

  /** A VM was removed: drop what was listed for it and what its runs reported. */
  forgetVm(computerId: string) {
    this.vmCatalogs.delete(computerId);
    this.vmLists.delete(computerId);
    this.vmSpecs.delete(computerId);
    for (const key of [...this.signIns.keys()]) if (key.startsWith(`${computerId}\n`)) this.signIns.delete(key);
    for (const key of [...this.runCommands.keys()]) if (key.startsWith(`${computerId}\n`)) this.runCommands.delete(key);
  }

  /** This device's harnesses, with what runs here learned about their "/" lists. */
  private async sendCatalog() {
    const list = await this.harnessCatalog();
    await this.readSignIns(list);
    this.send({ type: "catalog", catalog: this.withRunCommands(list, null) });
  }

  /** Whether each harness here is signed in, for the hub to show before anyone's first message fails. True when that changed. */
  private async readSignIns(list: HarnessCatalog[]): Promise<boolean> {
    const before = JSON.stringify(list.map((c) => this.signIns.get(`\n${c.harness}`)));
    await Promise.all(
      list.map(async (c) => {
        if (!HARNESS_SPECS[c.harness]) return;
        const accounts = await this.accounts.listChecked(c.harness, this.registry[c.harness]?.binary);
        const agentAccounts = Object.fromEntries(Object.entries(this.accounts.agentAccounts()).filter(([, id]) => accounts.some((a) => a.id === id)));
        this.signIns.set(`\n${c.harness}`, { accounts: Object.fromEntries(accounts.map((a) => [a.id, a.signedIn])), agentAccounts });
      }),
    );
    return JSON.stringify(list.map((c) => this.signIns.get(`\n${c.harness}`))) !== before;
  }

  /** Look again (someone signed in or out, here or inside a VM), and tell the hub what changed. */
  private async refreshSignIns() {
    if (this.stopped) return;
    const list = await this.harnessCatalog();
    if (await this.readSignIns(list)) this.send({ type: "catalog", catalog: this.withRunCommands(list, null) });
    for (const [id, found] of this.vmLists) {
      const spec = this.vmSpecs.get(id);
      const vm = spec && (await this.computers.vm(spec).catch(() => null));
      if (!vm || !(await vm.isRunning().catch(() => false))) continue;
      if (await this.readVmSignIns(id, vm, found)) this.send({ type: "catalog", computerId: id, catalog: this.withRunCommands(found, id) });
    }
  }

  private async readVmSignIns(id: string, vm: DockerVm, list: HarnessCatalog[]): Promise<boolean> {
    const before = JSON.stringify(list.map((c) => this.signIns.get(`${id}\n${c.harness}`)));
    await Promise.all(list.map(async (c) => this.signIns.set(`${id}\n${c.harness}`, { accounts: { default: await vm.signedIn(c.harness).catch(() => null) } })));
    return JSON.stringify(list.map((c) => this.signIns.get(`${id}\n${c.harness}`))) !== before;
  }

  /** The catalogs with each harness's "/" list replaced by the one its sessions reported there, if any. */
  private withRunCommands(list: HarnessCatalog[], computerId: string | null): HarnessCatalog[] {
    return list.map((c) => {
      const commands = this.runCommands.get(`${computerId ?? ""}\n${c.harness}`);
      const signIns = this.signIns.get(`${computerId ?? ""}\n${c.harness}`);
      return { ...c, ...signIns, ...(commands ? { commands } : {}) };
    });
  }

  /**
   * A run's harness said what it can run (Claude Code does at the start of each session): keep it
   * for where it ran (this device or a VM), and tell the hub when that changes what "/" shows.
   */
  async learnCommands(harness: string, computerId: string | null, commands: CommandOption[]) {
    const key = `${computerId ?? ""}\n${harness}`;
    const list = computerId ? this.vmLists.get(computerId) : await this.harnessCatalog();
    const before = JSON.stringify(list ? this.withRunCommands(list, computerId).find((c) => c.harness === harness)?.commands : this.runCommands.get(key));
    this.runCommands.set(key, commands);
    if (!list || JSON.stringify(commands) === before) return;
    this.send({ type: "catalog", ...(computerId ? { computerId } : {}), catalog: this.withRunCommands(list, computerId) });
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

  /**
   * The VM's browser tools for a harness outside it, standing in until first used so a chat reply
   * doesn't start the computer (see browser-proxy.ts). Without a token of its own (an older hub) it
   * runs them in the VM straight away.
   */
  private async lazyBrowser(agentId: string, runId: string, vm: DockerVm, browserBin: string): Promise<McpServerSpec> {
    const direct = [vm.engine.bin, "exec", "-i", "-u", vm.user, vm.name, browserBin];
    const token = await this.harnessToken(agentId);
    if (!token) {
      await vm.ready();
      return { command: direct[0], args: direct.slice(1), env: {} };
    }
    const asNode: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
    return {
      command: process.execPath,
      args: [BROWSER_BIN],
      env: { ...asNode, WISP_URL: this.cfg.hub, WISP_TOKEN: token, WISP_RUN: runId, WISP_BROWSER_CMD: JSON.stringify(direct), WISP_BROWSER_TOOLS: path.join(this.cfg.dir, "computers", `browser-tools-${recipeTag()}.json`) },
    };
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

/** Each VM harness's folder in the VM's home (where its settings are, for a connection's own folder to copy). */
const VM_HARNESS_DIR: Record<string, string> = { "claude-code": ".claude", codex: ".codex", hermes: ".hermes", kimi: ".kimi-code" };

function safeId(id: string): string {
  return id.replace(/[^\w-]/g, "");
}

/** A VM's files, as the credential code writes them (as the VM's user, private to it). */
function vmCredentialFs(vm: DockerVm): CredentialFs {
  return {
    join: (...p) => path.posix.join(...p),
    read: (f) => vm.readFile(f),
    write: (f, content, mode) => vm.writeFile(f, content, mode ? mode.toString(8) : "644"),
    link: (target, link) => vm.symlink(target, link),
  };
}

/** Reading what a harness left in a VM (Codex's session file). */
function vmPlace(vm: DockerVm): RunPlace {
  return { home: vm.home, readFile: (f) => vm.readFile(f), readDir: (d) => vm.readDir(d) };
}

/** Asking a VM's own harnesses what they offer. */
function vmCatalogPlace(vm: DockerVm): CatalogPlace {
  return {
    ...vmPlace(vm),
    exec: (command, args, opts) => vm.runCommand(command, args, opts?.timeout),
    // a long-running agent (ACP) starts in the VM's shared folder
    launch: (l) => vm.launcher(`catalog-${Date.now()}`)({ ...l, cwd: vm.filesDir }),
  };
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

/** Plain words for why a device couldn't ask the hub which agents it hosts. */
export function hubUnreachableMessage(device: string, hub: string, err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return `${device} isn't signed in to Wisp any more (${hub} turned it away). Pair it again from Computers, then ask again.`;
  if (typeof status === "number") return `${device} reached Wisp but it answered with an error (${status}: ${(err as Error).message}). Try again in a moment.`;
  return `${device} couldn't reach Wisp at ${hub}. Check that it's online and the Wisp hub is running, then try again.`;
}
