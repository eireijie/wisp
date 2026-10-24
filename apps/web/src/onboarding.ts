import { useEffect } from "react";
import { create } from "zustand";
import { FEATURE_PRESETS, type Agent, type DeviceRole, type Features } from "@warren/core";
import { harnessInfo, harnessLabel, runsInVm } from "@warren/core/src/harnesses.ts";
import { api } from "./api.ts";
import { accessSkipped, onPublicAddress } from "./access.ts";
import { useStore } from "./store.ts";
import { agentReadiness, type DeviceInfo } from "./devices.ts";
import type { Route } from "./router.ts";

export interface OnboardingState {
  /** `mine`: you connected it; `role`: what it does for agents, once someone chose */
  devices: { id: string; name: string; online: boolean; mine: boolean; role: DeviceRole | null }[];
  computers: { id: string; name: string; kind: "vm" | "orgo"; nodeId: string | null; status: string }[];
  agents: Agent[];
  firstReply: { id: string; channelId: string; agentId: string } | null;
  memoryNotes: { path: string; title: string }[];
  /** the hub has an address that works from anywhere (Tailscale serving it) */
  reachable?: boolean;
}

/** The setup's screens, in order. */
export const STEPS = ["anywhere", "device", "role", "agent", "harness", "hello"] as const;
export type StepId = (typeof STEPS)[number];

export function stepsDone(s: OnboardingState | null): Record<StepId, boolean> {
  const agent = !!s?.agents.length;
  return {
    // Tailscale first, so every device and phone added next can reach Warren from anywhere
    anywhere: !!s?.reachable || onPublicAddress() || accessSkipped(),
    device: !!s?.devices.some((d) => d.online),
    role: !!s?.devices.some((d) => d.role),
    agent,
    // an agent is made with its harness
    harness: agent,
    hello: !!s?.firstReply,
  };
}

const DISMISS_KEY = "warren.onboarding.dismissed";

export function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Lets the sidebar react the moment "Do this later" is clicked. */
const useDismissStore = create<{ dismissed: boolean }>(() => ({ dismissed: isDismissed() }));

export function useDismissed(): boolean {
  return useDismissStore((s) => s.dismissed);
}

export function setDismissed(v: boolean) {
  try {
    if (v) localStorage.setItem(DISMISS_KEY, "1");
    else localStorage.removeItem(DISMISS_KEY);
  } catch {}
  useDismissStore.setState({ dismissed: v });
}

/** How far along setup is. A skipped but unfinished setup stays visible in the sidebar as "Finish setup". */
export function setupProgress(done: Record<StepId, boolean>) {
  const steps = STEPS.length;
  const progress = STEPS.filter((id) => done[id]).length;
  return { progress, steps, complete: progress >= steps };
}

const useOnboardingStore = create<{ state: OnboardingState | null; error: string | null; refresh: () => Promise<void> }>((set) => ({
  state: null,
  error: null,
  refresh: () =>
    api<OnboardingState>("GET", "/api/onboarding").then(
      (state) => set({ state, error: null }),
      (e: { status?: number; message: string }) =>
        // a 404 means the browser has a newer app than the hub is running
        set({ error: e.status === 404 ? "This hub is running an older version than the app. Restart Warren on the computer it runs on (or run: warren update), then reload this page." : `Couldn't check your progress: ${e.message}` }),
    ),
}));

/**
 * Onboarding progress from the hub, shared by the page and the sidebar. Refetches when
 * agents change status or post, and optionally polls (the page polls so a device
 * connecting shows up quickly).
 */
export function useOnboarding(pollMs?: number) {
  const { state, error, refresh } = useOnboardingStore();
  const agents = useStore((s) => s.agents);
  const messages = useStore((s) => s.messages);

  useEffect(() => {
    refresh();
  }, [refresh, agents, messages]);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return { state, error, refresh, done: stepsDone(state) };
}

/** Each setup step as a plain next thing to do, for "Continue setup" and Help. */
export const NEXT_STEP: Record<StepId, string> = {
  anywhere: "Set up Warren to work from anywhere",
  device: "Connect a computer to Warren",
  role: "Choose what that computer does for helpers",
  agent: "Make your first helper",
  harness: "Choose the AI your helper uses",
  hello: "Say hello to your helper",
};

/** The first setup step that hasn't happened yet, or null when setup is done. */
export function nextStep(done: Record<StepId, boolean>): StepId | null {
  return STEPS.find((s) => !done[s]) ?? null;
}

type AgentLike = Pick<Agent, "id" | "name" | "nodeId" | "harness" | "settings" | "computerId">;

/** The helper to talk about on Home and in Help: a ready one first, then one with a device, then any. */
export function pickHelper<A extends AgentLike>(agents: A[], devices: DeviceInfo[] | null): A | null {
  return agents.find((a) => agentReadiness(a, devices).ready) ?? agents.find((a) => a.nodeId) ?? agents[0] ?? null;
}

/**
 * What Home should lead with: finish setup (no helper yet), a helper that is waiting on something
 * (its problem, in plain words), or a ready helper to try. Only claims what the hub reports.
 */
