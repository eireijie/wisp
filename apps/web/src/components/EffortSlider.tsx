import { useRef, useState } from "react";
import { cx } from "./ui.tsx";

const LABELS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
export const effortName = (e: string) => LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
/** "GPT-6-Luna" → "GPT-6 Luna" */
export const prettyModel = (label: string) => label.replace(/(\d)-(?=[A-Z])/g, "$1 ");

/**
 * Codex-style effort slider: a pill track with a dot per level and a thumb that glides between
 * them. It's magnetic: while you drag, the thumb jumps from level to level and never rests in
 * between. Drag, click anywhere on the track, or use the arrow keys. `onChange` fires as soon as
 * the thumb lands on a new level, so callers that save should debounce.
 */
export function EffortSlider({ levels, value, onChange, disabled, label = "Reasoning effort", size = "lg" }: { levels: string[]; value: string; onChange: (level: string) => void; disabled?: boolean; label?: string; size?: "lg" | "md" | "sm" }) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = useRef(value); // the level we last reported, so a drag doesn't repeat it
  const index = Math.max(0, levels.indexOf(value));
  const steps = Math.max(1, levels.length - 1);
  const f = index / steps;
  const h = { lg: "2.75rem", md: "2rem", sm: "1.5rem" }[size]; // track height; the thumb sits 0.25rem inside it

  const pick = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const radius = r.height / 2;
    const frac = Math.min(1, Math.max(0, (clientX - r.left - radius) / (r.width - 2 * radius)));
    const level = levels[Math.round(frac * steps)];
    if (level === undefined || level === last.current) return;
    last.current = level;
    navigator.vibrate?.(8); // a small tick on phones that support it
    onChange(level);
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={steps}
      aria-valuenow={index}
      aria-valuetext={effortName(value)}
      aria-disabled={disabled}
      style={{ height: h }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = value;
        setDragging(true);
        pick(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging) pick(e.clientX);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(e) => {
        if (disabled) return;
        const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = levels[Math.min(levels.length - 1, Math.max(0, index + d))];
        if (next !== value) onChange(next);
      }}
      className={cx("relative w-full rounded-full bg-chip select-none touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent", disabled ? "opacity-50" : "cursor-pointer")}
    >
      {/* fill up to the thumb's center */}
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `calc(${f} * (100% - ${h}) + ${h})` }} />
      {levels.map((l, i) => (
        <span
          key={l}
          className={cx("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full", size === "sm" ? "size-1" : "size-1.5", i <= index ? "bg-accent-ink/60" : "bg-faint")}
          style={{ left: `calc(${i / steps} * (100% - ${h}) + ${h} / 2)` }}
          aria-hidden
        />
      ))}
      <span
        className={cx("absolute top-1/2 -translate-y-1/2 rounded-full bg-white shadow-md ring-1 ring-black/5 transition-[left,scale] duration-200 ease-[cubic-bezier(.34,1.5,.64,1)]", dragging && "scale-110")}
        style={{ left: `calc(${f} * (100% - ${h}) + 0.25rem)`, width: `calc(${h} - 0.5rem)`, height: `calc(${h} - 0.5rem)` }}
        aria-hidden
      />
    </div>
  );
}
