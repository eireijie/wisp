import type { CSSProperties, ReactNode } from "react";
import type { GhostShape } from "@wisp/core";
import type { GhostMood } from "./Ghost.tsx";

/*
 * Arms for the ghost. Drop next to Ghost.tsx; styles are in ghost-arms.css.
 *
 * Each arm is one piece: a capsule drawn in its own "shoulder frame" (origin on the body's edge at
 * about mouth height, +x out of the body, +y down along the edge; the left arm is the same frame
 * mirrored). It rotates about a pivot just inside the edge, so its rounded root stays hidden in the
 * body at any angle; the round end is the hand. It's filled by clipping a rect painted with the
 * body's own gradient (userSpaceOnUse), so its color at any height is exactly the body's and there
 * is no seam. A thin rim follows its outline, hidden around the root. No filters: cheap for 20+ ghosts.
 */
export const ARM = {
  limb: "M0 -3.6 H10.6 A3.6 3.6 0 0 1 10.6 3.6 H0 A3.6 3.6 0 0 1 0 -3.6 Z",
  hand: 10.6,
  handR: 3.6,
  depth: 3.8,
  /** width of the arm's rim band, a thinner version of the body's so the arm keeps its light middle */
  rim: 1.7,
};

/**
 * Shoulders per shape: edge y, edge x per side [left, right], the edge's lean per side in degrees
 * (negative = the edge flares outward going down), and a scale that keeps arms ~12–16% of the body
 * width. The sheet's shoulders sit a little under its mouth, where it starts to flare, so the hands
 * stay clear of its cheeks.
 */
export const ARM_RIG: Record<GhostShape, { y: number; x: [number, number]; tilt: [number, number]; s: number }> = {
  classic: { y: 66, x: [30, 90], tilt: [0, 0], s: 0.95 },
  round: { y: 70, x: [22, 98], tilt: [0, 0], s: 1.08 },
  tall: { y: 58, x: [38, 82], tilt: [0, 0], s: 0.82 },
  sheet: { y: 67, x: [38.5, 81.5], tilt: [-20.4, -20.4], s: 0.86 },
  wisp: { y: 62, x: [30.4, 89], tilt: [6.9, 11.4], s: 0.98 },
};

/** Which arm pose each mood uses (the CSS class), and its still angles [left, right] (0 = out, 90 = down). Keep in step with ghost-arms.css. */
type ArmPose = "awake" | "done" | "waiting" | "working" | "asleep" | "rest";
const POSE_OF: Record<GhostMood, ArmPose> = { awake: "awake", done: "done", waiting: "waiting", working: "working", asleep: "asleep", listening: "rest", thinking: "rest", error: "rest" };
const ANGLES: Record<ArmPose, [number, number]> = { awake: [52, 52], rest: [52, 52], done: [-52, -52], waiting: [52, -30], working: [120, 120], asleep: [80, 80] };

const LAPTOP = { shell: "#343244", deck: "#4a4760", screen: "#a6e8d4" };
const MARK = "#f5c542";
const LOGO = "M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z";

type Side = "l" | "r";
const r2 = (n: number) => Math.round(n * 100) / 100;

function frame(shape: GhostShape, side: Side) {
  const rig = ARM_RIG[shape];
  const i = side === "l" ? 0 : 1;
  const flip = side === "l" ? -1 : 1;
  return {
    attr: `translate(${rig.x[i]} ${rig.y}) scale(${flip} 1) rotate(${rig.tilt[i]}) scale(${rig.s}) translate(${-ARM.depth} 0)`,
    css: `translate(${rig.x[i]}px, ${rig.y}px) scale(${flip}, 1) rotate(${rig.tilt[i]}deg) scale(${rig.s}) translate(${-ARM.depth}px, 0px)`,
  };
}

