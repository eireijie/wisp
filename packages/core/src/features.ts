/**
 * Optional features an organization can switch on or off (Settings → Features). Everything
 * that needs setup or adds screens lives here, so a new organization starts small.
 */

export const FEATURE_KEYS = ["background", "routines", "teach", "tasks", "voice", "buddy", "invite"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

export const FEATURE_INFO: Record<FeatureKey, { name: string; description: string; group: "own" | "many" | "extras" }> = {
  background: { name: "Background agents", description: "Agents check your apps on their own and message you first.", group: "own" },
  routines: { name: "Routines", description: "Run a task on a schedule, like a morning summary.", group: "own" },
  teach: { name: "Teach a task", description: "Do something once while an agent watches, and it becomes a skill.", group: "own" },
  tasks: { name: "Tasks board", description: "Give out work and track it from start to done.", group: "many" },
  voice: { name: "Voice calls", description: "Call an agent and talk instead of typing.", group: "extras" },
  buddy: { name: "Desk buddy", description: "A small ghost on your desktop that shows what your agents are up to.", group: "extras" },
  invite: { name: "Invite people", description: "Let other people into this organization. Adds a People page and lets agents answer more than just you.", group: "extras" },
};

const all = (on: boolean) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, on])) as Features;

/** Simple turns everything off; Everything turns it all on. */
export const FEATURE_PRESETS = { simple: all(false), everything: all(true) } as const;

/**
 * Organizations made before Features existed keep everything on, so nothing they use disappears;
 * new ones store an explicit set (Simple unless the person picks otherwise).
 */
export function resolveFeatures(stored: Partial<Features> | null | undefined): Features {
  if (!stored) return all(true);
  return { ...all(false), ...Object.fromEntries(Object.entries(stored).filter(([k, v]) => (FEATURE_KEYS as readonly string[]).includes(k) && typeof v === "boolean")) };
}
