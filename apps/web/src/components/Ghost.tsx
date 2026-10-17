import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { GhostAppearance, GhostShape } from "@warren/core";
import { GHOST_ASLEEP } from "@warren/core/src/appearance.ts";
import { useMotionReduced } from "../theme.ts";
import { useGhostActivity } from "../ghostActivity.ts";
import { ghostArms } from "./GhostArms.tsx";
import { registerGhost } from "../ghostGaze.ts";

/** How the ghost feels right now; follows the agent's status where it matters. */
export type GhostMood = "awake" | "listening" | "thinking" | "asleep" | "working" | "done" | "waiting" | "error";

interface ShapeDef {
  /** body path, and an alternate with the hem rippled the other way (animated between) */
  body: [string, string];
  eyes: { y: number; x: [number, number] };
  mouthY: number;
  /** top of the head, where hats sit */
  top: number;
  /** the body's lowest point; the body gradient (shared with the arms) runs from top to here */
  bottom: number;
  hatScale: number;
  /** where neckwear goes, and half the body width there */
  neck: { y: number; half: number };
  /** where its shadow sits, just under the hem */
  ground: number;
}

const swap = (d: string, a: string, b: string) => d.replaceAll(a, "§").replaceAll(b, a).replaceAll("§", b);

const CLASSIC = "M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z";
const ROUND = "M22 64 C22 38 38 26 60 26 C82 26 98 38 98 64 L98 92 Q92 100 86 92 Q80 84 74 92 Q67 100 60 92 Q53 84 46 92 Q40 100 34 92 Q28 84 22 92 Z";
const TALL = "M38 52 C38 24 47 10 60 10 C73 10 82 24 82 52 L82 102 Q76.5 110 71 102 Q65.5 94 60 102 Q54.5 110 49 102 Q43.5 94 38 102 Z";
const SHEET_A = "M42 52 C42 28 50 16 60 16 C70 16 78 28 78 52 C80 72 92 86 100 100 Q93 95 86 102 Q78 95 70 102 Q60 95 50 102 Q42 95 34 102 Q27 95 20 100 C28 86 40 72 42 52 Z";
const SHEET_B = "M42 52 C42 28 50 16 60 16 C70 16 78 28 78 52 C80 72 92 86 100 100 Q93 105 86 98 Q78 105 70 98 Q60 105 50 98 Q42 105 34 98 Q27 105 20 100 C28 86 40 72 42 52 Z";
const WISP_A = "M60 16 C80 16 90 32 90 52 C90 74 78 84 68 90 C60 95 58 104 66 108 C52 110 46 98 50 90 C36 84 30 72 30 52 C30 32 40 16 60 16 Z";
const WISP_B = "M60 16 C80 16 90 32 90 52 C90 74 80 86 70 92 C62 97 64 106 72 110 C58 110 52 100 52 92 C38 86 30 72 30 52 C30 32 40 16 60 16 Z";

export const SHAPES: Record<GhostShape, ShapeDef> = {
  classic: { body: [CLASSIC, swap(CLASSIC, "104", "88")], eyes: { y: 54, x: [50, 70] }, mouthY: 66, top: 18, bottom: 100, hatScale: 1, neck: { y: 77, half: 30 }, ground: 111 },
  round: { body: [ROUND, swap(ROUND, "100", "84")], eyes: { y: 58, x: [47, 73] }, mouthY: 70, top: 26, bottom: 96, hatScale: 1.1, neck: { y: 80, half: 37 }, ground: 107 },
  tall: { body: [TALL, swap(TALL, "110", "94")], eyes: { y: 44, x: [52, 68] }, mouthY: 56, top: 10, bottom: 106, hatScale: 0.85, neck: { y: 68, half: 22 }, ground: 115 },
  sheet: { body: [SHEET_A, SHEET_B], eyes: { y: 46, x: [53, 67] }, mouthY: 57, top: 16, bottom: 102, hatScale: 0.8, neck: { y: 64, half: 19 }, ground: 110 },
  wisp: { body: [WISP_A, WISP_B], eyes: { y: 50, x: [50, 70] }, mouthY: 62, top: 16, bottom: 109, hatScale: 1, neck: { y: 72, half: 28 }, ground: 115 },
};

