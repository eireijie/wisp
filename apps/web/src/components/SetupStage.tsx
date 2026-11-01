import { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { GHOST_WHITE, type GhostAppearance } from "@wisp/core/src/appearance.ts";
import { motionReduced } from "../theme.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";
import { HarnessLogo } from "./HarnessLogo.tsx";

export type StageName = "account" | "anywhere" | "tailscale" | "address" | "look" | "harness" | "signin" | "made" | "phone";

/** Where the wisp stands on each screen (percent of the stage), how big, and its mood. */
const PLACES: Record<StageName, { x: number; y: number; size: number; mood: GhostMood; progress: number }> = {
  account: { x: 50, y: 46, size: 210, mood: "awake", progress: 44 },
  anywhere: { x: 50, y: 34, size: 170, mood: "awake", progress: 52 },
  tailscale: { x: 50, y: 34, size: 170, mood: "waiting", progress: 60 },
  address: { x: 50, y: 42, size: 180, mood: "awake", progress: 68 },
  look: { x: 50, y: 46, size: 300, mood: "awake", progress: 76 },
  harness: { x: 50, y: 46, size: 260, mood: "awake", progress: 84 },
  signin: { x: 50, y: 46, size: 220, mood: "waiting", progress: 88 },
  made: { x: 50, y: 46, size: 300, mood: "done", progress: 94 },
  phone: { x: 34, y: 46, size: 190, mood: "awake", progress: 100 },
};

/** Wisp itself, before you've made an agent: plain white. */
export const WHITE_WISP: GhostAppearance = { shape: "classic", ...GHOST_WHITE, eyes: "dots", mouth: "smile", cheeks: false, hat: "none", accessory: "none", motion: "float" };
const BOX = 300;

export interface StageScene {
  name: StageName;
  look?: GhostAppearance;
  /** the handle under the wisp */
  tag?: string;
  /** the logo of the harness it runs on */
  badge?: string;
  /** the server's address, floating under the wisp */
  address?: string;
  /** the lines to your devices are connected */
  linked?: boolean;
  /** null: nothing to go back to, because that would redo what's done */
  onBack?: (() => void) | null;
}

/** First-run setup's frame: the wisps' stage, and beside it the panel with what you do next. */
export function SetupStage({ scene, children }: { scene: StageScene; children: ReactNode }) {
  const place = PLACES[scene.name];
  const look = scene.look ?? WHITE_WISP;
  const wisp = useRef<HTMLDivElement>(null);
  // the wisp reacts when its look changes
  const seen = useRef(look);
  useEffect(() => {
    if (seen.current === look) return;
    seen.current = look;
    if (motionReduced()) return;
    wisp.current?.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.1, 0.9) rotate(-4deg)", offset: 0.35 }, { transform: "scale(0.96, 1.05) rotate(3deg)", offset: 0.7 }, { transform: "scale(1)" }],
      { duration: 600, easing: "cubic-bezier(0.2, 0.9, 0.25, 1.3)" },
    );
  }, [look]);
  return (
    <div className="setup-frame" data-testid="setup">
      <div className="setup-stage" aria-hidden>
        {scene.name === "anywhere" || scene.name === "tailscale" ? <Devices linked={!!scene.linked} /> : null}
        {scene.name === "phone" && (
          <svg className="setup-prop setup-side-phone" viewBox="0 0 70 140" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <rect x="3" y="3" width="64" height="134" rx="11" />
            <path d="M27 10h16" />
          </svg>
        )}
        <div className="setup-wisp" style={{ left: `${place.x}%`, top: `${place.y}%`, transform: `translate(-50%, -50%) scale(calc(${place.size / BOX} * var(--setup-k)))`, width: BOX, height: BOX }}>
          <div ref={wisp}>
            <Ghost look={look} size={BOX} mood={place.mood} trackPointer label="" />
          </div>
        </div>
        {scene.name === "made" && <Sparks />}
        {scene.tag && (
          <div className="setup-tag" style={{ top: `calc(${place.y}% + ${place.size / 2 + 22}px)` }}>
            @{scene.tag}
          </div>
        )}
        {scene.badge && (
          <div key={scene.badge} className="setup-badge" style={{ top: `calc(${place.y}% + ${place.size * 0.16}px)`, left: `calc(${place.x}% + ${place.size * 0.42}px)` }}>
            <HarnessLogo harness={scene.badge} size={26} />
          </div>
        )}
        {scene.address && (
          <div className="setup-address setup-prop">
            <span className="setup-live" />
            {scene.address.replace(/^https?:\/\//, "")}
          </div>
        )}
      </div>
      <div className="setup-side">
        <main className="setup-panel">
          <div className="setup-top">
            {scene.onBack && (
              <button type="button" className="setup-back" aria-label="Back" onClick={scene.onBack}>
                <ChevronLeft size={17} />
              </button>
            )}
            <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={place.progress} className="setup-track">
              <div className="setup-fill" style={{ width: `${place.progress}%` }} />
            </div>
          </div>
          <div className="setup-screen">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function Devices({ linked }: { linked: boolean }) {
  return (
    <>
      <svg className="setup-lines" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none">
        {["M50 49 C38 55 29 59 23 68", "M50 49 C62 55 71 59 77 68", "M50 49 L50 74"].map((d) => (
          <path key={d} d={d} vectorEffect="non-scaling-stroke" className={linked ? "setup-line-on" : "setup-line"} />
        ))}
      </svg>
      <Device x={23} y={68} d={<><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>} />
      <Device x={50} y={74} delay={0.1} d={<><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 20h20" /></>} />
      <Device x={77} y={68} delay={0.2} d={<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 20h8" /></>} />
    </>
  );
}

function Device({ x, y, d, delay = 0 }: { x: number; y: number; d: ReactNode; delay?: number }) {
  return (
    <svg className="setup-prop setup-device" style={{ left: `calc(${x}% - 42px)`, top: `${y}%`, animationDelay: `${delay}s` }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  );
}

const SPARKS: [number, number, number, number][] = [[30, 24, 26, 0], [68, 20, 34, 0.35], [74, 50, 20, 0.7], [24, 54, 22, 0.2]];
function Sparks() {
  return (
    <>
      {SPARKS.map(([x, y, size, delay]) => (
        <svg key={x} className="setup-spark" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${delay}s` }} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2Q13 11 22 12Q13 13 12 22Q11 13 2 12Q11 11 12 2Z" />
        </svg>
      ))}
    </>
  );
}

/** A row's state: a check that draws itself, a spinning ring, or a quiet dot. */
export function RowState({ state }: { state: "done" | "working" | "off" }) {
  return (
    <span className="setup-state" aria-label={state === "done" ? "Done" : "Waiting"}>
      {state === "done" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path className="setup-draw" d="M5 13l4 4L19 7" />
        </svg>
      ) : state === "working" ? (
        <i className="setup-ring" />
      ) : (
        <i className="setup-idle" />
      )}
    </span>
  );
}

/** A code as separate tiles that come in one after another. */
export function CodeTiles({ code }: { code: string }) {
  return (
    <div className="setup-code" aria-label={code}>
      {[...code].map((c, i) => (
        <span key={i} className={c === "-" || c === " " ? "setup-code-gap" : "setup-digit"} style={{ animationDelay: `${i * 0.07}s` }}>
          {c}
        </span>
      ))}
    </div>
  );
}
