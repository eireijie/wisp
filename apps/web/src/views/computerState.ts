import { useEffect, useState } from "react";
import { Cloud, Laptop, Monitor } from "lucide-react";
import type { Agent } from "@wisp/core";
import { useStore, type ComputerInfo } from "../store.ts";

/** How a computer is doing, in a word or two, for cards and headers. */
export function computerState(c: ComputerInfo, meId: string | undefined, agents: Agent[], memberName: (id: string) => string): { label: string; tone: "neutral" | "ok" | "warn" | "bad" | "info" | "accent"; working: boolean } {
  if (!c.online) return { label: "Offline", tone: "neutral", working: false };
  if (c.paused) return { label: "Paused at the device", tone: "warn", working: false };
  if (c.status === "starting") return { label: c.statusText || "Starting…", tone: "info", working: false };
  if (c.status === "error") return { label: "Problem", tone: "bad", working: false };
  if (c.controller) return { label: c.controller.id === meId ? "You're in control" : `${memberName(c.controller.id)} is in control`, tone: "accent", working: false };
  const recent = c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000;
  const busy = agents.some((a) => c.agents.includes(a.id) && a.status === "busy");
  if (recent || (busy && c.activity)) return { label: "Working", tone: "warn", working: true };
  return { label: c.status === "stopped" ? "Stopped" : "Ready", tone: "ok", working: false };
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