// --- color helpers ------------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex: string, to: [number, number, number], t: number) {
  const [r, g, b] = rgb(hex);
  const c = (a: number, z: number) => Math.round(a + (z - a) * t);
  return `rgb(${c(r, to[0])} ${c(g, to[1])} ${c(b, to[2])})`;
}
function luminance([r, g, b]: [number, number, number]) {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const safeColor = (c: string | undefined, fallback: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback);

/** One-color ghosts (from before gradients) fade to a deeper, slightly richer shade of themselves. */
function shade(hex: string): string {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${Math.round(h * 60 + 12)} ${Math.round(Math.min(1, s + 0.12) * 100)}% ${Math.round(Math.max(0.12, l - 0.16) * 100)}%)`;
}

/** Zz and thought marks, the same warm yellow on every palette (like Paperclip's). */
const MARK = "#f5c542";
const HEART = "#ff8fab";

// --- the ghost ----------------------------------------------------------------------------------

/**
 * An animated ghost, drawn like a Paperclip agent: a two-color body with a lit center and a
 * soft rim, floating over its own shadow. Its face follows the mood: focused while working,
 * gray and dozing while offline. Animations are CSS (float, blink, moods) plus an SVG hem
 * ripple; all of it switches off with `animate={false}` or when the OS asks for reduced motion.
 */
export function Ghost({ look, size = 40, mood = "awake", animate = true, wave, tile = false, label, trackPointer = false, interactive = false, ambient = true, speakingLevel }: { look: GhostAppearance; size?: number; mood?: GhostMood; animate?: boolean; wave?: boolean; tile?: boolean; label?: string; trackPointer?: boolean; interactive?: boolean; ambient?: boolean; speakingLevel?: number }) {
  const reduced = useMotionReduced();
  const animated = animate && !reduced;
  const ambientMotion = animated && ambient;
  const touchable = interactive && size >= 24 && animated;
  const pageActivity = useGhostActivity(animated && size >= 16);
  const activity = mood === "awake" ? pageActivity : "active";
  const [poke, setPoke] = useState<{ id: number; spin: boolean; heart: boolean } | null>(null);
  const pokes = useRef({ count: 0, at: 0 });
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pokeTimer.current), []);
  useEffect(() => {
    if (!touchable) {
      clearTimeout(pokeTimer.current);
      setPoke(null);
    }
  }, [touchable]);
  const reactToPoke = () => {
    const now = Date.now();
    const count = now - pokes.current.at < 1800 ? pokes.current.count + 1 : 1;
    pokes.current = { count, at: now };
    clearTimeout(pokeTimer.current);
    setPoke((previous) => ({ id: (previous?.id ?? 0) + 1, spin: count % 5 === 0, heart: count >= 2 }));
    pokeTimer.current = setTimeout(() => setPoke(null), 800);
  };
  const happy = !!poke || mood === "done";
  const face = useRef<SVGGElement>(null);
  const root = useRef<HTMLSpanElement>(null);
  const body = useRef<SVGGElement>(null);
  const watching = animated && size >= 16 && pageActivity !== "idle" && ["awake", "waiting", "listening", "done"].includes(mood);
  useEffect(() => {
    if (!watching || !root.current || !face.current || !body.current) return;
    return registerGhost({ root: root.current, face: face.current, body: body.current, strong: trackPointer });
  }, [watching, trackPointer, mood, happy, poke?.id, look.eyes, size]);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const shape = SHAPES[look.shape] ?? SHAPES.classic;
  const asleep = mood === "asleep";
  const top = asleep ? GHOST_ASLEEP.color : safeColor(look.color, "#f4f1ff");
  const bottom = asleep ? GHOST_ASLEEP.color2 : look.color2 ? safeColor(look.color2, top) : shade(top);
  // the face sits mid-body, so read ink against the middle of the gradient
  const [r1, g1, b1] = rgb(top);
  const [r2, g2, b2] = look.color2 && !asleep ? rgb(safeColor(look.color2, top)) : asleep ? rgb(GHOST_ASLEEP.color2) : [r1 * 0.8, g1 * 0.8, b1 * 0.8];
  const dark = luminance([(r1 + r2) / 2, (g1 + g2) / 2, (b1 + b2) / 2]) < 0.16;
  const ink = dark ? "#f7f7f8" : "#1d1d1f";
  const moving = ambientMotion && look.motion !== "still";
  const motionClass = moving ? `ghost-${look.motion}${mood === "thinking" ? " ghost-fast" : ""}` : "";
  const rippling = (wave ?? size >= 44) && ambientMotion;
  const details = size >= 26; // drop tiny decorations at small sizes
  const grounded = size >= 28;
  const { x: [ex1, ex2], y: ey } = shape.eyes;
  const arms = details ? ghostArms({ shape: look.shape in SHAPES ? look.shape : "classic", mood, uid, grad: `b${uid}`, bodyClip: `c${uid}`, bottom: shape.bottom }) : null;
  const ripple = rippling ? <animate attributeName="d" dur={mood === "thinking" ? "1.4s" : "2.6s"} repeatCount="indefinite" values={`${shape.body[0]};${shape.body[1]};${shape.body[0]}`} calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" /> : null;

  return (
    <span
      ref={root}
      className={cx("ghost relative inline-grid place-items-center shrink-0 rounded-full", touchable && animated && "ghost-interactive")}
      onClick={touchable ? reactToPoke : undefined}
      data-animate={animated ? undefined : "false"}
      style={{ width: size, height: size, background: tile ? `color-mix(in srgb, ${top} 28%, transparent)` : undefined }}
      role="img"
      aria-label={label ?? "ghost"}
    >
      <svg
        // leave headroom only when there's a hat to fit; otherwise frame the ghost snugly
        viewBox={look.hat === "none" ? "4.5 8 111 111" : "-8 -18 136 140"}
        width={size}
        height={size}
        className={cx(look.glow && "ghost-glow", !ambientMotion && "ghost-glow-still")}
        style={look.glow ? ({ "--glow": bottom } as React.CSSProperties) : undefined}
        overflow="visible"
      >
        <defs>
          <linearGradient id={`b${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={shape.top} x2="0" y2={shape.bottom}>
            <stop offset="0.08" stopColor={top} />
            <stop offset="0.95" stopColor={bottom} />
          </linearGradient>
          {/* the lit "face plate": brighter in the middle, falling off toward the edges */}
          <radialGradient id={`l${uid}`} cx="0.5" cy="0.42" r="0.6">
            <stop offset="0" stopColor="white" stopOpacity={asleep ? 0.1 : 0.24} />
            <stop offset="0.65" stopColor="white" stopOpacity="0.06" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`c${uid}`}>
            <path d={shape.body[0]}>{ripple}</path>
          </clipPath>
          {arms?.defs}
        </defs>

        {grounded && <ellipse cx="60" cy={shape.ground} rx="24" ry="3.4" className={cx("ghost-ground", moving && `ghost-ground-${look.motion}`, moving && mood === "thinking" && "ghost-fast")} />}

        <g ref={body}>
          <g className="ghost-squish">
            <g className={animated ? mood === "done" ? "ga-hop" : activity === "waking" ? "ghost-startle" : undefined : undefined} style={mood === "done" ? ({ "--ga-ground": `${shape.ground}px` } as React.CSSProperties) : undefined}>
              <g key={poke?.id ?? "rest"} className={animated && poke ? poke.spin ? "ghost-poke-spin" : "ghost-poke" : undefined}>
                <g className={cx(touchable && !poke && mood === "awake" && activity === "active" && "ghost-greeting", mood === "listening" && "ghost-listening")}>
                  <g className={cx(motionClass, animated && mood === "waiting" && "ghost-waiting", animated && mood === "error" && "ghost-error")}>
                    <path d={shape.body[0]} fill={`url(#b${uid})`}>
                      {ripple}
                    </path>
                    <path d={shape.body[0]} fill={`url(#l${uid})`}>
                      {ripple}
                    </path>
                    {/* a soft rim just inside the edge, so the body reads as rounded */}
                    <path d={shape.body[0]} fill="none" stroke="black" strokeOpacity="0.1" strokeWidth="7" clipPath={`url(#c${uid})`}>
                      {ripple}
                    </path>
                    {arms?.under}
                    {arms?.arms}
                    {arms?.over}

                    {details && mood !== "working" && [-1, 1].map((side) => mood === "waiting" && side === 1 ? null : (
                      <g key={side} transform={`translate(${60 + side * (shape.neck.half + 1)} ${shape.neck.y})`}>
                        <g className={cx("ghost-arm", side === 1 ? "ghost-arm-right" : "ghost-arm-left", mood === "done" && "ghost-arm-cheer")}>
                          <ellipse cx={side * 2} cy="0" rx="6" ry="4.5" fill={top} stroke="black" strokeOpacity="0.1" strokeWidth="1.2" />
                          <ellipse cx={side * 2} cy="-1.4" rx="4" ry="1.5" fill="white" opacity="0.2" />
                        </g>
                      </g>
                    ))}
                    <g ref={face}>
                      <g transform={mood === "listening" ? "translate(0 -2)" : mood === "working" && !happy ? "translate(0 3)" : undefined}>
                        {(look.cheeks || size >= 40) && !asleep && (
                          <>
                            <ellipse cx={ex1 - 4} cy={ey + 8} rx="4.5" ry="2.6" fill="#ff8fab" opacity={look.cheeks ? 0.5 : 0.18} />
                            <ellipse cx={ex2 + 4} cy={ey + 8} rx="4.5" ry="2.6" fill="#ff8fab" opacity={look.cheeks ? 0.5 : 0.18} />
                          </>
                        )}

                        <g className={activity === "idle" && !happy ? "ghost-drowsy" : "ghost-alert"} style={{ transformOrigin: `60px ${ey}px` }}>
                          <Eyes details={details} style={mood === "listening" ? "big" : happy ? "happy" : asleep ? "closed" : mood === "error" ? "dizzy" : look.eyes} x={[ex1, ex2]} y={ey} ink={ink} blink={ambientMotion && details && !asleep && activity !== "idle"} thinking={mood === "thinking"} working={mood === "working" && !happy} />
                        </g>
                        {speakingLevel !== undefined ? <ellipse cx="60" cy={shape.mouthY + 1} rx={animated ? 3.4 + Math.min(1, Math.max(0, speakingLevel)) * 1.5 : 3.4} ry={animated ? 1 + Math.min(1, Math.max(0, speakingLevel)) * 5 : 2.5} fill={ink} /> : (look.accessory !== "mustache" || look.mouth === "none") && <Mouth style={happy ? "open" : mood === "error" ? "wavy" : asleep || mood === "thinking" || mood === "working" ? "flat" : look.mouth} x={60} y={shape.mouthY} ink={ink} />}
                        {asleep && details && <path d={`M63.5 ${shape.mouthY + 2.2} q1.7 3.2 0 4.8 q-1.7 -1.6 0 -4.8 Z`} fill="#e8f6ff" opacity="0.95" />}
                      </g>
                    </g>
                    {look.accessory !== "none" && <Accessory kind={look.accessory} shape={shape} />}
                    {look.hat !== "none" && (
                      <g transform={`translate(60 ${shape.top}) scale(${shape.hatScale})`}>
                        <Hat kind={look.hat} animate={ambientMotion} />
                      </g>
                    )}
                    {mood === "error" && details && (
                      <path d={`M${ex2 + 5} ${shape.top + 8} c-1 4 -5 7 -4 10 c1 4 7 4 7 0 c0 -3 -2 -7 -3 -10 Z`} fill="#a9dfff" stroke="#e4f6ff" strokeWidth="0.7" />
                    )}
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
        {poke?.heart && size >= 24 && (
          <path key={`heart${poke.id}`} d={`M88 ${shape.top + 11} c-15 -9 -10 -20 -2.5 -14 c7.5 -6 12.5 5 2.5 14 Z`} fill={HEART} className={animated ? "ghost-heart" : undefined} />
        )}
        {mood === "done" && details && (
          <g fill={MARK}>
            {SPARKLES.map(([x, y, r, delay], i) => (
              <path key={i} d={sparkle(x, shape.top + y, r)} className={animated ? "ga-sparkle" : undefined} style={{ animationDelay: `${delay}s` }} />
            ))}
          </g>
        )}

        {asleep && details && (
          <g fill={MARK} fontFamily="ui-rounded, system-ui, sans-serif" fontWeight="800">
            <text x="92" y={shape.top + 6} fontSize="15" className={ambientMotion ? "ghost-z" : undefined}>
              z
            </text>
            <text x="101" y={shape.top - 5} fontSize="11" className={ambientMotion ? "ghost-z ghost-z2" : undefined}>
              z
            </text>
          </g>
        )}
        {mood === "thinking" && details && (
          <g fill={MARK}>
            {[0, 1, 2].map((i) => (
              <circle key={i} cx={90 + i * 7} cy={shape.top - 2 - i * 5} r={2.4 + i * 0.6} className={ambientMotion ? "ghost-think" : undefined} style={{ animationDelay: `${i * 0.25}s` }} />
            ))}
          </g>
        )}
      </svg>
    </span>
  );
}

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** where the "done" sparkles twinkle: x, y below the head's top, size, delay */
const SPARKLES: [number, number, number, number][] = [[24, 4, 5, 0], [97, 2, 6, 0.35], [106, 34, 4, 0.7], [13, 38, 4.5, 0.2], [50, -9, 3.5, 0.55], [80, -8, 4, 0.9], [104, 62, 3, 0.45], [16, 66, 3.2, 1.05]];
const sparkle = (x: number, y: number, r: number) => {
  const k = r * 0.18;
  return `M${x} ${y - r} Q${x + k} ${y - k} ${x + r} ${y} Q${x + k} ${y + k} ${x} ${y + r} Q${x - k} ${y + k} ${x - r} ${y} Q${x - k} ${y - k} ${x} ${y - r} Z`;
};

