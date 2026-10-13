import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { X } from "../icons.tsx";
import { HARNESSES, type Agent } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Warren's buttons: the one filled primary (it glows a little at night), a soft tonal default, a bare ghost. */
export function Button({ variant = "default", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 h-9 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
        "rounded-lg",
        variant === "primary" ? "btn-primary px-4 bg-accent text-accent-ink hover:bg-accent/90" : "px-3",
        variant === "default" && "bg-chip hover:bg-input/60",
        variant === "ghost" && "text-ink/85 hover:bg-hover hover:text-ink",
        variant === "danger" && "bg-chip text-bad hover:bg-bad/10",
        className,
      )}
    />
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30", className)} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30", className)} />;
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

export function Modal({ title, onClose, children, wide, drawer = false, className, contentClassName, label }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; drawer?: boolean; className?: string; contentClassName?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); }
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter((el) => el.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    return () => { window.removeEventListener("keydown", k); previous?.focus(); };
  }, []);
  return (
    <div className={drawer ? "fixed inset-0 z-50 flex justify-end" : "fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} tabIndex={-1} className={cx(drawer ? "w-full max-w-[480px] h-dvh bg-panel border-l border-line overflow-y-auto safe-bottom" : "w-full bg-panel border border-line rounded-t-2xl sm:rounded-2xl shadow-panel max-h-[92vh] overflow-y-auto safe-bottom", !drawer && (wide ? "sm:max-w-2xl" : "sm:max-w-md"), className)}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          {typeof title === "string" ? <h2 className="text-base font-semibold">{title}</h2> : <div className="text-base font-semibold">{title}</div>}
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className={cx("px-5 pb-5", contentClassName)}>{children}</div>
      </div>
    </div>
  );
}

/** Harness names; device-declared ACP agents ("acp:my-bot") show their own name. */
export const HARNESS_LABELS: Record<string, string> = new Proxy(Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])), {
  get: (t, k: string) => t[k] ?? (typeof k === "string" && k.startsWith("acp:") ? k.slice(4) : k),
});

type AgentLike = { name: string; handle?: string; settings?: Agent["settings"] };

/**
 * An agent's own color: the more vivid of its ghost's two colors. Put it in `--agent` and use
 * the agent-ink / agent-tint classes, which keep it readable in both themes.
 */
export function agentColor(agent: AgentLike | undefined): string {
  const look = agent?.settings?.appearance ?? defaultAppearance(agent?.handle ?? agent?.name ?? "agent");
  const vivid = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return Math.max(...c) - Math.min(...c);
  };
  const ok = (c?: string) => !!c && /^#[0-9a-fA-F]{6}$/.test(c);
  if (!ok(look.color)) return "#8b8cf7";
  return ok(look.color2) && vivid(look.color2!) > vivid(look.color) ? look.color2! : look.color;
}

/** Inline style that hands an agent's color to agent-ink / agent-tint. */
export const agentVar = (agent: AgentLike | undefined) => ({ "--agent": agentColor(agent) }) as CSSProperties;

/**
 * An agent's ghost. With `live`, the ghost shows the agent's status (dozing and gray when
 * offline, focused while it works) and animates; elsewhere (e.g. message lists) it stays still
 * so a long conversation doesn't become a wall of motion. `badge` adds a status dot.
 */
export function AgentAvatar({
  agent,
  size = 32,
  badge = false,
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
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <Ghost look={look} size={size} mood={mood} animate={animate ?? live} label={agent?.name ?? "agent"} />
      {badge && agent?.status && <StatusDot status={agent.status} className="absolute bottom-0 right-0 ring-2 ring-panel" />}
    </span>
  );
}

export function UserAvatar({ name, size = 32 }: { name: string; size?: number }) {
  // people get round initials; agents get ghosts, so the two never look alike
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="shrink-0 rounded-full grid place-items-center bg-chip text-muted font-medium" style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4) }}>
      {initials || "?"}
    </div>
  );
}

/**
 * One word and one look per agent status, used the same way everywhere. Online is the normal
 * state, so it stays quiet (a green dot and a gray word) and never reads as the
 * accent; working is blue.
 */
export const AGENT_STATUS: Record<Agent["status"], { label: string; hue: string; dot?: string }> = {
  online: { label: "online", hue: "var(--status-idle)", dot: "var(--status-online)" },
  busy: { label: "working", hue: "var(--status-working)", dot: "var(--status-working)" },
  offline: { label: "offline", hue: "var(--status-idle)" },
};

export function StatusDot({ status, className }: { status: Agent["status"]; className?: string }) {
  const s = AGENT_STATUS[status];
  return <span className={cx("inline-block size-2 rounded-full", status === "busy" && "animate-pulse", className)} style={{ background: s.dot ?? s.hue }} title={s.label} />;
}

/** A glowing dot and a word: how an agent is doing. */
export function StatusChip({ status }: { status: Agent["status"] }) {
  const s = AGENT_STATUS[status];
  return (
    <span className={cx("status-tag", status === "busy" && "pulse text-ink", status === "offline" && "text-faint")} style={{ "--sc": s.dot ?? s.hue } as CSSProperties}>
      {s.label}
    </span>
  );
}

/** Warren's mark: a ghost outline with its eyes. */
export function GhostMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="22 10 76 104" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z" />
      <g fill="currentColor" stroke="none">
        <circle cx="50" cy="56" r="6" />
        <circle cx="70" cy="56" r="6" />
      </g>
    </svg>
  );
}

/** Full-page loading: Warren's ghost bobbing in the dark. */
export function Loader({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="h-full w-full grid place-items-center bg-app" style={{ color: "var(--loader)" }}>
      <GhostMark size={64} className="loader-float" />
      <span className="sr-only">{label}</span>
    </div>
  );
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
        <div className="mx-auto size-14 rounded-xl bg-accent-soft text-accent-text grid place-items-center">{icon}</div>
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="text-sm text-muted space-y-3">{children}</div>
      </div>
    </div>
  );
}

/** "3:42 PM" or "15:42": the locale's way, unless the person picked a 12- or 24-hour clock. */
export function clockTime(d: Date | string, clock?: "auto" | "12h" | "24h", opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(d).toLocaleString([], { hour: "numeric", minute: "2-digit", ...(clock && clock !== "auto" ? { hourCycle: clock === "24h" ? "h23" : "h12" } : {}), ...opts });
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
        <div role="menu" className={cx("absolute z-50 min-w-48 rounded-xl border border-line bg-panel shadow-panel p-1", align === "right" ? "right-0" : "left-0", up ? "bottom-full mb-1" : "top-full mt-1")}>
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="-mx-1 my-1 h-px bg-line" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={cx("w-full px-2 h-8 rounded-md flex items-center gap-2 text-sm text-left hover:bg-hover", it.danger && "text-bad")}
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

/** A small tinted tag, color only where it carries meaning. */
export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "accent"; children: ReactNode }) {
  const hues = {
    neutral: "var(--status-idle)",
    ok: "var(--status-online)",
    warn: "var(--status-paused)",
    bad: "var(--status-error)",
    info: "var(--status-working)",
    accent: "var(--accent)",
  };
  return (
    <span className="tone-tag inline-flex items-center gap-1 rounded-md px-1.5 h-5 text-[11px] font-medium leading-none whitespace-nowrap" style={{ "--sc": hues[tone] } as CSSProperties}>
      {children}
    </span>
  );
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
