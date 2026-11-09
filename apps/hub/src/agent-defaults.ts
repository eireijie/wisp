import type { Store } from "./store.ts";

/**
 * What "Use my defaults" in New agent fills in: a harness, a model, the device it runs on, and its
 * computer: the shared one (the default), its own VM, or none. In Simple (shared-computer.ts) an
 * owner's agents always get the shared one and members' agents their own; the choice is Advanced's.
 */
export interface AgentDefaults {
  harness: string | null;
  model: string | null;
  computer: "shared" | "own-vm" | "none";
  nodeId: string | null;
  /** A default model for each AI tool (harness id to model id); a tool left out uses `model` when it is the default tool, else its own default. */
  models: Record<string, string>;
}

const KEY = "agents.defaults";

/** What an owner saved in Settings, as it was stored (fields left out aren't chosen). */
export function savedAgentDefaults(store: Store, workspaceId: string): Partial<AgentDefaults> {
  try {
    const v = JSON.parse(store.setting(workspaceId, KEY) ?? "null");
    return v && typeof v === "object" ? (v as Partial<AgentDefaults>) : {};
  } catch {
    return {};
  }
}

export function saveAgentDefaults(store: Store, workspaceId: string, patch: Partial<Omit<AgentDefaults, "models">> & { models?: Record<string, string | null> }) {
  const saved = savedAgentDefaults(store, workspaceId);
  const { models: change, ...rest } = patch;
  const models = { ...(saved.models ?? {}) };
  for (const [harness, model] of Object.entries(change ?? {})) {
    if (model) models[harness] = model;
    else delete models[harness];
  }
  const next = { ...saved, ...rest, ...(change ? { models } : {}) };
  store.setSetting(workspaceId, KEY, JSON.stringify(next));
}

/**
 * The defaults for a new agent: what the owner saved, and for anything not saved, what the most
 * recently made agent uses (else the first signed-in harness a device offers), on a device that can run VMs.
 */
export function agentDefaults(store: Store, workspaceId: string): AgentDefaults {
  const saved = savedAgentDefaults(store, workspaceId);
  const nodes = store.nodes(workspaceId);
  const known = (nodeId: string | null | undefined) => !!nodeId && nodes.some((n) => n.id === nodeId);
  const canRunVms = (nodeId: string) => !!store.nodeCapabilities(nodeId)?.vm.ok;
  const latest = store.agents(workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const nodeId = known(saved.nodeId) ? saved.nodeId! : known(latest?.nodeId) ? latest!.nodeId! : (nodes.find((n) => canRunVms(n.id)) ?? nodes[0])?.id ?? null;
  const offered = [...(nodeId ? [nodeId] : []), ...nodes.map((n) => n.id)].flatMap((id) => store.nodeCatalog(id));
  // a tool that's signed in beats one that would fail its first run; "can't tell" beats "signed out"
  const readiness = (accounts: Record<string, boolean | null> | undefined) => (Object.values(accounts ?? {}).some((v) => v === true) ? 0 : Object.values(accounts ?? {}).some((v) => v === false) ? 2 : 1);
  const firstOffered = [...offered].sort((a, b) => readiness(a.accounts) - readiness(b.accounts))[0];
  const harness = saved.harness !== undefined ? saved.harness : (latest?.harness ?? firstOffered?.harness ?? null);
  const model = saved.model !== undefined ? saved.model : latest && latest.harness === harness ? latest.model : null;
  const computer = saved.computer ?? "shared";
  return { harness, model, computer, nodeId, models: saved.models ?? {} };
}
