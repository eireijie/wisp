import { useEffect, useState } from "react";
import type { DeviceCapabilities, DiscoveredAgent } from "@warren/core";
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
