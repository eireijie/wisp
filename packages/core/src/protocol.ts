import { z } from "zod";
import { ComputerAction, DeviceCapabilities } from "./computers.ts";
import { ConnectorSpec } from "./connectors.ts";
import { HarnessAccountOp, HarnessSettingsChange } from "./harness-settings.ts";
import { ConnectionSecret, ModelProviderId, PlanUsage, RunCredential } from "./models.ts";
import { ShelfItem } from "./shop.ts";

/**
 * Hub <-> node wire protocol. Nodes dial out to the hub over WebSocket and
 * authenticate with a node token, so they work behind NAT.
 */

export const MAX_MODEL_ID_LENGTH = 200;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_call"), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), name: z.string(), output: z.unknown() }),
  z.object({ type: z.literal("status"), text: z.string() }),
  /** something people should know about the run, kept with the reply ("connector X didn't start") */
  z.object({ type: z.literal("notice"), text: z.string().max(2000) }),
  z.object({ type: z.literal("error"), message: z.string() }),
  /** what a run actually used: reported by the harness once the reply is done */
  z.object({
    type: z.literal("usage"),
    model: z.string().max(MAX_MODEL_ID_LENGTH).optional(),
    effort: z.string().max(32).nullable().optional(),
    /** tokens in the conversation's context after this reply */
    contextUsed: z.number().int().nonnegative().optional(),
    /** usable context window for that model */
    contextWindow: z.number().int().positive().optional(),
    /** tokens the whole run read, cached ones included (what a bill counts); only where the harness reports it */
    inputTokens: z.number().int().nonnegative().optional(),
    /** tokens the whole run wrote, reasoning included */
    outputTokens: z.number().int().nonnegative().optional(),
    /** the part of `inputTokens` that came from the harness's cache */
    cachedInputTokens: z.number().int().nonnegative().optional(),
    /** how much of the subscription's limit is used, where the harness reports it (models.ts) */
    plan: PlanUsage.optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const HarnessCatalogSchema = z.object({
  harness: z.string(),
  version: z.string().nullable(),
  models: z
    .array(
      z.object({
        id: z.string().max(MAX_MODEL_ID_LENGTH),
        label: z.string(),
        description: z.string().optional(),
        efforts: z.array(z.string()).optional(),
        defaultEffort: z.string().optional(),
        contextWindow: z.number().int().positive().optional(),
        fast: z.object({ description: z.string().max(200).optional() }).optional(),
      }),
    )
    .max(200),
  efforts: z.array(z.string()),
  /** whether each of its accounts is signed in where it runs (account id → true, false, or null when it can't tell) */
  accounts: z.record(z.string().max(64), z.boolean().nullable()).optional(),
  /** agents that use an account other than the default one (agent id → account id) */
  agentAccounts: z.record(z.string().max(64), z.string().max(64)).optional(),
  defaultModel: z.string().max(MAX_MODEL_ID_LENGTH).optional(),
  defaultEffort: z.string().optional(),
  commands: z
    .array(
      z.object({
        name: z.string().max(120),
        description: z.string().max(300).optional(),
        hint: z.string().max(120).optional(),
        kind: z.enum(["command", "skill"]),
        via: z.enum(["raw", "prompt"]),
        builtIn: z.boolean().optional(),
      }),
    )
    .max(500)
    .optional(),
});

/** Where a coding run works: its own checkout of a team repo, on the task's branch. */
export const RunWorkspace = z.object({
  /** git URL, or a path to a repo on the device */
  repo: z.string(),
  branch: z.string(),
  base: z.string(),
  /** "work": a checkout of the branch to commit on; "review": a read-only (detached) checkout of it */
  mode: z.enum(["work", "review"]),
});
export type RunWorkspace = z.infer<typeof RunWorkspace>;

/** What a device needs to know about a computer it runs (its screen, or a VM it hosts). */
export const ComputerSpec = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["device", "vm"]),
  config: z.record(z.unknown()),
});
export type ComputerSpec = z.infer<typeof ComputerSpec>;

