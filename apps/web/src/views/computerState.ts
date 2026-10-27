import { useEffect, useState } from "react";
import { Cloud, Laptop, Monitor } from "lucide-react";
import type { Agent } from "@wisp/core";
import { useStore, type ComputerInfo } from "../store.ts";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

/** How a computer is doing, in a word or two, for cards and headers. */
export function computerState(c: ComputerInfo, meId: string | undefined, agents: Agent[], memberName: (id: string) => string): { label: string; tone: Tone; working: boolean } {
  if (!c.online) return { label: "Offline", tone: "neutral", working: false };
  if (c.paused) return { label: "Paused at the device", tone: "neutral", working: false };
  if (c.status === "starting") return { label: c.statusText || "Starting…", tone: "info", working: false };
  if (c.status === "error") return { label: "Problem", tone: "bad", working: false };
  if (c.controller) return { label: c.controller.id === meId ? "You're in control" : `${memberName(c.controller.id)} is in control`, tone: "warn", working: false };
  const recent = c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000;
  const busy = agents.some((a) => c.agents.includes(a.id) && a.status === "busy");
  if (recent || (busy && c.activity)) return { label: "Working", tone: "info", working: true };
  if (c.status === "stopped") return { label: "Stopped", tone: "neutral", working: false };
  return { label: "Ready", tone: "ok", working: false };
}

/**
 * The one status-color rule (iOS matches it). Connectivity first, so offline always wins:
 * offline or paused -> gray; you or someone else in control, or an agent asking for help -> amber;
 * a problem -> red; working or starting -> blue; ready -> green.
 */
export function toneColor(tone: Tone): string {
  return tone === "ok" ? "var(--st-online)" : tone === "info" ? "var(--st-working)" : tone === "warn" ? "var(--st-needs)" : tone === "bad" ? "var(--st-problem)" : "var(--status-idle)";
}

export function stateColor(state: { tone: Tone; working: boolean }, c: { online: boolean; paused?: boolean; help?: unknown; controller?: unknown }, mine: boolean): string {
  if (!c.online || c.paused) return "var(--status-idle)";
  if (mine || c.help || c.controller) return "var(--st-needs)";
  return state.working ? "var(--st-working)" : toneColor(state.tone);
}

/** The dot color for an activity line, by what it says: took control amber, handed it back green, opened the live view sky, else gray. */
export function activityDot(text: string): string {
  if (/took control/i.test(text)) return "var(--st-needs)";
  if (/handed (it )?back/i.test(text)) return "var(--st-online)";
  if (/opened (the )?live view/i.test(text)) return "var(--accent-computers)";
  return "var(--status-idle)";
}

export function useComputerState(c: ComputerInfo) {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  // re-evaluate "Working" as activity ages
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return computerState(c, me?.user.id, agents, (id) => members.find((m) => m.id === id)?.name ?? "Someone");
}

export const KIND_ICON = { device: Laptop, vm: Monitor, orgo: Cloud };