function Eyes({ style, x, y, ink, blink, thinking, working, details }: { details: boolean; style: GhostAppearance["eyes"] | "closed" | "dizzy"; x: [number, number]; y: number; ink: string; blink: boolean; thinking: boolean; working: boolean }) {
  const look = thinking ? { dx: 1.4, dy: -1.6 } : { dx: 0, dy: working ? 2.5 : 0 };
  const one = (cx: number, i: number): ReactNode => {
    switch (style) {
      case "dizzy":
        return <path d={`M${cx - 5} ${y} c0 -7 11 -7 11 0 c0 6 -9 6 -9 0 c0 -3 6 -3 6 0 q0 3 -3 1`} stroke={ink} strokeWidth="1.8" fill="none" strokeLinecap="round" />;
      case "closed":
        return <path d={`M${cx - 4.5} ${y} Q${cx} ${y + 3.6} ${cx + 4.5} ${y}`} stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" />;
      case "happy":
        return <path d={`M${cx - 4.8} ${y + 1.5} Q${cx} ${y - 4.5} ${cx + 4.8} ${y + 1.5}`} stroke={ink} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
      case "big":
        return (
          <>
            <circle cx={cx} cy={y} r="6.2" fill="white" />
            <g data-ghost-pupil>
              <circle cx={cx + look.dx} cy={y + 0.5 + look.dy} r="3.6" fill="#2a2340" />
              {details && <g data-ghost-shine><circle cx={cx + 1.4 + look.dx} cy={y - 1 + look.dy} r="1.2" fill="white" /></g>}
            </g>
          </>
        );
      case "sparkle":
        return (
          <g data-ghost-pupil>
            <ellipse cx={cx + look.dx * 0.5} cy={y + look.dy * 0.5} rx="4.4" ry="5.6" fill={ink} />
            <g data-ghost-shine>
              <circle cx={cx + 1.4} cy={y - 2} r="1.6" fill="white" opacity="0.95" />
              <circle cx={cx - 1.4} cy={y + 2} r="0.9" fill="white" opacity="0.8" />
            </g>
          </g>
        );
      case "wink":
        return i === 1 ? (
          <path d={`M${cx - 4.6} ${y} Q${cx} ${y - 3.6} ${cx + 4.6} ${y}`} stroke={ink} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        ) : (
          <g data-ghost-pupil><ellipse cx={cx} cy={y} rx="3.4" ry="4.4" fill={ink} /></g>
        );
      default:
        return (
          <g data-ghost-pupil>
            <ellipse cx={cx + look.dx * 0.6} cy={y + look.dy * 0.6} rx="3.9" ry="4.9" fill={ink} />
            {details && <g data-ghost-shine fill="white">
              <circle cx={cx + 1.3 + look.dx * 0.6} cy={y - 1.8 + look.dy * 0.6} r="1.4" opacity="0.95" />
              <circle cx={cx - 1.2 + look.dx * 0.6} cy={y + 1.9 + look.dy * 0.6} r="0.7" opacity="0.8" />
            </g>}
          </g>
        );
    }
  };
  const canBlink = blink && (style === "dots" || style === "big" || style === "sparkle");
  return (
    <g className={canBlink ? "ghost-blink" : undefined}>
      {one(x[0], 0)}
      {one(x[1], 1)}
    </g>
  );
}

