import { useEffect, useState } from "react";
import type { Agent, DeviceCapabilities, DeviceRole, DiscoveredAgent, OwnRemoteDesktop } from "@bubble-ai/core";
import { harnessInfo, harnessLabel, runsInVm } from "@bubble-ai/core/src/harnesses.ts";
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
  /** paused at the device (`bubble-ai node pause`) */
  paused?: boolean;
  online: boolean;
  lastSeen?: string | null;
  agents: string[];
  capabilities?: DeviceCapabilities | null;
  discovered?: DiscoveredAgent[];
  harnesses?: {
    id: string;
    version: string | null;
    accounts?: Record<string, boolean | null>;
    agentAccounts?: Record<string, string>;
    /** the models and efforts it offers there (new agents pick from these) */
    models?: { id: string; label: string; efforts?: string[]; defaultEffort?: string }[];
    efforts?: string[];
    defaultModel?: string;
    defaultEffort?: string;
  }[];
  /** what's signed in inside each of its VMs (computer id → harness → signed in) */
  vmSignIns?: Record<string, Record<string, boolean | null>>;
  /** the Bubble AI version it runs */
  version?: { commit: string | null; date: string | null } | null;
  update?: { state: "idle" | "updating" | "restarting" | "failed"; message: string } | null;
  remoteDesktop?: OwnRemoteDesktop | null;
}

/** The devices list, refreshed every few seconds while mounted. */
// One list and one poll for the whole app, however many parts of a screen ask for it: every
// caller reads the same answer, and the poll runs at the fastest pace any of them asked for.
const deviceList = { value: null as DeviceInfo[] | null, at: 0, loading: false, timer: undefined as ReturnType<typeof setInterval> | undefined, pace: 0 };
const deviceWatchers = new Map<symbol, { intervalMs: number; tell: (d: DeviceInfo[] | null) => void }>();

function loadDevices() {
  if (deviceList.loading) return;
  deviceList.loading = true;
  api<DeviceInfo[]>("GET", "/api/nodes")
    .then(
      (d) => {
        deviceList.at = Date.now();
        // the same answer as last time keeps the list it already has, so a poll with no news re-renders nothing
        if (deviceList.value && JSON.stringify(deviceList.value) === JSON.stringify(d)) return;
        deviceList.value = d;
        for (const w of deviceWatchers.values()) w.tell(d);
      },
      () => {},
    )
    .finally(() => {
      deviceList.loading = false;
    });
}

function paceDevices() {
  const pace = deviceWatchers.size ? Math.min(...[...deviceWatchers.values()].map((w) => w.intervalMs)) : 0;
  if (pace === deviceList.pace) return;
  clearInterval(deviceList.timer);
  deviceList.pace = pace;
  deviceList.timer = pace ? setInterval(loadDevices, pace) : undefined;
}

