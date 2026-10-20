import { FEATURE_KEYS, resolveFeatures, type FeatureKey, type Features } from "@warren/core";
import type { Store } from "./store.ts";

const KEY = "features";

/** The organization's optional features (Settings → Features). Organizations from before Features have everything on. */
export function workspaceFeatures(store: Store, workspaceId: string): Features {
  let stored: Partial<Features> | null = null;
  try {
    stored = JSON.parse(store.setting(workspaceId, KEY) ?? "null");
  } catch {}
  return resolveFeatures(stored);
}

export function featureOn(store: Store, workspaceId: string, key: FeatureKey): boolean {
  return workspaceFeatures(store, workspaceId)[key];
}

/** Store a complete set: what's there now with `patch` on top. */
export function setWorkspaceFeatures(store: Store, workspaceId: string, patch: Partial<Features>): Features {
  const next = { ...workspaceFeatures(store, workspaceId) };
  for (const k of FEATURE_KEYS) if (typeof patch[k] === "boolean") next[k] = patch[k]!;
  store.setSetting(workspaceId, KEY, JSON.stringify(next));
  return next;
}
