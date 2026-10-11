/**
 * Agent appearance: every agent is a little ghost. The options live here so the hub can
 * validate exactly what the web editor offers.
 */

export const GHOST_SHAPES = ["classic", "round", "tall", "sheet", "wisp"] as const;
export const GHOST_EYES = ["dots", "big", "happy", "sparkle", "wink"] as const;
export const GHOST_MOUTHS = ["smile", "open", "cat", "fangs", "tongue", "none"] as const;
export const GHOST_HATS = ["none", "tophat", "party", "beanie", "crown", "witch", "headphones", "bow", "halo", "flower", "propeller"] as const;
export const GHOST_ACCESSORIES = ["none", "glasses", "sunglasses", "monocle", "bowtie", "scarf", "tie", "mustache"] as const;
export const GHOST_MOTIONS = ["float", "bounce", "sway", "still"] as const;

/** Named body colors; any other #rrggbb is allowed too. */
export const GHOST_COLORS: { name: string; hex: string }[] = [
  { name: "Mist", hex: "#f4f1ff" },
  { name: "Mint", hex: "#b8f0d8" },
  { name: "Sky", hex: "#b9dcff" },
  { name: "Lavender", hex: "#d6c8ff" },
  { name: "Peach", hex: "#ffd3b8" },
  { name: "Rose", hex: "#ffc2d6" },
  { name: "Lemon", hex: "#fff1a8" },
  { name: "Lime", hex: "#d9f99d" },
  { name: "Slate", hex: "#64748b" },
  { name: "Midnight", hex: "#2e2a4f" },
];

export type GhostShape = (typeof GHOST_SHAPES)[number];
export type GhostEyes = (typeof GHOST_EYES)[number];
export type GhostMouth = (typeof GHOST_MOUTHS)[number];
export type GhostHat = (typeof GHOST_HATS)[number];
export type GhostAccessory = (typeof GHOST_ACCESSORIES)[number];
export type GhostMotion = (typeof GHOST_MOTIONS)[number];

export interface GhostAppearance {
  shape: GhostShape;
  color: string; // #rrggbb
  glow: boolean;
  eyes: GhostEyes;
  mouth: GhostMouth;
  cheeks: boolean;
  hat: GhostHat;
  accessory: GhostAccessory;
  motion: GhostMotion;
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable, friendly ghost for agents that haven't been customized yet. */
export function defaultAppearance(seed: string): GhostAppearance {
  let h = hash(seed || "ghost");
  const pick = <T>(list: readonly T[]) => {
    const v = list[h % list.length];
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    return v;
  };
  const roll = () => {
    const v = (h % 1000) / 1000;
    h = Math.imul(h ^ (h >>> 11), 2246822519) >>> 0;
    return v;
  };
  return {
    shape: pick(GHOST_SHAPES),
    color: pick(GHOST_COLORS.slice(0, 8)).hex, // light colors by default
    glow: false,
    eyes: pick(GHOST_EYES.filter((e) => e !== "wink")),
    mouth: pick(["smile", "open", "cat", "smile"] as const),
    cheeks: roll() < 0.6,
    hat: roll() < 0.35 ? pick(GHOST_HATS.filter((x) => x !== "none")) : "none",
    accessory: roll() < 0.2 ? pick(GHOST_ACCESSORIES.filter((x) => x !== "none")) : "none",
    motion: "float",
  };
}

/** A random look, for the editor's shuffle button. */
export function randomAppearance(): GhostAppearance {
  return { ...defaultAppearance(Math.random().toString(36)), glow: Math.random() < 0.25, hat: GHOST_HATS[Math.floor(Math.random() * GHOST_HATS.length)] };
}
