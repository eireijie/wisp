import { useEffect, useState, type ReactNode } from "react";
import { Check } from "../../icons.tsx";
import { cx } from "../../components/ui.tsx";

/** The top of a settings page: its name and what it's for. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children && <p className="mt-1 text-sm text-muted max-w-xl">{children}</p>}
    </div>
  );
}

/** A group of settings with a small heading, like Linear's and Slack's. */
export function Section({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** Rows in a bordered card. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-line divide-y divide-line", className)}>{children}</div>;
}

/** One setting: what it is on the left, the control on the right (stacked on phones). */
export function Row({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      {children !== undefined && <div className="shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40", on ? "bg-accent" : "bg-chip border border-line")}
    >
      <span className={cx("inline-block size-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

/** Pick one of a few options, inline. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5 bg-bg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cx("h-7 px-2.5 rounded-md text-[13px] inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50", value === v ? "bg-panel text-ink font-medium shadow-sm" : "text-muted hover:text-ink")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, onChange, children, label, disabled, className }: { value: string; onChange: (v: string) => void; children: ReactNode; label: string; disabled?: boolean; className?: string }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx("h-8 rounded-lg border border-line bg-panel px-2 text-sm disabled:opacity-60", className)}>
      {children}
    </select>
  );
}

/** "Saved" for a moment after a change that saves by itself. */
export function useSavedFlash(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 1600);
    return () => clearTimeout(t);
  }, [shown]);
  return [shown, () => setShown(true)];
}

export function SavedNote({ shown }: { shown: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ok" aria-live="polite">
      {shown && (
        <>
          <Check size={13} /> Saved
        </>
      )}
    </span>
  );
}

export function OwnersOnly({ show }: { show: boolean }) {
  return show ? <p className="mb-6 rounded-lg bg-hover px-3 py-2 text-xs text-muted">Only owners can change these. You can see how they're set.</p> : null;
}