/** a point in an arm's pivot frame, after the pose rotation, in body coordinates */
function toBody(shape: GhostShape, side: Side, angle: number, [px, py]: [number, number]) {
  const rig = ARM_RIG[shape];
  const i = side === "l" ? 0 : 1;
  const a = (angle * Math.PI) / 180;
  const t = (rig.tilt[i] * Math.PI) / 180;
  const x0 = (px * Math.cos(a) - py * Math.sin(a) - ARM.depth) * rig.s;
  const y0 = (px * Math.sin(a) + py * Math.cos(a)) * rig.s;
  const x = x0 * Math.cos(t) - y0 * Math.sin(t);
  const y = x0 * Math.sin(t) + y0 * Math.cos(t);
  return { x: r2(rig.x[i] + (side === "l" ? -x : x)), y: r2(rig.y + y) };
}

/**
 * The arm layers for one ghost, to slot in at the right depths:
 *   defs   inside <defs>
 *   under  right after the body's rim path (screen glow, keyboard deck, the sign's stick)
 *   arms   right after `under`
 *   over   right after `arms`, before the face (the laptop lid, in front of the hands)
 * `grad` is the id of the body gradient, which must be userSpaceOnUse from shape.top to
 * shape.bottom; `bodyClip` the id of the clipPath holding the body path. Skip below 26px.
 */
