import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import { setGazeFocus } from "../../ghostGaze.ts";
import { motionReduced } from "../../theme.ts";
import { Ghost, type GhostMood } from "../Ghost.tsx";
import { WHITE_WISP } from "../SetupStage.tsx";

/** The host before it has a colour: the old ghost's own pale default, so it reads on white pages too. */
export const HOST_LOOK: GhostAppearance = { ...WHITE_WISP, color: "#f4f1ff", color2: undefined };

/**
 * First run's host: one ghost that carries through every page. Each page draws it where it stands
 * there, and it travels in from where it stood on the page before (a shared-element move), so the
 * pages read as one place instead of hard cuts. It reacts once per event (`hostReact`), looks at
 * the field being typed in and away from a password (`useLookAtFields`), and Reduce Motion turns
 * every move into an instant swap.
 */

export type HostReaction = "hop" | "nod" | "catch" | "celebrate";

/** the spring every onboarding move uses */
export const OB_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const listeners = new Set<(kind: HostReaction) => void>();
/** The host reacts once: a hop when something lands, a nod on a pick, a catch per thing learned, one celebration at the end. */
export function hostReact(kind: HostReaction) {
  listeners.forEach((on) => on(kind));
}

/** Where the host last stood, so the next page's host can travel in from there. */
let last: { rect: DOMRect; at: number } | null = null;
const FRESH_MS = 4000;
/** The rect the host stood in a moment ago (null when it's been a while), for elements that take over from it (the chat's name pill). */
export function hostWasAt(): DOMRect | null {
  return last && Date.now() - last.at < FRESH_MS ? last.rect : null;
}
/** Test hook: forget where the host stood. */
export function resetHost() {
  last = null;
}

/** Play `el` in from `from` (another rect) to where it is now: the shared-element move. */
export function travelFrom(el: HTMLElement, from: DOMRect | null, ms = 700) {
  if (!from || motionReduced() || typeof el.animate !== "function") return;
  const to = el.getBoundingClientRect();
  if (!to.width || !from.width) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const s = from.width / to.width;
  if (Math.hypot(dx, dy) < 4 && Math.abs(s - 1) < 0.02) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: "none" }], { duration: ms, easing: OB_EASE });
}

const MOVES: Record<HostReaction, { frames: Keyframe[]; ms: number }> = {
  hop: { frames: [{ transform: "none" }, { transform: "translateY(-14%) scale(0.95, 1.06)", offset: 0.35 }, { transform: "translateY(0) scale(1.07, 0.93)", offset: 0.7 }, { transform: "none" }], ms: 520 },
  nod: { frames: [{ transform: "none" }, { transform: "rotate(-7deg)", offset: 0.35 }, { transform: "rotate(4deg)", offset: 0.7 }, { transform: "none" }], ms: 460 },
  catch: { frames: [{ transform: "none" }, { transform: "translateY(-5%) scale(1.04, 0.97)", offset: 0.4 }, { transform: "none" }], ms: 320 },
  celebrate: {
    frames: [
      { transform: "none" },
      { transform: "translateY(-18%) scale(0.94, 1.07) rotate(-4deg)", offset: 0.22 },
      { transform: "translateY(0) scale(1.08, 0.92)", offset: 0.42 },
      { transform: "translateY(-11%) scale(0.96, 1.05) rotate(4deg)", offset: 0.64 },
      { transform: "translateY(0) scale(1.05, 0.95)", offset: 0.84 },
      { transform: "none" },
    ],
    ms: 1100,
  },
};

/**
 * The host ghost at its place on this page. `travel` (on by default) brings it in from where it
 * last stood; `place` changes (a new key) move it within a page the same way.
 */
export function HostGhost({
  look,
  size,
  mood = "awake",
  happy = false,
  talking = false,
  follow = true,
  travel = true,
  className,
  style,
}: {
  look: GhostAppearance;
  size: number;
  mood?: GhostMood;
  happy?: boolean;
  talking?: boolean;
  follow?: boolean;
  travel?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [cheer, setCheer] = useState(false);
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    if (travel) travelFrom(el, hostWasAt());
    const save = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) last = { rect: r, at: Date.now() };
    };
    // the move takes ~700 ms; keep the last spot fresh after it, in case the page scrolls
    const t = setInterval(save, 500);
    return () => {
      clearInterval(t);
      save();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (kind: HostReaction) => {
      if (kind === "celebrate" || kind === "hop") {
        setCheer(true);
        clearTimeout(timer);
        timer = setTimeout(() => setCheer(false), kind === "celebrate" ? 1500 : 1000);
      }
      if (motionReduced() || !inner.current?.animate) return;
      const m = MOVES[kind];
      inner.current.animate(m.frames, { duration: m.ms, easing: OB_EASE });
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
      clearTimeout(timer);
    };
  }, []);
  return (
    <div ref={outer} className={className} style={{ width: size, height: size, ...style }} data-testid="host-ghost">
      <div ref={inner} style={{ transformOrigin: "50% 92%" }}>
        <Ghost look={look} size={size} mood={mood} happy={happy || cheer} talking={talking} trackPointer={follow} label="" />
      </div>
    </div>
  );
}

const FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea";

/**
 * While a field in `root` (or anywhere) has focus, every watching ghost looks at it; while a
 * password is being typed, they look away.
 */
export function useLookAtFields(root?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let off: ReturnType<typeof setTimeout> | undefined;
    const inside = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement && t.matches(FIELD) && (!root?.current || root.current.contains(t));
    const look = (el: HTMLElement) => {
      clearTimeout(off);
      if (el instanceof HTMLInputElement && el.type === "password") return setGazeFocus("away");
      const r = el.getBoundingClientRect();
      // toward the end of what's typed, not the middle of an empty field
      const len = (el as HTMLInputElement).value?.length ?? 0;
      setGazeFocus({ x: r.left + Math.min(r.width - 12, 14 + len * 7.5), y: r.top + r.height / 2 });
    };
    const on = (e: Event) => inside(e.target) && look(e.target);
    const leave = (e: FocusEvent) => {
      if (!inside(e.target)) return;
      clearTimeout(off);
      // moving straight to the next field shouldn't flick the eyes back to the pointer
      off = setTimeout(() => setGazeFocus(null), 120);
    };
    document.addEventListener("focusin", on);
    document.addEventListener("input", on);
    document.addEventListener("focusout", leave);
    const active = document.activeElement;
    if (inside(active)) look(active);
    return () => {
      clearTimeout(off);
      document.removeEventListener("focusin", on);
      document.removeEventListener("input", on);
      document.removeEventListener("focusout", leave);
      setGazeFocus(null);
    };
  }, [root]);
}
