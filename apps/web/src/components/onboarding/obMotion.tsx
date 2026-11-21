import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMotionReduced } from "../../theme.ts";

/**
 * Small moving parts the first-run pages share: a selection that slides between choices, text
 * that types in, a block that slides open, a check that draws, and a count that ticks up. Each
 * one is instant under Reduce Motion.
 */

/** The outline that slides to the picked row of an `.ob-slide` list (rows marked aria-checked="true"). */
export function SlideMark({ list, pick }: { list: RefObject<HTMLElement | null>; pick: unknown }) {
  const [at, setAt] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = list.current?.querySelector<HTMLElement>(':scope > [aria-checked="true"]');
      setAt(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (list.current) ro?.observe(list.current);
    return () => ro?.disconnect();
  }, [list, pick]);
  return <span aria-hidden className="ob-slide-mark" style={{ top: at?.top ?? 0, height: at?.height ?? 0, opacity: at ? 1 : 0 }} />;
}

/** Text that types in, a few characters a frame; all at once under Reduce Motion. Calls `onDone` when it's all there. */
export function Typed({ text, cps = 60, className, onDone, render }: { text: string; cps?: number; className?: string; onDone?: () => void; render?: (shown: string, done: boolean) => ReactNode }) {
  const reduced = useMotionReduced();
  const [n, setN] = useState(reduced ? text.length : 0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (reduced) {
      setN(text.length);
      done.current?.();
      return;
    }
    setN(0);
    const start = performance.now();
    let frame = 0;
    const step = () => {
      const next = Math.min(text.length, Math.floor(((performance.now() - start) / 1000) * cps));
      setN(next);
      if (next < text.length) frame = requestAnimationFrame(step);
      else done.current?.();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, cps, reduced]);
  const finished = n >= text.length;
  const shown = text.slice(0, n);
  return (
    <span className={className} aria-label={text}>
      <span aria-hidden className={finished ? undefined : "ob-caret"}>
        {render ? render(shown, finished) : shown}
      </span>
    </span>
  );
}

/** A block that slides open (height and fade) when `open`, and closed again when not. */
export function SlideOpen({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="ob-open" data-open={open} aria-hidden={!open || undefined} inert={!open || undefined}>
      <div>{children}</div>
    </div>
  );
}

/** The check that draws itself in. */
export function DrawnCheck({ size = 16, color = "var(--ok)" }: { size?: number; color?: string }) {
  return (
    <svg className="ob-draw shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A number that ticks up to `to` one step at a time (instantly under Reduce Motion). */
export function useCountUp(to: number, stepMs = 90): number {
  const reduced = useMotionReduced();
  const [n, setN] = useState(to);
  useEffect(() => {
    if (reduced || n === to) return void (reduced && setN(to));
    const t = setTimeout(() => setN((c) => (c < to ? c + 1 : to)), stepMs);
    return () => clearTimeout(t);
  }, [n, to, reduced, stepMs]);
  return reduced ? to : n;
}

/**
 * Items that arrive together are let in one at a time: returns how many of `count` to show,
 * stepping up every `gapMs` (all at once under Reduce Motion). Fewer items (one removed) show at once.
 */
export function useOneByOne(count: number, gapMs = 160): number {
  const reduced = useMotionReduced();
  const [shown, setShown] = useState(count);
  useEffect(() => {
    if (reduced || shown >= count) return void (shown !== count && setShown(count));
    const t = setTimeout(() => setShown((n) => Math.min(count, n + 1)), gapMs);
    return () => clearTimeout(t);
  }, [count, shown, gapMs, reduced]);
  return Math.min(shown, count);
}
