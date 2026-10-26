import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { motionReduced } from "./theme.ts";

/**
 * Small helpers for the motion layer (motion.css has the rest). They run once when something
 * changes, never on every render, and they do nothing (or a 120ms fade) under reduced motion.
 */

/** The spec's easing tokens, for the few animations that run from script. The same values are CSS variables. */
export const EASE = {
  pop: "cubic-bezier(.2,.9,.25,1.15)",
  soft: "cubic-bezier(.2,.9,.25,1.05)",
  settle: "cubic-bezier(.2,.8,.2,1)",
} as const;

/** Start a Web Animation. Reduced motion: a 120ms fade when the animation fades, otherwise nothing. */
export function play(el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | undefined {
  if (!el || typeof el.animate !== "function") return undefined;
  if (motionReduced()) {
    if (!frames.some((f) => f.opacity !== undefined)) return undefined;
    return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
  }
  return el.animate(frames, { fill: "backwards", ...options });
}

/** Runs `fn` when `value` changes after the first render, never on mount (and so never twice under StrictMode). */
export function useOnChange<T>(value: T, fn: (previous: T) => void) {
  const prev = useRef(value);
  const latest = useRef(fn);
  latest.current = fn;
  useLayoutEffect(() => {
    if (Object.is(prev.current, value)) return;
    const was = prev.current;
    prev.current = value;
    latest.current(was);
  }, [value]);
}

/** True once `value` has changed at least once since this component mounted. */
export function useChangedSinceMount(value: unknown): boolean {
  const first = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!Object.is(first.current, value)) setChanged(true);
  }, [value]);
  return changed;
}

const POP_FRAMES: Keyframe[] = [{ transform: "scale(.4)" }, { transform: "scale(1.3)", offset: 0.55 }, { transform: "scale(1)" }];
const BOUNCE_FRAMES: Keyframe[] = [{ transform: "scale(.8)" }, { transform: "scale(1.14)", offset: 0.55 }, { transform: "scale(1)" }];

/** A badge pops (.4, 1.3, 1) when its count changes. Nothing on mount, nothing when reduced. */
export function usePop(ref: RefObject<HTMLElement | null>, value: unknown) {
  useOnChange(value, () => {
    if (!motionReduced()) play(ref.current, POP_FRAMES, { duration: 320, easing: EASE.pop });
  });
}

/** A tab icon bounces (.8, 1.14, 1) when its tab becomes selected. */
export function useBounce(ref: RefObject<HTMLElement | null>, active: boolean) {
  useOnChange(active, () => {
    if (active && !motionReduced()) play(ref.current, BOUNCE_FRAMES, { duration: 380, easing: EASE.pop });
  });
}

/**
 * Keeps something on screen for `ms` after `open` turns false, so it can play its exit.
 * `mounted` is what to render; `closing` is true during the exit.
 */
export function usePresence(open: boolean, ms: number) {
  const [lingering, setLingering] = useState(false);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open) {
      wasOpen.current = true;
      setLingering(false);
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    setLingering(true);
    const t = setTimeout(() => setLingering(false), motionReduced() ? 120 : ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || lingering, closing: !open && lingering };
}

/**
 * Lists enter with a stagger: each row rises 10px and fades in, 20ms after the one before. Rows are
 * the children of every `[data-stagger]` container inside `root`.
 */
export function staggerRows(root: ParentNode | null) {
  if (!root || motionReduced()) return;
  root.querySelectorAll("[data-stagger]").forEach((list) => {
    Array.from(list.children)
      .slice(0, 14)
      .forEach((row, i) => play(row, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: i * 20, easing: EASE.settle }));
  });
}

/** Tab content cross-fades and shifts 8px in the direction of travel (phones). */
export function enterPane(el: Element | null | undefined, dx: number) {
  if (!el) return;
  play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  if (!motionReduced()) el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 300, easing: EASE.settle, fill: "backwards" });
}

/** A pane on a desktop (a list, a chat) fades in and settles up from 6px. */
export function enterDeskPane(els: Element[], rise = 6, fade = 180) {
  for (const el of els) {
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: fade, easing: "ease-out" });
    if (!motionReduced()) el.animate([{ transform: `translateY(${rise}px)` }, { transform: "none" }], { duration: 260, easing: EASE.settle, fill: "backwards" });
  }
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Which messages just arrived in a list you're already looking at. The first load, older messages
 * scrolled in above, and a chat you switch to are not new, so only those play the arrival motion.
 * A message is new when it wasn't in the list before, is newer than everything that was, and was
 * written in the last minute.
 */
export function useFreshIds(key: string, list: { id: string; createdAt: string }[] | undefined): ReadonlySet<string> {
  const st = useRef<{ key: string; known: Set<string>; fresh: Set<string>; newest: string } | null>(null);
  if (list) {
    const s = st.current;
    if (!s || s.key !== key) {
      st.current = { key, known: new Set(list.map((m) => m.id)), fresh: new Set(), newest: list.reduce((a, m) => (m.createdAt > a ? m.createdAt : a), "") };
    } else {
      let newest = s.newest;
      for (const m of list) {
        if (!s.known.has(m.id)) {
          s.known.add(m.id);
          if (m.createdAt > s.newest && Date.now() - Date.parse(m.createdAt) < 60_000) s.fresh.add(m.id);
        }
        if (m.createdAt > newest) newest = m.createdAt;
      }
      s.newest = newest;
    }
  }
  return st.current?.fresh ?? NO_IDS;
}

/** Phones: while any sheet is open the app behind it scales back (motion.css reads `data-sheet` on <html>). */
let sheets = 0;
export function useSheetBackdrop(active = true) {
  useEffect(() => {
    if (!active || !window.matchMedia("(max-width: 639px)").matches) return;
    sheets++;
    document.documentElement.dataset.sheet = "1";
    return () => {
      sheets = Math.max(0, sheets - 1);
      if (!sheets) delete document.documentElement.dataset.sheet;
    };
  }, [active]);
}