export type HomeReadiness<A extends AgentLike = AgentLike> =
  | { kind: "setup"; next: StepId }
  | { kind: "waiting"; agent: A; problem: string; deviceName: string | null }
  | { kind: "ready"; agent: A };

export function homeReadiness<A extends AgentLike>(done: Record<StepId, boolean>, agents: A[], devices: DeviceInfo[] | null): HomeReadiness<A> {
  const agent = pickHelper(agents, devices);
  if (!agent) return { kind: "setup", next: nextStep(done) ?? "agent" };
  const { ready, problem } = agentReadiness(agent, devices);
  if (ready) return { kind: "ready", agent };
  const deviceName = devices?.find((d) => d.id === agent.nodeId)?.name ?? null;
  return { kind: "waiting", agent, problem: problem ?? "Not ready yet", deviceName };
}

export interface HelperCheck {
  id: "helper" | "device" | "online" | "harness";
  /** ok: fine; bad: needs fixing; unknown: the hub can't tell yet (never reported as broken) */
  status: "ok" | "bad" | "unknown";
  label: string;
  /** one line on what to do, when it isn't ok */
  fix: string | null;
  to: Route | null;
}

/**
 * "My helper isn't answering": the checks in order, from what the hub reports. Each failing one
 * says what to do and where; later checks are unknown while an earlier one fails.
 */
export function helperChecklist(agents: AgentLike[], devices: DeviceInfo[] | null): HelperCheck[] {
  const agent = pickHelper(agents, devices);
  const out: HelperCheck[] = [];
  const unknown = (id: HelperCheck["id"], label: string): HelperCheck => ({ id, status: "unknown", label, fix: null, to: null });
  if (!agent) {
    out.push({ id: "helper", status: "bad", label: "You have a helper", fix: "Make one in setup. It takes a few minutes.", to: { view: "welcome" } });
    out.push(unknown("device", "It has a device to work on"), unknown("online", "That device is on and connected"), unknown("harness", "Its AI is installed there"));
    return out;
  }
  out.push({ id: "helper", status: "ok", label: `You have a helper: ${agent.name}`, fix: null, to: null });
  // helpers that join from outside Warren don't need a device here
  if (harnessInfo(agent.harness)?.protocol === "mcp") {
    out.push({ id: "device", status: "ok", label: `${agent.name} runs outside Warren and needs no device here`, fix: null, to: null });
    return out;
  }
  const agentRoute = (tab: "device" | "model"): Route => ({ view: "agents", agentId: agent.id, tab });
  if (!agent.nodeId) {
    out.push({ id: "device", status: "bad", label: `${agent.name} has a device to work on`, fix: `Pick the computer ${agent.name} should use.`, to: agentRoute("device") });
    out.push(unknown("online", "That device is on and connected"), unknown("harness", "Its AI is installed there"));
    return out;
  }
  const device = devices?.find((d) => d.id === agent.nodeId);
  if (!device) {
    out.push({ id: "device", status: devices ? "bad" : "unknown", label: `${agent.name} has a device to work on`, fix: devices ? `Its device was removed. Pick another for ${agent.name}.` : null, to: devices ? agentRoute("device") : null });
    out.push(unknown("online", "That device is on and connected"), unknown("harness", "Its AI is installed there"));
    return out;
  }
  out.push({ id: "device", status: "ok", label: `${agent.name} works on ${device.name}`, fix: null, to: null });
  if (!device.online || device.paused) {
    out.push({
      id: "online",
      status: "bad",
      label: `${device.name} is on and connected`,
      fix: device.paused ? `${device.name} is paused. Resume Warren on it.` : `Turn on ${device.name} and make sure Warren is running there.`,
      to: { view: "nodes" },
    });
    out.push(unknown("harness", "Its AI is installed there"));
    return out;
  }
  out.push({ id: "online", status: "ok", label: `${device.name} is on and connected`, fix: null, to: null });
  const label = harnessLabel(agent.harness);
  const reported = device.harnesses ?? [];
  if (runsInVm(agent.harness) && agent.settings?.runIn === "computer" && agent.computerId) out.push({ id: "harness", status: "ok", label: `${label} runs inside ${agent.name}'s computer`, fix: null, to: null });
  else if (!reported.length) out.push(unknown("harness", `${label} is installed on ${device.name}`));
  else if (reported.some((h) => h.id === agent.harness)) out.push({ id: "harness", status: "ok", label: `${label} is installed on ${device.name}`, fix: null, to: null });
  else out.push({ id: "harness", status: "bad", label: `${label} is installed on ${device.name}`, fix: `Install ${label} on ${device.name}, or pick an AI that's already there.`, to: agentRoute("model") });
  return out;
}

export { isLocalOnlyHost } from "./loopback.ts";

/** The features an owner's Simple or Advanced choice sets for the organization: Simple keeps the extras off, Advanced turns them all on. */
export function featuresForExperience(choice: "simple" | "advanced"): Features {
  return { ...(choice === "simple" ? FEATURE_PRESETS.simple : FEATURE_PRESETS.everything) };
}
