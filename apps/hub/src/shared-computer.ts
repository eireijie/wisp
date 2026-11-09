import type { Computer } from "@wisp/core";
import type { Hub } from "./hub.ts";
import type { Store } from "./store.ts";

/**
 * Where agents work by default (Simple): one Linux computer the workspace's agents share, so a site
 * signed into once is signed in for all of them and a file one saves the others can open. Its record
 * is made with the first agent; the computer itself is only made the first time an agent needs it,
 * and it stops when idle (computers.ts). Agents' AI tools run on the same device, beside it.
 */

/** The workspace's shared computer. */
export const SHARED_KEY = "computers.shared";
/** The device Wisp itself runs on (the hub's own computer, or the Cloud server). */
export const HOME_KEY = "devices.home";
/** "true": owners choose where each agent runs (Settings → Devices). Simple otherwise. */
export const ADVANCED_KEY = "computers.advanced";

export const SHARED_NAME = "Shared computer";
export const OFF_TEXT = "Off. It starts when it's needed.";

export function advancedOn(store: Store, workspaceId: string): boolean {
  return store.setting(workspaceId, ADVANCED_KEY) === "true";
}

/**
 * How big the shared computer is: a quarter of the device's memory, at least 1.5 GB and at most
 * 4 GB, so a small machine isn't swamped. Unknown memory: 2 GB.
 */
export function sharedSize(memoryGb: number | undefined): { cpus: number; memoryGb: number } {
  const mem = memoryGb && memoryGb > 0 ? Math.min(4, Math.max(1.5, Math.round((memoryGb / 4) * 2) / 2)) : 2;
  return { cpus: memoryGb && memoryGb <= 4 ? 1 : 2, memoryGb: mem };
}

const canRunVms = (store: Store, nodeId: string) => !!store.nodeCapabilities(nodeId)?.vm.ok;

/**
 * The device Wisp lives on: the one it registered for itself (`wisp service install node --local`,
 * and the Cloud server's device), else the oldest device of the workspace's first owner.
 */
export function homeDevice(store: Store, workspaceId: string): string | null {
  const nodes = store.nodes(workspaceId);
  const saved = store.setting(workspaceId, HOME_KEY);
  if (saved && nodes.some((n) => n.id === saved)) return saved;
  const owners = new Set(store.members(workspaceId).filter((m) => m.role === "owner").map((m) => m.id));
  const oldest = [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (oldest.find((n) => n.ownerId && owners.has(n.ownerId)) ?? oldest[0])?.id ?? null;
}

/**
 * Where the shared computer goes: the home device if it can run VMs, else the oldest owner's
 * device that can. Null while no device can (an engine still installing, say).
 */
function sharedHost(store: Store, workspaceId: string): string | null {
  const home = homeDevice(store, workspaceId);
  if (home && canRunVms(store, home)) return home;
  const owners = new Set(store.members(workspaceId).filter((m) => m.role === "owner").map((m) => m.id));
  const nodes = [...store.nodes(workspaceId)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return nodes.find((n) => (!n.ownerId || owners.has(n.ownerId)) && canRunVms(store, n.id))?.id ?? null;
}

/** The shared computer, made (as a record only, off) when `create` and a device can run it. */
export function sharedComputer(hub: Hub, workspaceId: string, create = true): Computer | null {
  const { store } = hub;
  const id = store.setting(workspaceId, SHARED_KEY);
  const known = id ? store.computer(id) : undefined;
  if (known && known.kind === "vm" && known.workspaceId === workspaceId) return known;
  if (!create) return null;
  const nodeId = sharedHost(store, workspaceId);
  if (!nodeId) return null;
  const size = sharedSize(store.nodeCapabilities(nodeId)?.memoryGb);
  const c = store.createComputer({ workspaceId, name: SHARED_NAME, kind: "vm", nodeId, config: { ...size, shared: true }, status: "stopped" });
  store.updateComputer(c.id, { statusText: OFF_TEXT });
  store.setSetting(workspaceId, SHARED_KEY, c.id);
  hub.computers.changed(c.id);
  return store.computer(c.id)!;
}

/**
 * Where a new agent of an owner's works, in Simple: on the shared computer, with its AI tool on the
 * same device (beside the computer, so chat never waits for it). Before any device can run a
 * computer: on the home device, with none yet (adoptShared gives it one later).
 */
export function simplePlacement(hub: Hub, workspaceId: string): { nodeId: string | null; computerId: string | null; waits: boolean } {
  const shared = sharedComputer(hub, workspaceId);
  return shared ? { nodeId: shared.nodeId, computerId: shared.id, waits: false } : { nodeId: homeDevice(hub.store, workspaceId), computerId: null, waits: true };
}

/** Set once an organization's agents from before the shared computer were moved onto it. */
const ADOPTED_KEY = "computers.sharedAdopted";

/**
 * Agents waiting for the shared computer get it, beside it: ones made in Simple before any device
 * could run a computer, and once, on upgrading, an owner's agents from before that have none (and
 * weren't set to work without one). Nothing else moves: agents with their own computer keep it,
 * and agents on a person's own screen keep that. Safe to run again (on start, when a device can
 * newly run VMs, and on going back to Simple). Returns the agents it moved.
 */
export function adoptShared(hub: Hub, workspaceId: string): string[] {
  const { store } = hub;
  if (advancedOn(store, workspaceId)) return [];
  const upgrading = store.setting(workspaceId, ADOPTED_KEY) !== "true";
  const owners = new Set(store.members(workspaceId).filter((m) => m.role === "owner").map((m) => m.id));
  const waiting = store.agents(workspaceId).filter((a) => !a.computerId && !a.settings.headless && (a.settings.waitsForShared || (upgrading && (!a.settings.createdBy || owners.has(a.settings.createdBy)))));
  if (!waiting.length) {
    if (upgrading) store.setSetting(workspaceId, ADOPTED_KEY, "true");
    return [];
  }
  const shared = sharedComputer(hub, workspaceId);
  if (!shared) return [];
  store.setSetting(workspaceId, ADOPTED_KEY, "true");
  const moved: string[] = [];
  for (const a of waiting) {
    // an agent's AI tool stays where it was signed in; it only gets the computer when that's the same
    // device (one connected from outside, with no device, keeps working as it does)
    if (a.nodeId !== shared.nodeId) continue;
    store.updateAgent(a.id, { nodeId: shared.nodeId, computerId: shared.id, settings: { ...a.settings, waitsForShared: undefined } });
    moved.push(a.id);
  }
  if (moved.length) hub.broadcast(workspaceId, { type: "agents_changed" });
  return moved;
}

/**
 * Agents that already work on a person's own screen keep it, and count as allowed there ("tell"),
 * so its Computer page shows it under Use my computers. Safe to run again.
 */
export function keepDeviceScreens(hub: Hub, workspaceId: string): string[] {
  const { store } = hub;
  const kept: string[] = [];
  for (const a of store.agents(workspaceId)) {
    const c = a.computerId ? store.computer(a.computerId) : undefined;
    if (c?.kind !== "device" || !c.nodeId || a.settings.useDevices?.[c.nodeId]) continue;
    store.updateAgent(a.id, { settings: { ...a.settings, useDevices: { ...(a.settings.useDevices ?? {}), [c.nodeId]: "tell" } } });
    kept.push(a.id);
  }
  return kept;
}