function Mouth({ style, x, y, ink }: { style: GhostAppearance["mouth"] | "flat" | "wavy"; x: number; y: number; ink: string }) {
  switch (style) {
    case "wavy":
      return <path d={`M${x - 5} ${y + 1} q1.7 -3 3.4 0 t3.4 0 t3.4 0`} stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />;
    case "flat": // concentrating, or dozing
      return <path d={`M${x - 3.2} ${y + 1.2} L${x + 3.2} ${y + 1.2}`} stroke={ink} strokeWidth="2.2" strokeLinecap="round" />;
    case "open":
      return (
        <g>
          <ellipse cx={x} cy={y + 1} rx="3.4" ry="4" fill={ink} />
          <ellipse cx={x} cy={y + 3} rx="2.2" ry="1.4" fill="#ff7a93" />
        </g>
      );
    case "cat":
      return <path d={`M${x - 5.5} ${y} Q${x - 2.75} ${y + 3.6} ${x} ${y} Q${x + 2.75} ${y + 3.6} ${x + 5.5} ${y}`} stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />;
    case "fangs":
      return (
        <g>
          <path d={`M${x - 6} ${y} Q${x} ${y + 4.5} ${x + 6} ${y}`} stroke={ink} strokeWidth="2.1" fill="none" strokeLinecap="round" />
          <path d={`M${x - 4} ${y + 1.6} l1.4 3.6 l1.4 -3.2 Z M${x + 1.2} ${y + 1.9} l1.4 3.2 l1.4 -3.6 Z`} fill="white" stroke={ink} strokeWidth="0.6" strokeLinejoin="round" />
        </g>
      );
    case "tongue":
      return (
        <g>
          <path d={`M${x - 5} ${y} Q${x} ${y + 4} ${x + 5} ${y}`} stroke={ink} strokeWidth="2.1" fill="none" strokeLinecap="round" />
          <path d={`M${x + 0.2} ${y + 1.6} q0 5 3.2 5 q3.2 0 2.6 -5.8 Z`} fill="#ff7a93" />
        </g>
      );
    case "none":
      return null;
    default:
      return <path d={`M${x - 4.5} ${y} Q${x} ${y + 4.2} ${x + 4.5} ${y}`} stroke={ink} strokeWidth="2.2" fill="none" strokeLinecap="round" />;
  }
}

