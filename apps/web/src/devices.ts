import { useEffect, useState } from "react";
import type { Agent, DeviceCapabilities, DeviceRole, DiscoveredAgent, OwnRemoteDesktop } from "@wisp/core";
import { harnessInfo, harnessLabel, runsInVm } from "@wisp/core/src/harnesses.ts";
import { api } from "./api.ts";
import type { ComputerInfo } from "./store.ts";

/** A device as GET /api/nodes returns it. */
export interface DeviceInfo {
  id: string;
  name: string;
  /** the person who connected it */
  ownerId?: string | null;
  ownerName?: string | null;
  /** it's yours */
  mine?: boolean;
  /** its owner lets others put agents and VMs on it */
  shared?: boolean;
  /** what it does for agents: runs their VMs, lets agents that run on it use its screen, or neither (headless); null until chosen */
  role?: DeviceRole | null;
  /** paused at the device (`wisp node pause`) */
  paused?: boolean;
  online: boolean;
  lastSeen?: string | null;
  agents: string[];
  capabilities?: DeviceCapabilities | null;
  discovered?: DiscoveredAgent[];
  harnesses?: { id: string; version: string | null; accounts?: Record<string, boolean | null>; agentAccounts?: Record<string, string> }[];
  /** what's signed in inside each of its VMs (computer id → harness → signed in) */
  vmSignIns?: Record<string, Record<string, boolean | null>>;
  /** the Wisp version it runs */
  version?: { commit: string | null; date: string | null } | null;
  update?: { state: "idle" | "updating" | "restarting" | "failed"; message: string } | null;
  remoteDesktop?: OwnRemoteDesktop | null;
}

/** The devices list, refreshed every few seconds while mounted. */
export function useDevices(intervalMs = 5000): DeviceInfo[] | null {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<DeviceInfo[]>("GET", "/api/nodes").then((d) => alive && setDevices(d), () => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return devices;
}

const OS: Record<string, string> = { darwin: "Mac", win32: "Windows PC", linux: "Linux" };

export function osName(platform: string | undefined) {
  return (platform && OS[platform]) ?? "computer";
}

/** Is this the organization's shared computer (Simple)? */
export const isSharedComputer = (c: { config?: unknown } | null | undefined) => !!(c?.config as { shared?: boolean } | undefined)?.shared;

/**
 * Where an agent works, in a line. Simple says it plainly ("Shared computer", "Its own computer");
 * Advanced adds which device hosts it ("Shared computer · VM on box").
 */
export function computerSummary(c: Pick<ComputerInfo, "kind" | "nodeId" | "name"> & { config?: unknown }, devices: DeviceInfo[] | null, advanced: boolean): string {
  if (advanced) return `${c.name} · ${computerKindLabel(c, devices)}`;
  if (isSharedComputer(c)) return "Shared computer";
  if (c.kind === "vm") return "Its own computer";
  return computerKindLabel(c, devices);
}

/** "VM on box", "Your screen on my-laptop", "Orgo cloud computer". */
export function computerKindLabel(c: Pick<ComputerInfo, "kind" | "nodeId">, devices: DeviceInfo[] | null): string {
  const device = devices?.find((d) => d.id === c.nodeId)?.name ?? "a device";
  if (c.kind === "vm") return `VM on ${device}`;
  if (c.kind === "device") return `Your own screen on ${device}`;
  return "Orgo cloud computer";
}

/** Devices this person can put agents and VMs on: their own, and ones others shared. */
export function usableDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return devices.filter((d) => d.mine || d.shared);
}

/** The agents that run on a device, the one count every screen shows. */
export function agentsOnDevice<A extends { nodeId: string | null }>(agents: A[], deviceId: string): A[] {
  return agents.filter((a) => a.nodeId === deviceId);
}

/**
 * Who can really ask this agent: what the hub enforces, not just the saved choice. An agent running
 * directly on a private device answers only that device's owner until the owner opens it up.
 */
export function whoCanAsk(agent: Pick<Agent, "harness" | "settings" | "computerId">, device: { shared?: boolean } | undefined): "me" | "anyone" | "people" {
  const direct = !!device && !(runsInVm(agent.harness) && agent.settings?.runIn === "computer" && !!agent.computerId);
  if (direct && !agent.settings?.anyoneCanAsk && !device?.shared) return "me";
  return agent.settings?.respondTo ?? "anyone";
}

/** Is the agent's harness signed in where it runs? null when nobody can tell. Hub connections bring their own sign-in. */
export function agentSignedIn(agent: Pick<Agent, "id" | "harness" | "settings" | "computerId">, device: DeviceInfo): boolean | null {
  if (agent.settings?.connectionId) return true;
  if (runsInVm(agent.harness) && agent.settings?.runIn === "computer" && agent.computerId) return device.vmSignIns?.[agent.computerId]?.[agent.harness] ?? null;
  const h = device.harnesses?.find((x) => x.id === agent.harness);
  return h?.accounts?.[h.agentAccounts?.[agent.id] ?? "default"] ?? null;
}

/**
 * Can this agent do work yet? Only from what the hub already reports, and never a claim it can't
 * back up: while devices are loading, or the device or its harness list is unknown, it's ready.
 * Agents that join from outside (mcp) and harnesses placed in a computer need no device install.
 */
export function agentReadiness(agent: Pick<Agent, "id" | "nodeId" | "harness" | "settings" | "computerId"> & Partial<Pick<Agent, "signIn">>, devices: DeviceInfo[] | null): { ready: boolean; problem: string | null } {
  const ok = { ready: true, problem: null };
  const no = (problem: string) => ({ ready: false, problem });
  if (harnessInfo(agent.harness)?.protocol === "mcp") return ok;
  if (!agent.nodeId) return no("No device yet");
  const device = devices?.find((d) => d.id === agent.nodeId);
  if (!device) return ok;
  if (!device.online) return no(`${device.name} is offline`);
  if (device.paused) return no(`${device.name} is paused`);
  const reported = device.harnesses ?? [];
  if (reported.length && !(runsInVm(agent.harness) && agent.settings?.runIn === "computer" && agent.computerId) && !reported.some((h) => h.id === agent.harness)) return no(`${harnessLabel(agent.harness)} isn't installed on ${device.name}`);
  // the hub's word (its device or its own computer), else what the device list says
  if (agent.signIn || agentSignedIn(agent, device) === false) return no(`${harnessLabel(agent.harness)} isn't signed in`);
  return ok;
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Why no device can run VMs right now, or undefined when one can. Unknown (offline, not reported yet) is never "not installed". */
export function vmAvailabilityNote(devices: DeviceInfo[]): string | undefined {
  if (devices.some((d) => d.capabilities?.vm.ok)) return undefined;
  if (!devices.length) return "Connect a device first.";
  const online = devices.filter((d) => d.online);
  if (!online.length) {
    const names = devices.map((d) => d.name);
    return `Can't check while ${joinNames(names)} ${names.length === 1 ? "is" : "are"} disconnected. Reconnect a device to see what it can run.`;
  }
  const refused = online.find((d) => d.capabilities && !d.capabilities.vm.ok);
  if (refused) return refused.capabilities!.vm.detail ? `${refused.name}: ${refused.capabilities!.vm.detail}` : "None of your devices can run VMs yet: install Docker on one.";
  return `Checking what ${joinNames(online.map((d) => d.name))} can run…`;
}
