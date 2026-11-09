import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api.ts";

/**
 * Simple (the default): agents work on one shared computer and Wisp places them. Advanced: an
 * owner chose to pick where agents run (Settings → Devices), which adds those choices to an agent's
 * Computer page and to New agent, and nowhere else.
 */
interface ComputerMode {
  advanced: boolean;
  sharedComputerId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  setAdvanced: (on: boolean) => Promise<void>;
}

export const useComputerModeStore = create<ComputerMode>((set) => ({
  advanced: false,
  sharedComputerId: null,
  loaded: false,
  load: async () => {
    const r = await api<{ advanced?: boolean; sharedComputerId?: string | null }>("GET", "/api/settings/computers");
    set({ advanced: !!r.advanced, sharedComputerId: r.sharedComputerId ?? null, loaded: true });
  },
  setAdvanced: async (on) => {
    const r = await api<{ advanced?: boolean; sharedComputerId?: string | null }>("PUT", "/api/settings/computers", { advanced: on });
    set({ advanced: !!r.advanced, sharedComputerId: r.sharedComputerId ?? null, loaded: true });
  },
}));

/** Simple or Advanced, loaded once. */
export function useComputerMode() {
  const s = useComputerModeStore();
  useEffect(() => {
    if (!s.loaded) void s.load().catch(() => {});
  }, [s.loaded]);
  return s;
}