export function useDevices(intervalMs = 5000): DeviceInfo[] | null {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(deviceList.value);
  useEffect(() => {
    const key = Symbol();
    deviceWatchers.set(key, { intervalMs, tell: setDevices });
    setDevices(deviceList.value);
    // a part that just appeared gets a fresh answer, unless one arrived a moment ago or is on its way
    if (Date.now() - deviceList.at > 500) loadDevices();
    paceDevices();
    return () => {
      deviceWatchers.delete(key);
      paceDevices();
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

/**
 * Where an agent's own computer (a VM) goes: the device its current computer or its AI is on when
 * that one can run VMs, else the first connected device that can. Otherwise why not, in plain
 * words, and the one thing that fixes it.
 */
export function ownComputerPlace(preferred: (string | null | undefined)[], devices: DeviceInfo[]): { nodeId: string } | { problem: string; fix: string | null } {
  const can = (d: DeviceInfo | undefined) => !!d?.online && !!d.capabilities?.vm.ok;
  for (const id of preferred) if (id && can(devices.find((d) => d.id === id))) return { nodeId: id };
  const any = devices.find((d) => can(d) && d.mine) ?? devices.find(can);
  if (any) return { nodeId: any.id };
  const near = devices.find((d) => preferred.includes(d.id)) ?? devices.find((d) => d.mine) ?? devices[0];
  if (!near) return { problem: "Connect a computer first.", fix: null };
  if (!near.online) return { problem: `${near.name} is offline.`, fix: `Open Bubble AI on ${near.name}.` };
  return { problem: `${near.name} can't run its own computer yet.`, fix: vmFix(near.capabilities?.vm.detail, near.name) };
}

/** The one step that lets a device run VMs, from what it said is missing. */
export function vmFix(detail: string | undefined, name: string): string {
  const d = detail ?? "";
  if (/container system start/.test(d)) return `On ${name}, run: container system start`;
  if (/podman machine start/.test(d)) return `On ${name}, run: podman machine start`;
  if (/Docker is installed but not running/i.test(d)) return `Start Docker Desktop, OrbStack or Colima on ${name}.`;
  if (/bubble-ai setup/.test(d)) return `On ${name}, run: bubble-ai setup`;
  return `Install Docker on ${name}.`;
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

/**
 * How many machines are on, for the sidebar's Computers row: every connected device (paused ones
 * aside), plus agent computers (VMs, cloud) that are running. A device's own screen is that device,
 * so it isn't counted twice. Before the device list has loaded, devices with a screen stand in.
 */
export function machinesOn(devices: Pick<DeviceInfo, "online" | "paused">[] | null, computers: Pick<ComputerInfo, "kind" | "online" | "status" | "paused">[]): number {
  const own = devices ? devices.filter((d) => d.online && !d.paused).length : computers.filter((c) => c.kind === "device" && c.online && !c.paused).length;
  const vms = computers.filter((c) => c.kind !== "device" && c.online && !c.paused && (c.status === "ready" || c.status === "starting")).length;
  return own + vms;
}

/**
 * Where an agent runs (round 16, board 16c "Runs on"): the organization's shared computer, or one of
 * the devices this person can use. One list for New agent and the agent's profile.
 */
export type RunsOn = { kind: "shared"; computerId: string; nodeId: string | null } | { kind: "device"; nodeId: string };

export interface RunsOnChoice {
  key: string;
  label: string;
  /** "Always on · on Sam's Mac", "Windows · online", "Offline" */
  sub: string;
  online: boolean;
  to: RunsOn;
}

const SHORT_OS: Record<string, string> = { darwin: "Mac", win32: "Windows", linux: "Linux" };

export const runsOnKey = (r: RunsOn) => (r.kind === "shared" ? "shared" : `d:${r.nodeId}`);

/** The choices, shared computer first, then the usable devices (online ones first, in the hub's order). */
export function runsOnChoices(devices: DeviceInfo[], computers: Pick<ComputerInfo, "id" | "nodeId" | "config">[]): RunsOnChoice[] {
  const shared = computers.find(isSharedComputer);
  const usable = usableDevices(devices);
  const out: RunsOnChoice[] = [];
  if (shared) {
    const host = devices.find((d) => d.id === shared.nodeId);
    out.push({ key: "shared", label: "Shared computer", sub: host ? `Always on · on ${host.name}` : "Always on", online: !host || host.online, to: { kind: "shared", computerId: shared.id, nodeId: shared.nodeId ?? null } });
  }
  for (const d of [...usable.filter((x) => x.online), ...usable.filter((x) => !x.online)]) {
    const os = SHORT_OS[d.capabilities?.platform ?? ""];
    const state = !d.online ? "Offline" : d.paused ? "Paused" : "Online";
    const whose = !d.mine && d.ownerName ? `${d.ownerName}'s` : null;
    const sub = [whose, os, os || whose ? state.toLowerCase() : state].filter(Boolean).join(" · ");
    out.push({ key: `d:${d.id}`, label: d.name, sub: sub.charAt(0).toUpperCase() + sub.slice(1), online: d.online && !d.paused, to: { kind: "device", nodeId: d.id } });
  }
  return out;
}

/** Where an agent runs now, as a choice key: "shared" on the shared computer, else its device; null with neither. */
export function agentRunsOn(agent: Pick<Agent, "nodeId" | "computerId">, computers: Pick<ComputerInfo, "id" | "config">[]): string | null {
  const comp = agent.computerId ? computers.find((c) => c.id === agent.computerId) : undefined;
  if (comp && isSharedComputer(comp)) return "shared";
  return agent.nodeId ? `d:${agent.nodeId}` : null;
}

/** What New agent sends for a choice: the device, and the shared computer when that's the pick. */
export function runsOnCreate(r: RunsOn): { nodeId: string | null; computerId?: string } {
  return r.kind === "shared" ? { nodeId: r.nodeId, computerId: r.computerId } : { nodeId: r.nodeId };
}

/**
 * What moving an agent sends (PATCH /api/agents/:id). Onto the shared computer: its device and that
 * computer. Onto a device: that device; a computer it had elsewhere (the shared one, or a VM or
 * screen on the old device) stays behind and it runs on the device itself.
 */
export function runsOnMove(agent: Pick<Agent, "nodeId" | "computerId">, r: RunsOn, computers: Pick<ComputerInfo, "id" | "nodeId" | "config">[]): { nodeId: string | null; computerId?: string | null; settings?: { runIn: "device" } } {
  if (r.kind === "shared") return { nodeId: r.nodeId, computerId: r.computerId };
  const comp = agent.computerId ? computers.find((c) => c.id === agent.computerId) : undefined;
  if (comp && (isSharedComputer(comp) || comp.nodeId !== r.nodeId)) return { nodeId: r.nodeId, computerId: null, settings: { runIn: "device" } };
  return { nodeId: r.nodeId };
}

/** The pick New agent starts on: what the defaults would do (the shared computer for an owner when that's the default, else the default device), else the first device that's on. */
export function defaultRunsOn(choices: RunsOnChoice[], defaults: { computer: string; nodeId: string | null } | null, owner: boolean): RunsOnChoice | null {
  const shared = choices.find((c) => c.key === "shared");
  if (shared && owner && defaults?.computer === "shared") return shared;
  return (defaults?.nodeId && choices.find((c) => c.key === `d:${defaults.nodeId}`)) || choices.find((c) => c.key !== "shared" && c.online) || choices.find((c) => c.key !== "shared") || shared || null;
}
