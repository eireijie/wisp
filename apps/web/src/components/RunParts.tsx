import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { cx } from "./ui.tsx";

/** A segmented control whose thumb slides to the picked option (a fade with reduced motion). */
export function SegBar<T extends string>({ label, value, options, onChange, big, disabled }: { label: string; value: T | null; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void; big?: boolean; disabled?: boolean }) {
  const i = options.findIndex(([v]) => v === value);
  return (
    <div role="radiogroup" aria-label={label} className="relative flex rounded-lg bg-control p-0.5">
      {i >= 0 && <span aria-hidden className="m-ind top-0.5 bottom-0.5 left-0.5 rounded-md bg-ink/14" style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${i * 100}%)` }} />}
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cx("relative z-[1] min-w-0 flex-1 truncate rounded-md px-1.5 font-medium disabled:opacity-50", big ? "h-9 text-[14px]" : "h-[26px] text-[12px]", value === v ? "text-ink" : "text-muted hover:text-ink")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** The top of a sub-page in the model panel: back, and its name. */
export function BackHeader({ title, onBack, big }: { title: string; onBack: () => void; big?: boolean }) {
  return (
    <div className={cx("relative flex items-center justify-center", big ? "h-11" : "h-8")}>
      <button type="button" onClick={onBack} aria-label="Back" className={cx("absolute left-0 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink", big ? "size-10" : "size-7")}>
        <ChevronLeft size={big ? 20 : 15} />
      </button>
      <span className={cx("font-semibold", big ? "text-[15px]" : "text-[13px]")}>{title}</span>
    </div>
  );
}

/** A thin bar: how much is used (or left). */
export function ThinBar({ pct, color, className }: { pct: number; color: string; className?: string }) {
  return (
    <div className={cx("h-1 overflow-hidden rounded-full bg-ink/10", className)}>
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/** A small grey label over a group of rows, with a note on the right. */
export function GroupLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint">
      <span className="truncate uppercase">{children}</span>
      {right && <span className="shrink-0 normal-case tracking-normal">{right}</span>}
    </div>
  );
}
