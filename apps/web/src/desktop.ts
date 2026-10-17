import { useEffect } from "react";
import { useStore } from "./store.ts";

export interface BuddySettings {
  agentId: string | null;
}

declare global {
  interface Window {
    warrenDesktop?: {
      setBadge(n: number): void;
      info(): Promise<{ version: string; platform: string; device: boolean }>;
      connectDevice(): Promise<void>;
      buddy: {
        agents(agents: { id: string; name: string }[], leadId: string | null): void;
        settings(): Promise<BuddySettings>;
        onSettings(fn: (settings: BuddySettings) => void): () => void;
        onPointer(fn: (point: { x: number; y: number } | null) => void): () => void;
        ignoreMouse(ignore: boolean): void;
        expand(expanded: boolean): void;
        drag(phase: "start" | "move" | "end"): void;
        open(route: string): void;
      };
    };
  }
}

/** Keep the tray current even when the buddy is turned off. */
export function useDesktopAgents() {
  const agents = useStore((s) => s.agents);
  const leadId = useStore((s) => s.teams.find((t) => t.leadId)?.leadId ?? null);
  useEffect(() => {
    window.warrenDesktop?.buddy.agents(agents.map(({ id, name }) => ({ id, name })), leadId);
  }, [agents, leadId]);
  useEffect(() => () => window.warrenDesktop?.buddy.agents([], null), []);
}
