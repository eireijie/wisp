import { useEffect, useState } from "react";
import type { Agent, DeviceCapabilities, DeviceRole, DiscoveredAgent } from "@warren/core";
import { harnessInfo, harnessLabel, runsInVm } from "@warren/core/src/harnesses.ts";
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
  /** what it does for agents: runs their VMs, lends its own screen, or neither (headless); null until chosen */
  role?: DeviceRole | null;
  /** paused at the device (`warren node pause`) */
  paused?: boolean;
  online: boolean;
  lastSeen?: string | null;
  agents: string[];
  capabilities?: DeviceCapabilities | null;
  discovered?: DiscoveredAgent[];
  harnesses?: { id: string; version: string | null }[];
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

/** "until 5:30 PM", "until tomorrow 9:00 AM", "until you stop it". */
export function lendLabel(until: string | null): string {
  if (until === null) return "until you stop it";
  const d = new Date(until);
  const today = d.toDateString() === new Date().toDateString();
  return `until ${today ? "" : `${d.toLocaleDateString(undefined, { weekday: "short" })} `}${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Can this agent do work yet? Only from what the hub already reports, and never a claim it can't
 * back up: while devices are loading, or the device or its harness list is unknown, it's ready.
 * Agents that join from outside (mcp) and harnesses placed in a computer need no device install.
 */
export function agentReadiness(agent: Pick<Agent, "nodeId" | "harness" | "settings" | "computerId">, devices: DeviceInfo[] | null): { ready: boolean; problem: string | null } {
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