/** An agent identity that already exists on a device (a Hermes profile, OpenClaw workspace, Claude Code subagent). */
export const DiscoveredAgent = z.object({
  /** unique on the device, e.g. "hermes:default" */
  key: z.string().max(200),
  harness: z.string().max(60),
  name: z.string().max(120),
  description: z.string().max(2000).optional(),
  model: z.string().max(MAX_MODEL_ID_LENGTH).optional(),
  soul: z.string().max(50_000).optional(),
  instructions: z.string().max(50_000).optional(),
  /** notes it kept (MEMORY.md, USER.md, memory/*.md) */
  memories: z.array(z.object({ name: z.string().max(200), content: z.string().max(100_000) })).max(50).optional(),
  /** where it came from, for people to recognize it */
  path: z.string().max(1000),
  /** in the list a device reports (contents come only when someone imports it) */
  hasSoul: z.boolean().optional(),
  memoryCount: z.number().int().optional(),
});
export type DiscoveredAgent = z.infer<typeof DiscoveredAgent>;

export const RunRequest = z.object({
  runId: z.string(),
  agentId: z.string(),
  channelId: z.string(),
  threadId: z.string().nullable(),
  prompt: z.string(),
  hop: z.number().int(),
  /** start a new harness session instead of continuing this conversation's (background checks) */
  fresh: z.boolean().optional(),
  /** the chat this run answers in (a new one after a quiet break): its harness session is that chat's own */
  conversation: z.string().max(64).optional(),
  /** run on this model instead of the agent's own (background checks) */
  model: z.string().max(MAX_MODEL_ID_LENGTH).optional(),
  /** and with this reasoning effort */
  effort: z.string().max(32).optional(),
  workspace: RunWorkspace.optional(),
  /** the agent's computer when this device runs it (a VM shares a folder with the agent) */
  computer: ComputerSpec.optional(),
  /** run the harness inside `computer` (a VM) rather than on the device */
  inComputer: z.boolean().optional(),
  /** the agent's enabled connectors (MCP servers and secrets), resolved */
  connectors: z.array(ConnectorSpec).max(100).optional(),
  /**
   * The model connection the agent runs on (models.ts), when it has one its harness can use. The
   * device puts it where the harness reads it, for this run only; without it the harness uses the
   * device's (or VM's) own login, as before. Devices from before connections ignore it.
   */
  credential: RunCredential.optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

/** A model sign-in running on a device (POST /api/model-connections/login), as people see it. */
export const ModelLogin = z.object({
  id: z.string().max(64),
  provider: ModelProviderId,
  harness: z.string().max(60),
  status: z.enum(["running", "done", "failed"]),
  /** the page to open */
  url: z.string().max(2000).optional(),
  /** the one-time code to enter there (device sign-ins); sign-ins that show a code on the page instead take it through input */
  code: z.string().max(100).optional(),
  /** whether it waits for a code pasted back from the page (Claude's sign-in) */
  wantsInput: z.boolean().optional(),
  output: z.string().max(4000),
  error: z.string().max(1000).optional(),
  /** the connection it made, once done */
  connectionId: z.string().max(64).optional(),
});
export type ModelLogin = z.infer<typeof ModelLogin>;

/** node -> hub */
export const NodeToHub = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    nodeName: z.string(),
    agents: z.array(z.string()),
    /** the Wisp version this device runs (missing from devices older than updates) */
    version: z.object({ commit: z.string().nullable(), date: z.string().nullable() }).optional(),
  }),
  /**
   * Models each installed harness offers on this device; sent after hello because it can take a few
   * seconds. With `computerId`, the harnesses installed inside that VM instead (what agents running in it use).
   */
  z.object({ type: z.literal("catalog"), catalog: z.array(HarnessCatalogSchema).max(50), computerId: z.string().max(100).optional() }),
  /**
   * A run's sign-in was renewed by its harness (Codex and Hermes rotate ChatGPT's refresh token):
   * the hub keeps the new one, so the next run anywhere doesn't use the old, now dead one.
   */
  z.object({ type: z.literal("credential_refreshed"), connectionId: z.string().max(64), runId: z.string().max(64).optional(), terminal: z.boolean().optional(), secret: ConnectionSecret }),
  /** how a model sign-in this device runs is going (the link and code to show); never the secret */
  z.object({ type: z.literal("model_login"), login: ModelLogin }),
  /** a model sign-in finished: on success, what the hub keeps as the new connection */
  z.object({ type: z.literal("model_login_done"), loginId: z.string().max(64), ok: z.boolean(), secret: ConnectionSecret.optional(), account: z.string().max(200).nullable().optional(), plan: z.string().max(40).nullable().optional(), error: z.string().max(1000).optional() }),
  z.object({ type: z.literal("run_event"), runId: z.string(), event: AgentEvent }),
  z.object({ type: z.literal("run_done"), runId: z.string(), finalText: z.string() }),
  z.object({ type: z.literal("run_failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("git_done"), requestId: z.string(), ok: z.boolean(), output: z.string() }),
  /** what this device can offer as computers */
  z.object({ type: z.literal("capabilities"), capabilities: DeviceCapabilities }),
  /** the answer to a request the hub made (a computer action, reading an agent to import) */
  z.object({ type: z.literal("result"), requestId: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
  /** a computer this device runs changed state (a VM building, starting, failing) */
  z.object({ type: z.literal("computer_status"), computerId: z.string(), status: z.enum(["ready", "starting", "stopped", "error"]), text: z.string().max(1000) }),
  /** a frame of a watched screen (base64 JPEG) */
  z.object({ type: z.literal("screen_frame"), computerId: z.string(), image: z.string(), width: z.number().int(), height: z.number().int() }),
  z.object({ type: z.literal("tunnel_ready"), tunnelId: z.string() }),
  z.object({ type: z.literal("tunnel_closed"), tunnelId: z.string(), error: z.string().optional() }),
  /** a terminal is showing (`resumed`: it was already running, and its recent screen follows) */
  z.object({ type: z.literal("term_ready"), termId: z.string(), resumed: z.boolean() }),
  /** a terminal stopped showing; `exited`: its shell ended (otherwise it may still be running) */
  z.object({ type: z.literal("term_closed"), termId: z.string(), error: z.string().max(500).optional(), exited: z.boolean().optional() }),
  /** something about the screen's code its owner should hear about (wrong codes, a lockout) */
  z.object({ type: z.literal("screen_event"), text: z.string().max(500), alert: z.boolean().optional() }),
  /** agents that already exist on this device and could be brought into Wisp */
  z.object({ type: z.literal("discovered"), agents: z.array(DiscoveredAgent).max(100) }),
  /** skills and MCP servers this device's harnesses already have (secret values stay on the device) */
  z.object({ type: z.literal("shelf"), items: z.array(ShelfItem).max(1000) }),
]);
export type NodeToHub = z.infer<typeof NodeToHub>;

/** hub -> node */
export const HubToNode = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), nodeId: z.string() }),
  z.object({ type: z.literal("run"), run: RunRequest }),
  z.object({ type: z.literal("cancel"), runId: z.string() }),
  /** merge a task branch into the base branch, in the device's checkout of the repo */
  z.object({ type: z.literal("merge"), requestId: z.string(), agentId: z.string(), repo: z.string(), branch: z.string(), base: z.string() }),
  /** Code's review side: a task branch's diff, its files or one file, or its checks; answered with git_done (JSON in output) */
  z.object({ type: z.literal("review"), requestId: z.string(), what: z.enum(["diff", "files", "file", "checks"]), repo: z.string(), branch: z.string(), base: z.string(), file: z.string().max(1000).optional() }),
  /** do something on a computer this device runs */
  /** `agentId`: the agent doing it, so a device can let agents whose harness runs on it use its screen */
  z.object({ type: z.literal("computer"), requestId: z.string(), computer: ComputerSpec, action: ComputerAction, agentId: z.string().optional() }),
  /** start or stop streaming a computer's screen to people watching it */
  z.object({ type: z.literal("screen_watch"), computer: ComputerSpec, on: z.boolean(), fps: z.number().min(0.2).max(10).optional() }),
  /** relay a computer's VNC server: binary frames carry the bytes (see tunnelFrame) */
  z.object({ type: z.literal("tunnel_open"), tunnelId: z.string(), computer: ComputerSpec, code: z.string().max(200).optional() }),
  /**
   * Open the device's own screen for `purpose` (a viewer) until `until`, if `code` is
   * the one picked at the device; answered with a result ({ until }). The device checks the code and
   * keeps the time limit itself, so the hub never holds the code.
   */
  z.object({ type: z.literal("screen_unlock"), requestId: z.string(), purpose: z.string().max(100), code: z.string().max(200), until: z.string() }),
  /** close the screen again for `purpose` (the viewer left) */
  z.object({ type: z.literal("screen_lock"), purpose: z.string().max(100) }),
  z.object({ type: z.literal("tunnel_close"), tunnelId: z.string() }),
  /**
   * The Code mod's terminals, a shell on a computer this device runs: open (or reattach to) the shell
   * named `session` there; keys and screen bytes travel as binary frames with `termId` (see tunnelFrame).
   * A device's own screen asks for its code, as live view does.
   */
  z.object({
    type: z.literal("term_open"),
    termId: z.string(),
    computer: ComputerSpec,
    session: z.string().max(60),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(500),
    code: z.string().max(200).optional(),
    /** a harness's CLI to start in a plain shell (an id from HARNESSES) */
    launch: z.string().max(40).optional(),
    /** the model sign-in that CLI uses */
    credential: RunCredential.optional(),
    /** the owner took the keyboard: the shell is this agent's own harness session for that thread, resumed */
    takeover: z.object({ agentId: z.string(), channelId: z.string(), threadId: z.string().nullable() }).optional(),
  }),
  z.object({ type: z.literal("term_resize"), termId: z.string(), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) }),
  /** stop showing it; `end`: the pane was closed, so the shell stops too */
  z.object({ type: z.literal("term_close"), termId: z.string(), end: z.boolean().optional() }),
  /** look again for agents that already exist on this device */
  z.object({ type: z.literal("discover") }),
  /** check again what this device has: harnesses and their models, its screen and VM support, agents to import */
  z.object({ type: z.literal("refresh") }),
  /** install a harness with the device's own recipe (npm only); answered with a result */
  z.object({ type: z.literal("install_harness"), requestId: z.string(), harness: z.string().max(60) }),
  /** send everything about one discovered agent (its soul, instructions and notes), to import it */
  z.object({ type: z.literal("read_agent"), requestId: z.string(), key: z.string() }),
  /** update this device's copy of Wisp from GitHub and restart; answered with a result (UpdateResult) */
  z.object({ type: z.literal("update"), requestId: z.string() }),
  /** read the harnesses' own settings (all of them, or one); answered with a result (HarnessSettings[]) */
  z.object({ type: z.literal("harness_settings"), requestId: z.string(), harness: z.string().max(60).optional(), account: z.string().max(64).optional() }),
  /** change a harness's own settings; the device edits its config file and answers with a result (HarnessSettings) */
  z.object({ type: z.literal("harness_settings_change"), requestId: z.string(), harness: z.string().max(60), account: z.string().max(64).optional(), changes: z.array(HarnessSettingsChange).min(1).max(20) }),
  /** add, rename, remove or sign in a harness's accounts, or pick which one an agent uses; answered with a result */
  z.object({ type: z.literal("harness_account"), requestId: z.string(), harness: z.string().max(60), action: HarnessAccountOp }),
  /** send one of a harness's skills (its SKILL.md) to share it; answered with a result (HarnessSkillFile) */
  z.object({ type: z.literal("harness_skill"), requestId: z.string(), harness: z.string().max(60), account: z.string().max(64).optional(), id: z.string().max(300) }),
  /**
   * Sign in to a model provider with a harness on this device, in a scratch folder, so the hub can
   * keep the sign-in (models.ts). "start" answers with a result (ModelLogin); progress arrives as
   * model_login messages and the end as model_login_done. "input" types a pasted code into it.
   */
  z.object({ type: z.literal("model_login"), requestId: z.string(), op: z.enum(["start", "input", "cancel"]), loginId: z.string().max(64), provider: ModelProviderId.optional(), harness: z.enum(["claude-code", "codex", "hermes"]).optional(), text: z.string().max(2000).optional() }),
  /** report the harnesses (and their models) installed inside this VM; answered with a catalog message */
  z.object({ type: z.literal("computer_catalog"), computer: ComputerSpec }),
  /** the model connections this device may keep folders for; any other's sign-ins and keys are removed, here and in these VMs */
  z.object({ type: z.literal("connections_keep"), connectionIds: z.array(z.string()), computers: z.array(ComputerSpec) }),
  /** open a harness's config file in the device's own editor; answered with a result ({ path }) */
  z.object({ type: z.literal("harness_open_config"), requestId: z.string(), harness: z.string().max(60), account: z.string().max(64).optional() }),
]);
export type HubToNode = z.infer<typeof HubToNode>;

