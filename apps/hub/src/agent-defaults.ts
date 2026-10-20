import type { Store } from "./store.ts";

/** What "Use my defaults" in New agent fills in: a harness, a model, the device it runs on, and whether it gets its own VM. */
export interface AgentDefaults {
  harness: string | null;
  model: string | null;
  computer: "own-vm" | "none";
  nodeId: string | null;
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

export function saveAgentDefaults(store: Store, workspaceId: string, patch: Partial<AgentDefaults>) {
  const next = { ...savedAgentDefaults(store, workspaceId), ...patch };
  store.setSetting(workspaceId, KEY, JSON.stringify(next));
}

/**
 * The defaults for a new agent: what the owner saved, and for anything not saved, what the most
 * recently made agent uses (else the first harness a device offers), on a device that can run VMs.
 */
export function agentDefaults(store: Store, workspaceId: string): AgentDefaults {
  const saved = savedAgentDefaults(store, workspaceId);
  const nodes = store.nodes(workspaceId);
  const known = (nodeId: string | null | undefined) => !!nodeId && nodes.some((n) => n.id === nodeId);
  const canRunVms = (nodeId: string) => !!store.nodeCapabilities(nodeId)?.vm.ok;
  const latest = store.agents(workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const nodeId = known(saved.nodeId) ? saved.nodeId! : known(latest?.nodeId) ? latest!.nodeId! : (nodes.find((n) => canRunVms(n.id)) ?? nodes[0])?.id ?? null;
  const offered = [...(nodeId ? [nodeId] : []), ...nodes.map((n) => n.id)].flatMap((id) => store.nodeCatalog(id));
  const harness = saved.harness !== undefined ? saved.harness : (latest?.harness ?? offered[0]?.harness ?? null);
  const model = saved.model !== undefined ? saved.model : latest && latest.harness === harness ? latest.model : null;
  const computer = saved.computer ?? (nodes.some((n) => canRunVms(n.id)) ? "own-vm" : "none");
  return { harness, model, computer, nodeId };
}
