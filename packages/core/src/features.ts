/**
 * Optional features an organization can switch on or off (Settings → General → Mods). Everything
 * that needs setup or adds screens lives here, so a new organization starts small.
 */

export const FEATURE_KEYS = ["background", "routines", "teach", "tasks", "voice", "buddy", "invite", "remoteDesktop", "storage", "code"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

export const FEATURE_INFO: Record<FeatureKey, { name: string; description: string; group: "own" | "many" | "extras" }> = {
  background: { name: "Background agents", description: "Agents check your apps on their own and message you first.", group: "own" },
  routines: { name: "Routines", description: "Run a task on a schedule, like a morning summary.", group: "own" },
  teach: { name: "Teach a task", description: "Do something once while an agent watches, and it becomes a skill.", group: "own" },
  tasks: { name: "Tasks board", description: "Give out work and track it from start to done.", group: "many" },
  voice: { name: "Voice calls", description: "Call an agent and talk instead of typing.", group: "extras" },
  buddy: { name: "Desk buddy", description: "A small ghost on your desktop that shows what your agents are up to.", group: "extras" },
  invite: { name: "Invite people", description: "Let other people into this workspace. Adds a People page and lets agents answer more than just you.", group: "extras" },
  remoteDesktop: { name: "Remote desktop", description: "Reach your devices from anywhere with RustDesk, from each device's page.", group: "extras" },
  storage: { name: "Storage", description: "Let agents use files on your Nextcloud, NAS, Google Drive or Dropbox.", group: "extras" },
  code: { name: "Code", description: "A terminal view where agents code side by side and you can jump in.", group: "extras" },
};

/** Mods that are on unless someone turns them off, even in Simple and for organizations from before they existed. */
const ON_UNLESS_REMOVED: readonly FeatureKey[] = ["code"];

/** Mods kept out of the Mods page (and agents' list) until their screens are built. */
export const UNLISTED_FEATURES: readonly FeatureKey[] = ["code"];

/** Mods that stay off until someone adds them, even for organizations from before Features. */
const OFF_UNTIL_ADDED: readonly FeatureKey[] = ["storage"];

const all = (on: boolean) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, on])) as Features;
const on = (keys: readonly FeatureKey[]) => Object.fromEntries(keys.map((k) => [k, true])) as Partial<Features>;

/** Simple turns everything off but the mods that are on unless removed; Everything turns it all on, apart from mods that need setting up first. */
export const FEATURE_PRESETS = { simple: { ...all(false), ...on(ON_UNLESS_REMOVED) } as Features, everything: { ...all(true), ...Object.fromEntries(OFF_UNTIL_ADDED.map((k) => [k, false])) } as Features } as const;

/**
 * Organizations made before Features existed keep everything on, so nothing they use disappears;
 * new ones store an explicit set (Simple unless the person picks otherwise).
 */
export function resolveFeatures(stored: Partial<Features> | null | undefined): Features {
  if (!stored) return { ...FEATURE_PRESETS.everything };
  return { ...all(false), ...on(ON_UNLESS_REMOVED), ...Object.fromEntries(Object.entries(stored).filter(([k, v]) => (FEATURE_KEYS as readonly string[]).includes(k) && typeof v === "boolean")) };
}