/** hub -> browser clients */
export interface JoinRequestView {
  id: string;
  name: string;
  kind: "computer";
  platform: string;
  code: string;
  createdAt: string;
}

export type ClientEvent =
  | { type: "join_request"; request: JoinRequestView }
  | { type: "join_request_done"; id: string }
  | { type: "message"; message: import("./types.ts").Message }
  /** an edited message, or a deleted thread root kept for its replies */
  | { type: "message_updated"; message: import("./types.ts").Message }
  /** a deleted message, or a system notice that no longer applies (the "queued until its device reconnects" line once the run starts) */
  | { type: "message_removed"; messageId: string; channelId: string; threadId: string | null }
  | { type: "agent_status"; agentId: string; status: "online" | "busy" | "offline" }
  /** someone took an agent's keyboard (its runs wait), or handed it back (userId null) */
  | { type: "keyboard"; agentId: string; userId: string | null }
  /**
   * An agent's run event. `threadId` is the thread it works in (null at the top of the channel) and
   * `threadPath` every thread above it, outermost first, so a parent thread can show who's working in its sub-threads.
   */
  | { type: "run_event"; runId: string; agentId: string; channelId: string; threadId?: string | null; threadPath?: string[]; event: AgentEvent }
  | { type: "reactions"; messageId: string; channelId: string; threadId: string | null; reactions: import("./types.ts").Reaction[] }
  | { type: "sections_changed" }
  | { type: "channels_changed" }
  | { type: "agents_changed" }
  | { type: "lead_changed" }
  | { type: "discussion"; discussion: import("./types.ts").Discussion }
  | { type: "computer"; computer: import("./computers.ts").Computer }
  | { type: "computer_removed"; computerId: string }
  | { type: "approval"; approval: import("./types.ts").Approval }
  | { type: "routines_changed" }
  /** skills or connectors were added, changed, removed, given to agents, learned or used; refetch GET /api/skills (and /api/connectors) */
  | { type: "skills_changed" }
  | { type: "background_changed"; agentId: string }
  /** a watch on someone's app was added, changed or stopped; refetch GET /api/watches */
  | { type: "watches_changed" }
  /** an agent changed a setting or mod for someone, or someone undid one */
  | { type: "changes_changed" }
  | { type: "tasks_changed" }
  /** a stepped team's request moved on (team-flow.ts) */
  | { type: "flows_changed"; channelId: string }
  /** notes were changed outside Wisp (Obsidian, a git pull or push) */
  | { type: "memory_changed" }
  /** someone's model connections changed (added, removed, renamed, plan usage); refetch GET /api/model-connections */
  | { type: "model_connections_changed" }
  /** a model sign-in moved on (sent to the person who started it only) */
  | { type: "model_login"; login: ModelLogin }
  /** an owner switched optional features on or off (Settings → General → Mods) */
  | { type: "features"; features: import("./features.ts").Features };

/** Terminal ids start with this, so a binary frame goes to the right place. */
export const TERM_PREFIX = "term_";

/**
 * Tunnel bytes travel as binary WebSocket frames: one byte with the tunnel id's length, the id,
 * then the payload. JSON messages stay text frames.
 */
export function tunnelFrame(tunnelId: string, payload: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(tunnelId);
  const out = new Uint8Array(1 + id.length + payload.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(payload, 1 + id.length);
  return out;
}

export function readTunnelFrame(frame: Uint8Array): { tunnelId: string; payload: Uint8Array } | null {
  if (frame.length < 1 || frame.length < 1 + frame[0]) return null;
  return { tunnelId: new TextDecoder().decode(frame.subarray(1, 1 + frame[0])), payload: frame.subarray(1 + frame[0]) };
}