/** Hats are drawn around the head's top center at (0, 0); negative y is up. */
function Hat({ kind, animate }: { kind: GhostAppearance["hat"]; animate: boolean }) {
  switch (kind) {
    case "tophat":
      return (
        <g>
          <rect x="-13" y="-25" width="26" height="25" rx="3" fill="#2b2735" />
          <rect x="-13" y="-9" width="26" height="5" fill="#e5484d" />
          <rect x="-21" y="-2" width="42" height="5.5" rx="2.75" fill="#2b2735" />
        </g>
      );
    case "party":
      return (
        <g>
          <path d="M-12 3 L12 3 L0 -27 Z" fill="#ff8fab" />
          <path d="M-8.4 -6 L6.6 -6.4 M-4.5 -15.6 L3.2 -15.8" stroke="#ffd166" strokeWidth="3" strokeLinecap="round" />
          <circle cx="0" cy="-28" r="4" fill="#ffd166" />
        </g>
      );
    case "beanie":
      return (
        <g>
          <path d="M-21 6 Q-21 -16 0 -16 Q21 -16 21 6 Z" fill="#5b8def" />
          <rect x="-22.5" y="0" width="45" height="8" rx="4" fill="#3f6fd8" />
          <circle cx="0" cy="-17" r="5" fill="#f8fafc" />
        </g>
      );
    case "crown":
      return (
        <g>
          <path d="M-15 3 L-15 -12 L-7.5 -4.5 L0 -17 L7.5 -4.5 L15 -12 L15 3 Z" fill="#ffcf3f" stroke="#e0a800" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="0" cy="-4" r="2.4" fill="#ff5d73" />
          <circle cx="-9" cy="-1.5" r="1.7" fill="#4dabf7" />
          <circle cx="9" cy="-1.5" r="1.7" fill="#4dabf7" />
        </g>
      );
    case "witch":
      return (
        <g>
          <path d="M-13 1 L-2 -30 Q4 -36 13 -30 Q5 -27 3 -22 L13 1 Z" fill="#4b2e83" />
          <rect x="-13" y="-5" width="26" height="4.5" fill="#ffb703" />
          <ellipse cx="0" cy="2" rx="27" ry="5" fill="#4b2e83" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path d="M-28 24 C-30 -10 30 -10 28 24" stroke="#2b2735" strokeWidth="5" fill="none" strokeLinecap="round" />
          <rect x="-34" y="16" width="10" height="16" rx="4.5" fill="#ff6b6b" />
          <rect x="24" y="16" width="10" height="16" rx="4.5" fill="#ff6b6b" />
        </g>
      );
    case "bow":
      return (
        <g transform="translate(15 5) rotate(18)">
          <path d="M0 0 L-10 -7 L-10 7 Z M0 0 L10 -7 L10 7 Z" fill="#ff6fa3" strokeLinejoin="round" />
          <circle r="3" fill="#ff3d7f" />
        </g>
      );
    case "halo":
      return <ellipse cx="0" cy="-11" rx="16" ry="4.5" fill="none" stroke="#ffd84d" strokeWidth="3.6" className={animate ? "ghost-halo" : undefined} />;
    case "flower":
      return (
        <g transform="translate(14 5)">
          {[0, 72, 144, 216, 288].map((a) => (
            <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 4.2} cy={Math.sin((a * Math.PI) / 180) * 4.2} r="3.6" fill="#ffffff" stroke="#f1e7ff" strokeWidth="0.6" />
          ))}
          <circle r="2.9" fill="#ffc83d" />
        </g>
      );
    case "propeller":
      return (
        <g>
          <path d="M-19 6 Q-19 -13 0 -13 Q19 -13 19 6 Z" fill="#ff5d73" />
          <path d="M-19 6 Q-19 -13 0 -13 L0 6 Z" fill="#ffd166" />
          <rect x="-1.2" y="-21" width="2.4" height="9" fill="#2b2735" />
          <g transform="translate(0 -21)">
            <g className={animate ? "ghost-spin" : undefined}>
              <ellipse cx="-7" cy="0" rx="7" ry="2.2" fill="#4dabf7" />
              <ellipse cx="7" cy="0" rx="7" ry="2.2" fill="#22c55e" />
            </g>
          </g>
        </g>
      );
    default:
      return null;
  }
}

