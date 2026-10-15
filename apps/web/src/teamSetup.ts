import { HARNESSES, type Agent, type TeamTemplate } from "@warren/core";
import type { DeviceInfo } from "./devices.ts";
import { usableDevices } from "./devices.ts";

/** One role while setting up a team: what it's called, what it owns, and who fills it. */
export interface Slot {
  key: string;
  role: string;
  notes: string;
  lead: boolean;
  /** an existing agent's id, or "new" to create one */
  pick: string;
  /** for a new agent */
  harness: string;
  /** for a new agent */
  name: string;
  /** the harness the template suggested, to mark it in the picker */
  suggested: string | null;
}

let counter = 0;
const key = () => `slot-${++counter}`;

/** Harnesses a new agent can be created on from here: ones that run on a device. */
export const NEW_AGENT_HARNESSES = HARNESSES.filter((h) => h.protocol !== "mcp");

/**
 * The roles of a template (or none, for a blank team), each filled by an agent you already have
 * on its suggested harness if there is one, else by a new agent. Nobody fills two roles. A new
 * agent starts on the suggested harness only if a device has it; otherwise the person picks.
 */
export function slotsFor(template: TeamTemplate | null, agents: Pick<Agent, "id" | "harness">[], devices: DeviceInfo[] | null = null): Slot[] {
  const used = new Set<string>();
  return (template?.roles ?? []).map((r) => {
    const existing = agents.find((a) => a.harness === r.harness && !used.has(a.id));
    if (existing) used.add(existing.id);
    return { key: key(), role: r.role, notes: r.notes, lead: !!r.lead, pick: existing?.id ?? "new", harness: !devices || installedOn(r.harness, devices) ? r.harness : "", name: "", suggested: r.harness };
  });
}

/** A role to fill in by hand. */
export function blankSlot(): Slot {
  return { key: key(), role: "", notes: "", lead: false, pick: "new", harness: "", name: "", suggested: null };
}

/** What's wrong with the setup, in words for the person; null when it's ready to create. */
export function slotProblem(slots: Slot[], canCreate: boolean): string | null {
  if (!slots.length) return null;
  if (slots.some((s) => !s.role.trim())) return "Every role needs a name.";
  const picked = slots.filter((s) => s.pick !== "new").map((s) => s.pick);
  if (new Set(picked).size !== picked.length) return "An agent can fill only one role here. Pick a different agent, or make a new one.";
  if (slots.some((s) => s.pick === "new" && !s.harness)) return "Pick a harness for each new agent.";
  if (!canCreate && slots.some((s) => s.pick === "new")) return "Connect a device first to make new agents, or pick agents you already have.";
  return null;
}

/** Exactly one lead: the one marked, else the first role. */
export function withLead(slots: Slot[]): Slot[] {
  const lead = slots.findIndex((s) => s.lead);
  return slots.map((s, i) => ({ ...s, lead: i === (lead < 0 ? 0 : lead) }));
}

/** Where a new agent on this harness should run: an online device that has it, else any online device. */
export function deviceFor(harness: string, devices: DeviceInfo[]): DeviceInfo | undefined {
  const usable = usableDevices(devices);
  return usable.find((d) => d.online && d.harnesses?.some((h) => h.id === harness)) ?? usable.find((d) => d.online) ?? usable[0];
}

/** Is the harness on one of the devices new agents can go on? */
export function installedOn(harness: string, devices: DeviceInfo[]): boolean {
  return usableDevices(devices).some((d) => d.harnesses?.some((h) => h.id === harness));
}

/** "(not installed on box)" when no device has the harness; null when it's fine or no device is connected. */
export function harnessNote(harness: string, devices: DeviceInfo[]): string | null {
  const device = deviceFor(harness, devices);
  return device && !installedOn(harness, devices) ? `(not installed on ${device.name})` : null;
}