export function ghostArms({ shape, mood, uid, grad, bodyClip, bottom }: { shape: GhostShape; mood: GhostMood; uid: string; grad: string; bodyClip: string; bottom: number }): { defs: ReactNode; under: ReactNode; arms: ReactNode; over: ReactNode } {
  const rig = ARM_RIG[shape];
  const pose = POSE_OF[mood] ?? "rest";
  const angles = ANGLES[pose];
  const sides: Side[] = ["l", "r"];
  const f = { l: frame(shape, "l"), r: frame(shape, "r") };
  const moving = (side: Side) => ({ className: `ga-arm ga-${pose} ga-${side}`, style: { "--ga-f": f[side].css } as CSSProperties });
  const rimW = r2((2 * ARM.rim) / rig.s); // a clipped stroke shows half its width
  const id = (name: string) => `${name}${uid}`;

  const defs = (
    <>
      <clipPath id={id("gk")}>{sides.map((s) => <path key={s} {...moving(s)} d={ARM.limb} />)}</clipPath>
      <clipPath id={id("gko")}><path d={ARM.limb} /></clipPath>
      {/* the rim stops around the pivot, so no line shows where the arm comes out of the body */}
      <radialGradient id={id("gkf")} gradientUnits="userSpaceOnUse" cx="0" cy="0" r={ARM.depth + 0.4}>
        <stop offset="1" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.1" />
      </radialGradient>
      {pose === "working" && (
        <radialGradient id={id("gsg")} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={LAPTOP.screen} stopOpacity="0.55" />
          <stop offset="1" stopColor={LAPTOP.screen} stopOpacity="0" />
        </radialGradient>
      )}
    </>
  );

  let under: ReactNode = null;
  let over: ReactNode = null;
  if (pose === "working") {
    // The laptop faces the ghost: we see the lid's back, and over its top edge the keyboard, lit
    // mint by the screen, with the hands resting on it.
    const hl = toBody(shape, "l", angles[0], [ARM.hand, 0]);
    const hr = toBody(shape, "r", angles[1], [ARM.hand, 0]);
    const hy = (hl.y + hr.y) / 2;
    const hand = ARM.handR * rig.s;
    const lidTop = r2(hy + hand + 0.6);
    const deckTop = r2(hy - 1.6 * rig.s);
    const w = r2(hr.x - hl.x + 18 * rig.s);
    const h = r2(Math.min(28, Math.max(18, bottom - lidTop + 1.5)));
    const [x0, x1, b0, b1, y1, c] = [60 - w / 2, 60 + w / 2, 60 - (w - 5) / 2, 60 + (w - 5) / 2, lidTop + h, 3.2];
    const lid = `M${r2(x0 + c)} ${lidTop} H${r2(x1 - c)} Q${r2(x1)} ${lidTop} ${r2(x1 - 0.3)} ${r2(lidTop + c)} L${r2(b1 + 0.2)} ${r2(y1 - c)} Q${r2(b1)} ${r2(y1)} ${r2(b1 - c)} ${r2(y1)} H${r2(b0 + c)} Q${r2(b0)} ${r2(y1)} ${r2(b0 - 0.2)} ${r2(y1 - c)} L${r2(x0 + 0.3)} ${r2(lidTop + c)} Q${r2(x0)} ${lidTop} ${r2(x0 + c)} ${lidTop} Z`;
    const [dt, db] = [(w - 11) / 2, (w - 2) / 2];
    const deck = `M${r2(60 - dt)} ${deckTop} H${r2(60 + dt)} L${r2(60 + db)} ${r2(lidTop + 1)} H${r2(60 - db)} Z`;
    const keys = [0.38, 0.75].flatMap((k, row) => {
      const ky = r2(deckTop + (lidTop - deckTop) * k);
      const half = dt + (db - dt) * k - 3;
      return Array.from({ length: 7 }, (_, i) => {
        const kx = 60 - half + (half / 3) * i;
        const lit = (i + row * 3) % 4 === 1;
        return <path key={`${row}${i}`} d={`M${r2(kx - 1.3)} ${ky} h2.6`} className={lit ? "ga-key" : undefined} style={lit ? { animationDelay: `${r2(-((i * 0.37 + row * 0.21) % 0.9))}s` } : undefined} />;
      });
    });
    under = (
      <>
        <ellipse cx="60" cy={lidTop} rx={r2(w * 0.48)} ry={r2(15 * rig.s)} fill={`url(#${id("gsg")})`} clipPath={`url(#${bodyClip})`} />
        <path d={deck} fill={LAPTOP.deck} stroke={LAPTOP.deck} strokeWidth="1.6" strokeLinejoin="round" />
        <g stroke={LAPTOP.screen} strokeOpacity="0.6" strokeWidth="1.1" strokeLinecap="round">{keys}</g>
        {[hl, hr].map((p, i) => <ellipse key={i} cx={p.x} cy={r2(hy + hand * 0.72)} rx={r2(hand * 1.05)} ry={r2(0.9 * rig.s)} fill="#000" fillOpacity="0.3" />)}
      </>
    );
    over = (
      <>
        <path d={lid} fill={LAPTOP.shell} />
        <path d={`M${r2(x0 + 3.5)} ${r2(lidTop + 0.9)} H${r2(x1 - 3.5)}`} stroke={LAPTOP.screen} strokeOpacity="0.75" strokeWidth="1.1" strokeLinecap="round" />
        <path d={LOGO} transform={`translate(60 ${r2(lidTop + h / 2)}) scale(0.14) translate(-60 -59)`} fill={LAPTOP.screen} fillOpacity="0.9" />
      </>
    );
  }
  if (pose === "waiting") {
    // the sign rides on the right arm; drawn under the hand so the fist closes over the stick, and
    // kept upright at the arm's middle angle so the bob tilts it a little, like waving it
    under = (
      <g {...moving("r")}>
        <g transform={`translate(${ARM.hand} 0) rotate(${-(angles[1] + rig.tilt[1])})`} style={{ transformBox: "view-box" }}>
          <path d="M0 7.5 V-19" stroke="#8d8291" strokeWidth="2.6" strokeLinecap="round" />
          <rect x="-9.5" y="-37" width="19" height="19" rx="5" fill={MARK} />
          <path d="M-6.2 -34.2 h5" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M-3.4 -30.4 C-3.4 -35 3.7 -35 3.7 -30.7 C3.7 -28.4 0.2 -28.3 0.2 -25.4" stroke={LAPTOP.shell} strokeWidth="2.6" fill="none" strokeLinecap="round" />
          <circle cx="0.2" cy="-21.7" r="1.5" fill={LAPTOP.shell} />
        </g>
      </g>
    );
  }

  const arms = (
    <>
      <rect x="-10" y="-10" width="140" height="140" fill={`url(#${grad})`} clipPath={`url(#${id("gk")})`} />
      {sides.map((s) => <path key={s} {...moving(s)} d={ARM.limb} fill="none" stroke={`url(#${id("gkf")})`} strokeWidth={rimW} clipPath={`url(#${id("gko")})`} />)}
    </>
  );
  return { defs, under, arms, over };
}
