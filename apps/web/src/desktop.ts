import { useEffect, useState } from "react";
import { useStore } from "./store.ts";
import { useFeature } from "./features.ts";

export interface BuddySettings {
  agentId: string | null;
}

declare global {
  interface Window {
    wispDesktop?: {
      setBadge(n: number): void;
      /** bring the window back from the menu bar (a clicked notification) */
      focus(): void;
      info(): Promise<{ version: string; platform: string; device: boolean }>;
      /** with a claim, this computer becomes that waiting device; without one, a new device */
      connectDevice(claim?: { token: string; name: string }): Promise<void>;
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

/** Keep the tray current even when the buddy is turned off. With the Desk buddy feature off, the app hears no agents, so no buddy appears. */
export function useDesktopAgents() {
  const agents = useStore((s) => s.agents);
  const leadId = useStore((s) => s.lead?.lead ?? null);
  const buddy = useFeature("buddy");
  useEffect(() => {
    window.wispDesktop?.buddy.agents(buddy ? agents.map(({ id, name }) => ({ id, name })) : [], buddy ? leadId : null);
  }, [agents, leadId, buddy]);
  useEffect(() => () => window.wispDesktop?.buddy.agents([], null), []);
}

export type DesktopInfo = { version: string; platform: string; device: boolean };

/** undefined: not in the desktop app (or not asked yet); otherwise what the Wisp app says about this computer. */
export function useDesktopInfo(): { inDesktop: boolean; info: DesktopInfo | null; connect: (claim?: { token: string; name: string }) => Promise<void> } {
  const desktop = typeof window !== "undefined" ? window.wispDesktop : undefined;
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    const read = () => desktop.info().then((i) => live && setInfo(i)).catch(() => {});
    read();
    const t = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [desktop]);
  /** with a claim, this computer becomes that waiting device instead of adding another */
  const connect = async (claim?: { token: string; name: string }) => {
    await desktop?.connectDevice(claim);
    await desktop?.info().then(setInfo).catch(() => {});
  };
  return { inDesktop: !!desktop, info, connect };
}
