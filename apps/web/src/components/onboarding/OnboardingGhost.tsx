import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import { FAMILY_COLORS } from "../../ghostFamily.ts";
import { Ghost } from "../Ghost.tsx";

export const ONBOARDING_VIOLET = FAMILY_COLORS[0];

/** Onboarding's wisp before one is picked: the classic ghost, violet. */
const ONBOARDING_LOOK: GhostAppearance = { shape: "classic", color: ONBOARDING_VIOLET, eyes: "dots", mouth: "smile", cheeks: false, hat: "none", accessory: "none", motion: "float" };

/**
 * The first wisp of onboarding: the app's own ghost (Ghost), so onboarding and the rest of Wisp
 * share one drawing. It floats and blinks, turns toward the cursor when `follow`, smiles, talks
 * while `talking`, hops once when `hop` turns on, and with `working` heads down at its laptop.
 */
export function OnboardingGhost({
  size = 128,
  talking = false,
  smiling = false,
  hop = false,
  working = false,
  follow = true,
  look,
}: {
  size?: number;
  talking?: boolean;
  smiling?: boolean;
  hop?: boolean;
  working?: boolean;
  follow?: boolean;
  /** the agent's own look once it's picked (Make me yours); violet before that */
  look?: GhostAppearance;
}) {
  return <Ghost look={look ?? ONBOARDING_LOOK} size={size} mood={working ? "working" : "awake"} happy={smiling && !working} talking={talking} hop={hop} trackPointer={follow} label="" />;
}
