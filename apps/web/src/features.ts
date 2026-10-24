import { useMemo } from "react";
import { resolveFeatures, type FeatureKey, type Features } from "@warren/core";
import { api } from "./api.ts";
import { useStore } from "./store.ts";

/**
 * The optional features this organization has switched on (Settings → General → Mods). They come with
 * GET /api/me and stay current through the "features" event. A hub that doesn't know about
 * features yet sends none, and then everything is on, so nothing anyone uses disappears.
 */
export function useFeatures(): Features {
  const stored = useStore((s) => s.me?.features);
  return useMemo(() => resolveFeatures(stored ?? null), [stored]);
}

/** Is one feature on? */
export function useFeature(key: FeatureKey): boolean {
  return useStore((s) => resolveFeatures(s.me?.features ?? null)[key]);
}

/** Change some features (owners only). Shows the change at once, then what the hub saved. */
export async function setFeatures(patch: Partial<Features>): Promise<Features> {
  const before = useStore.getState().me?.features ?? null;
  const optimistic = { ...resolveFeatures(before), ...patch };
  useStore.setState((s) => (s.me ? { me: { ...s.me, features: optimistic } } : {}));
  try {
    const r = await api<{ features: Features }>("PUT", "/api/features", patch);
    const saved = resolveFeatures(r?.features ?? optimistic);
    useStore.setState((s) => (s.me ? { me: { ...s.me, features: saved } } : {}));
    return saved;
  } catch (e) {
    useStore.setState((s) => (s.me ? { me: { ...s.me, features: before ?? undefined } } : {}));
    throw e;
  }
}
