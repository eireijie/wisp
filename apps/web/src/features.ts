import { Fragment, createElement, useMemo, type ReactNode } from "react";
import { FEATURE_INFO, FEATURE_KEYS, FEATURE_PRESETS, resolveFeatures, type FeatureKey, type Features } from "@warren/core";
import { api } from "./api.ts";
import { useStore } from "./store.ts";

/**
 * The optional features this organization has switched on (Settings → Features). They come with
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

/** The same check outside React (event handlers, command lists). */
export function featureOn(key: FeatureKey): boolean {
  return resolveFeatures(useStore.getState().me?.features ?? null)[key];
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

/** Which Quick start choice a set of features matches: all off, all on, or a mix. */
export function featurePreset(f: Features): "simple" | "everything" | "custom" {
  const on = FEATURE_KEYS.filter((k) => f[k]).length;
  return on === 0 ? "simple" : on === FEATURE_KEYS.length ? "everything" : "custom";
}

export const FEATURE_GROUPS: { id: "own" | "many" | "extras"; title: string }[] = [
  { id: "own", title: "Agents on their own" },
  { id: "many", title: "Organizing many agents" },
  { id: "extras", title: "Extras" },
];

/** The features of each group, in FEATURE_KEYS order. */
export function featuresIn(group: "own" | "many" | "extras"): FeatureKey[] {
  return FEATURE_KEYS.filter((k) => FEATURE_INFO[k].group === group);
}

export { FEATURE_PRESETS };

/** Shows its children only while the named feature is on. */
export function Feature({ name, children, fallback = null }: { name: FeatureKey; children: ReactNode; fallback?: ReactNode }) {
  const on = useFeature(name);
  return createElement(Fragment, null, on ? children : fallback);
}
