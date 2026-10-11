import { useId, type ReactNode } from "react";
import type { GhostAppearance, GhostShape } from "@warren/core";

/** How the ghost feels right now; follows the agent's status where it matters. */
export type GhostMood = "awake" | "thinking" | "asleep";

interface ShapeDef {
  /** body path, and an alternate with the hem rippled the other way (animated between) */
  body: [string, string];
  eyes: { y: number; x: [number, number] };
  mouthY: number;
  /** top of the head, where hats sit */
  top: number;
  hatScale: number;
  /** where neckwear goes, and half the body width there */
  neck: { y: number; half: number };
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
  classic: { body: [CLASSIC, swap(CLASSIC, "104", "88")], eyes: { y: 54, x: [50, 70] }, mouthY: 66, top: 18, hatScale: 1, neck: { y: 77, half: 30 } },
  round: { body: [ROUND, swap(ROUND, "100", "84")], eyes: { y: 58, x: [47, 73] }, mouthY: 70, top: 26, hatScale: 1.1, neck: { y: 80, half: 37 } },
  tall: { body: [TALL, swap(TALL, "110", "94")], eyes: { y: 44, x: [52, 68] }, mouthY: 56, top: 10, hatScale: 0.85, neck: { y: 68, half: 22 } },
  sheet: { body: [SHEET_A, SHEET_B], eyes: { y: 46, x: [53, 67] }, mouthY: 57, top: 16, hatScale: 0.8, neck: { y: 64, half: 19 } },
  wisp: { body: [WISP_A, WISP_B], eyes: { y: 50, x: [50, 70] }, mouthY: 62, top: 16, hatScale: 1, neck: { y: 72, half: 28 } },
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
function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const safeColor = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : "#f4f1ff");

// --- the ghost ----------------------------------------------------------------------------------

/**
 * An animated ghost. Animations are CSS (float, blink, moods) plus an SVG hem ripple; all of
 * it switches off with `animate={false}` or when the OS asks for reduced motion.
 */
