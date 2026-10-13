import { useEffect } from "react";
import { create } from "zustand";
import type { Agent, DeviceRole } from "@warren/core";
import { api } from "./api.ts";
import { useStore } from "./store.ts";

export interface OnboardingState {
  /** `mine`: you connected it; `role`: what it does for agents, once someone chose */
  devices: { id: string; name: string; online: boolean; mine: boolean; role: DeviceRole | null }[];
  computers: { id: string; name: string; kind: "vm" | "orgo"; nodeId: string | null; status: string }[];
  agents: Agent[];
  firstReply: { id: string; channelId: string; agentId: string } | null;
  memoryNotes: { path: string; title: string }[];
}

/** The setup's screens, in order. */
export const STEPS = ["device", "role", "agent", "harness", "hello"] as const;
export type StepId = (typeof STEPS)[number];

export function stepsDone(s: OnboardingState | null): Record<StepId, boolean> {
  const agent = !!s?.agents.length;
  return {
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

export function setDismissed(v: boolean) {
  try {
    if (v) localStorage.setItem(DISMISS_KEY, "1");
    else localStorage.removeItem(DISMISS_KEY);
  } catch {}
}

const useOnboardingStore = create<{ state: OnboardingState | null; error: string | null; refresh: () => Promise<void> }>((set) => ({
  state: null,
  error: null,
  refresh: () =>
    api<OnboardingState>("GET", "/api/onboarding").then(
      (state) => set({ state, error: null }),
      (e: { status?: number; message: string }) =>
        // a 404 means the browser has a newer app than the hub is running
        set({ error: e.status === 404 ? "This hub is running an older version than the app. Restart it (Ctrl-C, then npm start) to continue." : `Couldn't check your progress: ${e.message}` }),
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
