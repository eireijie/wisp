import type { GhostAppearance } from "@wisp/core";

/** The colours offered when a ghost is made (onboarding's Make me yours); each ghost shades its own into a gradient. */
export const FAMILY_COLORS = ["#a98bf5", "#3cc0a6", "#f2a04a", "#6aa2f5", "#ef7fa8", "#cfd36a"] as const;

function hash(s: string) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 99991;
  return h;
}
const hex = (c: string | undefined) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : undefined);
function chroma(c: string) {
  const n = parseInt(c.slice(1), 16);
  const v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(...v) - Math.min(...v);
}
function light(c: string) {
  const n = parseInt(c.slice(1), 16);
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
}

/**
 * One accent colour for an agent (call screen, agent tint): the look's more vivid colour, or a
 * colour picked from the seed for white and near-gray looks, so accents never come out white.
 */
export function familyColor(look: Pick<GhostAppearance, "color" | "color2"> | undefined, seed: string): string {
  const a = hex(look?.color);
  const b = hex(look?.color2);
  const best = [a, b].filter((c): c is string => !!c).sort((x, y) => chroma(y) - chroma(x))[0];
  if (best && chroma(best) >= 40 && light(best) > 0.2) return best;
  if (best && chroma(best) < 40 && light(best) < 0.55) return best; // a deliberate dark or slate ghost
  return FAMILY_COLORS[hash(seed || "agent") % FAMILY_COLORS.length];
}