export function Ghost({ look, size = 40, mood = "awake", animate = true, wave, tile = true, label }: { look: GhostAppearance; size?: number; mood?: GhostMood; animate?: boolean; wave?: boolean; tile?: boolean; label?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const shape = SHAPES[look.shape] ?? SHAPES.classic;
  const color = safeColor(look.color);
  const dark = luminance(color) < 0.3;
  const ink = dark ? "#f7f5ff" : "#2a2340";
  const asleep = mood === "asleep";
  const motionClass = !animate || look.motion === "still" ? "" : `ghost-${look.motion}${mood === "thinking" ? " ghost-fast" : ""}`;
  const rippling = (wave ?? size >= 44) && animate && !prefersReducedMotion();
  const details = size >= 26; // drop tiny decorations at small sizes
  const { x: [ex1, ex2], y: ey } = shape.eyes;

  return (
    <span
      className="ghost relative inline-grid place-items-center shrink-0 rounded-full"
      style={{ width: size, height: size, background: tile ? `color-mix(in srgb, ${color} ${dark ? 30 : 34}%, transparent)` : undefined }}
      role="img"
      aria-label={label ?? "ghost"}
    >
      <svg
        // leave headroom only when there's a hat to fit; otherwise frame the ghost snugly
        viewBox={look.hat === "none" ? "8 0 104 116" : "-6 -18 132 136"}
        width={size}
        height={size}
        className={look.glow ? "ghost-glow" : undefined}
        style={look.glow ? ({ "--glow": color } as React.CSSProperties) : undefined}
        overflow="visible"
      >
        <defs>
          <linearGradient id={`b${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={mix(color, [255, 255, 255], dark ? 0.18 : 0.55)} />
            <stop offset="1" stopColor={color} />
          </linearGradient>
        </defs>
        <g className={motionClass} style={{ opacity: asleep ? 0.74 : 1 }}>
          <path d={shape.body[0]} fill={`url(#b${uid})`} stroke={mix(color, [40, 30, 70], dark ? 0.2 : 0.5)} strokeWidth="2.4" strokeLinejoin="round">
            {rippling && <animate attributeName="d" dur={mood === "thinking" ? "1.4s" : "2.6s"} repeatCount="indefinite" values={`${shape.body[0]};${shape.body[1]};${shape.body[0]}`} calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
          </path>
          <ellipse cx={ex1 - 2} cy={shape.top + 14} rx="9" ry="5" fill="white" opacity={dark ? 0.12 : 0.45} />

          {look.cheeks && !asleep && (
            <>
              <ellipse cx={ex1 - 4} cy={ey + 8} rx="4.5" ry="2.6" fill="#ff8fab" opacity="0.5" />
              <ellipse cx={ex2 + 4} cy={ey + 8} rx="4.5" ry="2.6" fill="#ff8fab" opacity="0.5" />
            </>
          )}

          <Eyes style={asleep ? "closed" : look.eyes} x={[ex1, ex2]} y={ey} ink={ink} blink={animate && details && !asleep} thinking={mood === "thinking"} />
          {(look.accessory !== "mustache" || look.mouth === "none") && <Mouth style={asleep ? "smile" : look.mouth} x={60} y={shape.mouthY} ink={ink} />}
          {look.accessory !== "none" && <Accessory kind={look.accessory} shape={shape} />}
          {look.hat !== "none" && (
            <g transform={`translate(60 ${shape.top}) scale(${shape.hatScale})`}>
              <Hat kind={look.hat} animate={animate} />
            </g>
          )}
        </g>

        {asleep && details && animate && (
          <g fill={ink} fontFamily="ui-rounded, system-ui, sans-serif" fontWeight="700">
            <text x="92" y={shape.top + 6} fontSize="15" className="ghost-z">
              z
            </text>
            <text x="100" y={shape.top - 4} fontSize="11" className="ghost-z ghost-z2">
              z
            </text>
          </g>
        )}
        {mood === "thinking" && details && (
          <g fill={dark ? color : mix(color, [40, 30, 70], 0.45)}>
            {[0, 1, 2].map((i) => (
              <circle key={i} cx={90 + i * 7} cy={shape.top - 2 - i * 5} r={2.4 + i * 0.6} className={animate ? "ghost-think" : undefined} style={{ animationDelay: `${i * 0.25}s` }} />
            ))}
          </g>
        )}
      </svg>
    </span>
  );
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function Eyes({ style, x, y, ink, blink, thinking }: { style: GhostAppearance["eyes"] | "closed"; x: [number, number]; y: number; ink: string; blink: boolean; thinking: boolean }) {
  const look = thinking ? { dx: 1.4, dy: -1.6 } : { dx: 0, dy: 0 };
  const one = (cx: number, i: number): ReactNode => {
    switch (style) {
      case "closed":
        return <path d={`M${cx - 4.5} ${y} Q${cx} ${y + 3.6} ${cx + 4.5} ${y}`} stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" />;
      case "happy":
        return <path d={`M${cx - 4.8} ${y + 1.5} Q${cx} ${y - 4.5} ${cx + 4.8} ${y + 1.5}`} stroke={ink} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
      case "big":
        return (
          <>
            <circle cx={cx} cy={y} r="6.2" fill="white" />
            <circle cx={cx + look.dx} cy={y + 0.5 + look.dy} r="3.6" fill="#2a2340" />
            <circle cx={cx + 1.4 + look.dx} cy={y - 1 + look.dy} r="1.2" fill="white" />
          </>
        );
      case "sparkle":
        return (
          <>
            <ellipse cx={cx + look.dx * 0.5} cy={y + look.dy * 0.5} rx="4.4" ry="5.6" fill={ink} />
            <circle cx={cx + 1.4} cy={y - 2} r="1.6" fill="white" opacity="0.95" />
            <circle cx={cx - 1.4} cy={y + 2} r="0.9" fill="white" opacity="0.8" />
          </>
        );
      case "wink":
        return i === 1 ? (
          <path d={`M${cx - 4.6} ${y} Q${cx} ${y - 3.6} ${cx + 4.6} ${y}`} stroke={ink} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        ) : (
          <ellipse cx={cx} cy={y} rx="3.4" ry="4.4" fill={ink} />
        );
      default:
        return <ellipse cx={cx + look.dx * 0.6} cy={y + look.dy * 0.6} rx="3.4" ry="4.4" fill={ink} />;
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

function Mouth({ style, x, y, ink }: { style: GhostAppearance["mouth"]; x: number; y: number; ink: string }) {
  switch (style) {
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
