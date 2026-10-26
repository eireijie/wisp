import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "./ui.tsx";

const KEY = "wisp.rightPaneWidth";
export const PANE_DEFAULT = 380;
const PANE_MIN = 300;
const PANE_MAX = 720;

function stored(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= PANE_MIN ? n : PANE_DEFAULT;
  } catch {
    return PANE_DEFAULT;
  }
}

function remember(w: number) {
  try {
    if (w === PANE_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(w)));
  } catch {}
}

/** The widest the pane may get: never more than 60% of the window, so the chat stays usable. */
const maxWidth = () => Math.max(PANE_MIN, Math.min(PANE_MAX, Math.round((typeof window === "undefined" ? 1200 : window.innerWidth) * 0.6)));
const clamp = (w: number) => Math.min(maxWidth(), Math.max(PANE_MIN, w));

/**
 * The pane beside a channel (thread, an agent's details, the member list), Buzz style: drag its
 * left edge to resize, double-click the edge to reset. One width for all of them, remembered in
 * this browser. Full screen on a phone.
 */
export function RightPane({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [width, setWidth] = useState(() => clamp(stored()));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);

  // keep it inside the window when the window shrinks
  useEffect(() => {
    const fit = () => setWidth((w) => clamp(w));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // the handle is on the left edge: moving left makes the pane wider
    setWidth(clamp(drag.current.w + (drag.current.x - e.clientX)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    setWidth((w) => (remember(w), w));
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setWidth((w) => {
      const next = clamp(w + (e.key === "ArrowLeft" ? step : -step));
      remember(next);
      return next;
    });
  };
  const reset = () => {
    setWidth(clamp(PANE_DEFAULT));
    remember(PANE_DEFAULT);
  };

  return (
    <aside
      aria-label={label}
      style={{ "--pane-w": `${width}px` } as CSSProperties}
      className={cx("m-panel fixed inset-0 z-40 bg-bg flex flex-col min-h-0 safe-top lg:relative lg:inset-auto lg:z-auto lg:w-(--pane-w) lg:shrink-0 lg:border-l lg:border-line", dragging && "select-none", className)}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={width}
        aria-valuemin={PANE_MIN}
        aria-valuemax={maxWidth()}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        className="hidden lg:block absolute inset-y-0 -left-1.5 w-3 z-10 cursor-col-resize group outline-none"
      >
        <span className={cx("absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 rounded-full transition-colors", dragging ? "bg-accent" : "bg-transparent group-hover:bg-line group-focus-visible:bg-accent")} />
      </div>
      {children}
    </aside>
  );
}
