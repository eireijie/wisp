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

/**
 * Two-color body gradients, top color first. These are ClipLab's cap-v1 palettes (MIT, as
 * used by Paperclip). Any other pair of #rrggbb colors is allowed too.
 */
export const GHOST_PALETTES: { name: string; color: string; color2: string }[] = [
  { name: "Bubblegum sky", color: "#8bd4ff", color2: "#ff51bf" },
  { name: "Pink lemonade", color: "#ff26a8", color2: "#fff78a" },
  { name: "Orchid peach", color: "#e771ff", color2: "#ffd87c" },
  { name: "Coral mint", color: "#beffe8", color2: "#ff797b" },
  { name: "Lime lagoon", color: "#b4ffa4", color2: "#26dfff" },
  { name: "Arctic blue", color: "#97fff3", color2: "#0084ff" },
  { name: "Solar flare", color: "#ecca5c", color2: "#fe3c3f" },
  { name: "Violet ember", color: "#ff5c43", color2: "#6262ff" },
  { name: "Deep tide", color: "#003d60", color2: "#32fffc" },
  { name: "Coral current", color: "#26e2ff", color2: "#ff6666" },
  { name: "Golden hour", color: "#ffcd4f", color2: "#fde5ba" },
  { name: "Tangerine cobalt", color: "#ffad32", color2: "#4169ff" },
  { name: "Electric grove", color: "#b4ff32", color2: "#008d58" },
  { name: "Flamingo jade", color: "#ff4f9a", color2: "#36edaa" },
  { name: "Cherry pop", color: "#ff69db", color2: "#d51c46" },
  { name: "Turquoise cherry", color: "#37f0db", color2: "#ff4f64" },
  { name: "Ultraviolet tide", color: "#7516cf", color2: "#00e8d1" },
];

/** What a ghost wears while its agent is offline: the same gray for everyone. */
export const GHOST_ASLEEP = { color: "#a6aaad", color2: "#44464a" };

/** Plain body colors (one color, top to bottom). White is the default for a new agent. */
export const GHOST_COLORS: { name: string; hex: string }[] = [
  { name: "White", hex: "#ffffff" },
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

/** A new agent's ghost starts plain white. */
export const GHOST_WHITE = { color: "#ffffff", color2: "#ffffff" };

export type GhostShape = (typeof GHOST_SHAPES)[number];
export type GhostEyes = (typeof GHOST_EYES)[number];
export type GhostMouth = (typeof GHOST_MOUTHS)[number];
export type GhostHat = (typeof GHOST_HATS)[number];
export type GhostAccessory = (typeof GHOST_ACCESSORIES)[number];
export type GhostMotion = (typeof GHOST_MOTIONS)[number];

export interface GhostAppearance {
  shape: GhostShape;
  color: string; // #rrggbb, the top of the body
  /** the bottom of the body; without it the ghost is one color with a gentle shade */
  color2?: string;
  /** no longer shown (glow was removed); older saved looks may still carry it */
  glow?: boolean;
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
  const palette = pick(GHOST_PALETTES);
  return {
    shape: pick(GHOST_SHAPES),
    color: palette.color,
    color2: palette.color2,
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
  return { ...defaultAppearance(Math.random().toString(36)), hat: GHOST_HATS[Math.floor(Math.random() * GHOST_HATS.length)] };
}
