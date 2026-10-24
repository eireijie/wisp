import { z } from "zod";
import { ComputerAction, DeviceCapabilities } from "./computers.ts";
import { ConnectorSpec } from "./connectors.ts";
import { HarnessAccountOp, HarnessSettingsChange } from "./harness-settings.ts";
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
});
export type RunRequest = z.infer<typeof RunRequest>;

/** node -> hub */
export const NodeToHub = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    nodeName: z.string(),
    agents: z.array(z.string()),
    /** the Warren version this device runs (missing from devices older than updates) */
    version: z.object({ commit: z.string().nullable(), date: z.string().nullable() }).optional(),
  }),
  /** models each installed harness offers on this device; sent after hello because it can take a few seconds */
  z.object({ type: z.literal("catalog"), catalog: z.array(HarnessCatalogSchema).max(50) }),
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
  /** something about the screen's code its owner should hear about (wrong codes, a lockout) */
  z.object({ type: z.literal("screen_event"), text: z.string().max(500), alert: z.boolean().optional() }),
  /** agents that already exist on this device and could be brought into Warren */
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
  /** do something on a computer this device runs */
  z.object({ type: z.literal("computer"), requestId: z.string(), computer: ComputerSpec, action: ComputerAction }),
  /** start or stop streaming a computer's screen to people watching it */
  z.object({ type: z.literal("screen_watch"), computer: ComputerSpec, on: z.boolean(), fps: z.number().min(0.2).max(10).optional() }),
  /** relay a computer's VNC server: binary frames carry the bytes (see tunnelFrame) */
  z.object({ type: z.literal("tunnel_open"), tunnelId: z.string(), computer: ComputerSpec, code: z.string().max(200).optional() }),
  /**
   * Open the device's own screen for `purpose` (a viewer, a lend, a loan) until `until`, if `code` is
   * the one picked at the device; answered with a result ({ until }). The device checks the code and
   * keeps the time limit itself, so the hub never holds the code.
   */
  z.object({ type: z.literal("screen_unlock"), requestId: z.string(), purpose: z.string().max(100), code: z.string().max(200), until: z.string() }),
  /** close the screen again for `purpose` (the viewer left, the lend or loan ended) */
  z.object({ type: z.literal("screen_lock"), purpose: z.string().max(100) }),
  z.object({ type: z.literal("tunnel_close"), tunnelId: z.string() }),
  /** look again for agents that already exist on this device */
  z.object({ type: z.literal("discover") }),
  /** check again what this device has: harnesses and their models, its screen and VM support, agents to import */
  z.object({ type: z.literal("refresh") }),
  /** install a harness with the device's own recipe (npm only); answered with a result */
  z.object({ type: z.literal("install_harness"), requestId: z.string(), harness: z.string().max(60) }),
  /** send everything about one discovered agent (its soul, instructions and notes), to import it */
  z.object({ type: z.literal("read_agent"), requestId: z.string(), key: z.string() }),
  /** update this device's copy of Warren from GitHub and restart; answered with a result (UpdateResult) */
  z.object({ type: z.literal("update"), requestId: z.string() }),
  /** read the harnesses' own settings (all of them, or one); answered with a result (HarnessSettings[]) */
  z.object({ type: z.literal("harness_settings"), requestId: z.string(), harness: z.string().max(60).optional(), account: z.string().max(64).optional() }),
  /** change a harness's own settings; the device edits its config file and answers with a result (HarnessSettings) */
  z.object({ type: z.literal("harness_settings_change"), requestId: z.string(), harness: z.string().max(60), account: z.string().max(64).optional(), changes: z.array(HarnessSettingsChange).min(1).max(20) }),
  /** add, rename, remove or sign in a harness's accounts, or pick which one an agent uses; answered with a result */
  z.object({ type: z.literal("harness_account"), requestId: z.string(), harness: z.string().max(60), action: HarnessAccountOp }),
  /** send one of a harness's skills (its SKILL.md) to share it; answered with a result (HarnessSkillFile) */
  z.object({ type: z.literal("harness_skill"), requestId: z.string(), harness: z.string().max(60), account: z.string().max(64).optional(), id: z.string().max(300) }),
  /** open a harness's config file in the device's own editor; answered with a result ({ path }) */
  z.object({ type: z.literal("harness_open_config"), requestId: z.string(), harness: z.string().max(60), account: z.string().max(64).optional() }),
]);
export type HubToNode = z.infer<typeof HubToNode>;

/** hub -> browser clients */
export type ClientEvent =
  | { type: "message"; message: import("./types.ts").Message }
  /** an edited message, or a deleted thread root kept for its replies */
  | { type: "message_updated"; message: import("./types.ts").Message }
  /** a deleted message, or a system notice that no longer applies (the "queued until its device reconnects" line once the run starts) */
  | { type: "message_removed"; messageId: string; channelId: string; threadId: string | null }
  | { type: "agent_status"; agentId: string; status: "online" | "busy" | "offline" }
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
  | { type: "background_changed"; agentId: string }
  /** an agent changed a setting or mod for someone, or someone undid one */
  | { type: "changes_changed" }
  | { type: "tasks_changed" }
  /** notes were changed outside Warren (Obsidian, a git pull or push) */
  | { type: "memory_changed" }
  /** an owner switched optional features on or off (Settings → General → Mods) */
  | { type: "features"; features: import("./features.ts").Features };

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