function Accessory({ kind, shape }: { kind: GhostAppearance["accessory"]; shape: ShapeDef }) {
  const {
    eyes: {
      x: [a, b],
      y,
    },
    neck,
    mouthY,
  } = shape;
  switch (kind) {
    case "glasses":
      return (
        <g stroke="#2b2735" strokeWidth="2" fill="white" fillOpacity="0.18">
          <circle cx={a} cy={y} r="7" />
          <circle cx={b} cy={y} r="7" />
          <path d={`M${a + 7} ${y} Q60 ${y - 3} ${b - 7} ${y}`} fill="none" />
        </g>
      );
    case "sunglasses":
      return (
        <g>
          <rect x={a - 8} y={y - 5.5} width="16" height="11" rx="4" fill="#1f1d2b" />
          <rect x={b - 8} y={y - 5.5} width="16" height="11" rx="4" fill="#1f1d2b" />
          <path d={`M${a + 8} ${y - 2} L${b - 8} ${y - 2}`} stroke="#1f1d2b" strokeWidth="2.2" />
          <path d={`M${a - 4.5} ${y - 2.5} l3 -1.5 M${b - 4.5} ${y - 2.5} l3 -1.5`} stroke="white" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
        </g>
      );
    case "monocle":
      return (
        <g stroke="#c9a227" fill="none">
          <circle cx={b} cy={y} r="7" strokeWidth="2.2" fill="white" fillOpacity="0.2" />
          <path d={`M${b + 5} ${y + 5} Q${b + 12} ${y + 12} ${b + 7} ${y + 22}`} strokeWidth="1.2" />
        </g>
      );
    case "bowtie":
      return (
        <g>
          <path d={`M60 ${neck.y} L49 ${neck.y - 6.5} L49 ${neck.y + 6.5} Z M60 ${neck.y} L71 ${neck.y - 6.5} L71 ${neck.y + 6.5} Z`} fill="#e5484d" strokeLinejoin="round" />
          <rect x="57" y={neck.y - 3.2} width="6" height="6.4" rx="1.6" fill="#c2333a" />
        </g>
      );
    case "scarf":
      return (
        <g>
          <rect x={60 - neck.half + 1} y={neck.y - 4.5} width={(neck.half - 1) * 2} height="9" rx="4.5" fill="#ff8f5a" />
          <path d={`M${60 - neck.half + 8} ${neck.y - 4.5} v9 M${60 - neck.half + 16} ${neck.y - 4.5} v9 M${60 + neck.half - 10} ${neck.y - 4.5} v9`} stroke="#ffd166" strokeWidth="2.4" />
          <rect x={60 + neck.half * 0.25} y={neck.y + 1} width="8" height="18" rx="3.5" fill="#ff8f5a" transform={`rotate(-10 ${60 + neck.half * 0.25} ${neck.y})`} />
        </g>
      );
    case "tie":
      return (
        <g>
          <path d={`M56.5 ${neck.y - 4} L63.5 ${neck.y - 4} L62 ${neck.y + 1.5} L58 ${neck.y + 1.5} Z`} fill="#2563eb" />
          <path d={`M58 ${neck.y + 1.5} L62 ${neck.y + 1.5} L65 ${neck.y + 19} L60 ${neck.y + 24} L55 ${neck.y + 19} Z`} fill="#3b82f6" />
        </g>
      );
    case "mustache": {
      const m = mouthY - 1.5;
      return <path d={`M60 ${m} Q52 ${m - 5} 46 ${m - 1} Q44 ${m + 3.5} 48.5 ${m + 3} Q54 ${m + 1.6} 60 ${m + 2.2} Q66 ${m + 1.6} 71.5 ${m + 3} Q76 ${m + 3.5} 74 ${m - 1} Q68 ${m - 5} 60 ${m} Z`} fill="#3a2a20" />;
    }
    default:
      return null;
  }
}
