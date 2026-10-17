import { useSyncExternalStore } from "react";

type Activity = "active" | "idle" | "waking";
const IDLE_AFTER = 3 * 60 * 1000;
const listeners = new Set<() => void>();
let activity: Activity = "active";
let lastActivity = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

function publish(next: Activity) {
  activity = next;
  listeners.forEach((listener) => listener());
}

function check() {
  const remaining = IDLE_AFTER - (Date.now() - lastActivity);
  if (remaining <= 0) publish("idle");
  else {
    if (activity === "waking") publish("active");
    timer = setTimeout(check, remaining);
  }
}

function wake() {
  lastActivity = Date.now();
  if (activity !== "idle") return;
  publish("waking");
  timer = setTimeout(check, 600);
}

/** One clock for the whole page; pointer movement never causes React renders. */
export function subscribeActivity(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    lastActivity = Date.now();
    events.forEach((event) => window.addEventListener(event, wake, { passive: true }));
    timer = setTimeout(check, IDLE_AFTER);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    events.forEach((event) => window.removeEventListener(event, wake));
    clearTimeout(timer);
    activity = "active";
  };
}

export const activitySnapshot = () => activity;
const inactive = () => "active" as const;
const noSubscription = () => () => {};

export function useGhostActivity(enabled: boolean) {
  return useSyncExternalStore(enabled ? subscribeActivity : noSubscription, enabled ? activitySnapshot : inactive, inactive);
}
