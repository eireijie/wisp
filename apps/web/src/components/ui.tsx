import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { X } from "lucide-react";
import { HARNESSES, type Agent } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Button({ variant = "default", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 h-9 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
        variant === "primary" && "bg-accent text-accent-ink hover:opacity-90",
        variant === "default" && "border border-line bg-panel hover:bg-hover",
        variant === "ghost" && "hover:bg-hover text-muted hover:text-ink",
        variant === "danger" && "border border-line text-bad hover:bg-hover",
        className,
      )}
    />
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-9 w-full rounded-lg border border-line bg-panel px-3 text-sm outline-none placeholder:text-faint focus:border-accent", className)} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent", className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-label={title} className={cx("w-full bg-panel rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto safe-bottom", wide ? "sm:max-w-2xl" : "sm:max-w-md")}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

const HARNESS_COLORS: Record<string, string> = {
  "claude-code": "#d97757",
  codex: "#10a37f",
  kimi: "#5b6cff",
  grok: "#6b7280",
  hermes: "#a855f7",
  openclaw: "#e11d48",
  gemini: "#4285f4",
  opencode: "#f59e0b",
  goose: "#111827",
  qwen: "#6d28d9",
  cursor: "#0f172a",
  custom: "#0ea5e9",
};

/** Harness names; device-declared ACP agents ("acp:my-bot") show their own name. */
export const HARNESS_LABELS: Record<string, string> = new Proxy(Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])), {
  get: (t, k: string) => t[k] ?? (typeof k === "string" && k.startsWith("acp:") ? k.slice(4) : k),
});

/**
 * An agent's ghost. With `live`, the ghost shows the agent's status (asleep when offline,
 * thinking while it works) and animates; elsewhere (e.g. message lists) it stays still so a
 * long conversation doesn't become a wall of motion. The corner dot is the harness.
 */
export function AgentAvatar({
  agent,
  size = 32,
  badge = true,
  live = false,
  animate,
}: {
  agent: (Pick<Agent, "harness" | "name"> & { handle?: string; id?: string; status?: Agent["status"]; settings?: Agent["settings"] }) | undefined;
  size?: number;
  badge?: boolean;
  live?: boolean;
  animate?: boolean;
}) {
  const look = agent?.settings?.appearance ?? defaultAppearance(agent?.handle ?? agent?.name ?? "agent");
  const mood: GhostMood = !live ? "awake" : agent?.status === "offline" ? "asleep" : agent?.status === "busy" ? "thinking" : "awake";
  const harnessColor = HARNESS_COLORS[agent?.harness ?? "custom"] ?? "#78716c";
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <Ghost look={look} size={size} mood={mood} animate={animate ?? live} label={agent?.name ?? "agent"} />
      {badge && size >= 24 && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-panel"
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28), background: harnessColor }}
          title={HARNESS_LABELS[agent?.harness ?? "custom"]}
        />
      )}
    </span>
  );
}

export function UserAvatar({ name, size = 32 }: { name: string; size?: number }) {
  // people get round initials; agents get critters, so the two never look alike
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="shrink-0 rounded-full grid place-items-center bg-accent-soft text-accent font-semibold" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials || "?"}
    </div>
  );
}

export function StatusDot({ status, className }: { status: Agent["status"]; className?: string }) {
  return <span className={cx("inline-block size-2 rounded-full", status === "online" ? "bg-ok" : status === "busy" ? "bg-warn animate-pulse" : "bg-faint", className)} title={status} />;
}

export function CopyBlock({ text }: { text: string }) {
  return (
    <div className="relative group">
      <pre className="bg-code rounded-lg p-3 pr-16 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
      <button className="absolute top-2 right-2 text-xs px-2 py-1 rounded-md bg-panel border border-line hover:bg-hover" onClick={() => navigator.clipboard?.writeText(text)}>
        Copy
      </button>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-8 text-center">
      <div className="max-w-sm space-y-3">
        <div className="mx-auto size-12 rounded-2xl bg-accent-soft text-accent grid place-items-center">{icon}</div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="text-sm text-muted space-y-3">{children}</div>
      </div>
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** A small dropdown menu. Closes on outside click, Escape, or choosing an item. */
export function Menu({ trigger, items, align = "left", up = false }: { trigger: (open: boolean, toggle: () => void) => ReactNode; items: ({ label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean } | "divider")[]; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div role="menu" className={cx("absolute z-50 min-w-48 rounded-xl border border-line bg-panel shadow-panel py-1", align === "right" ? "right-0" : "left-0", up ? "bottom-full mb-1" : "top-full mt-1")}>
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={cx("w-full px-3 h-8 flex items-center gap-2 text-sm text-left hover:bg-hover", it.danger && "text-bad")}
              >
                {it.icon}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Rounded status pill, Paperclip-style: color only where it carries meaning. */
export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "accent"; children: ReactNode }) {
  const tones = {
    neutral: "bg-chip text-muted",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/12 text-warn",
    bad: "bg-bad/12 text-bad",
    info: "bg-info/12 text-info",
    accent: "bg-accent-soft text-accent",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 h-5 text-[11px] font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}

/** Common reaction emoji, in picker order. */
export const EMOJI_GRID = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "🔥", "✅", "🚀", "💯", "😮", "😢", "🤔", "👏", "🙌", "💡", "⭐", "🐛", "🛠️", "📌", "📝", "⏳", "⚠️", "❌", "😀", "🥲", "😍", "😎", "🤝", "💪", "☕", "🐇"];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-0.5 p-2 w-72">
      {EMOJI_GRID.map((e) => (
        <button key={e} onClick={() => onPick(e)} className="size-8 rounded-md hover:bg-hover text-lg leading-none" aria-label={`React ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}

/** An anchored panel with any content. Closes on outside click or Escape; opens upward by default (composer). */
export function Popover({ trigger, children, align = "left", up = true, className }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; up?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  // keep the panel on screen: nudge it sideways when it would run off a narrow viewport
  const panel = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open || !panel.current) {
      setShift(0);
      return;
    }
    const r = panel.current.getBoundingClientRect();
    const gutter = 8;
    const left = r.left - shift;
    const right = left + r.width;
    setShift(left < gutter ? gutter - left : right > window.innerWidth - gutter ? window.innerWidth - gutter - right : 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div ref={panel} role="dialog" style={shift ? { transform: `translateX(${shift}px)` } : undefined} className={cx("absolute z-50 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-panel shadow-panel", align === "right" ? "right-0" : "left-0", up ? "bottom-full mb-2" : "top-full mt-2", className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
