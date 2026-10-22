import { shareOrigin, useAccess } from "../access.ts";
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { HARNESSES, type Agent } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";
import { useStore } from "../store.ts";
import { agentMood } from "../ghostMood.ts";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Paperclip's buttons: a filled primary, an outlined default, a bare ghost. */
export function Button({ variant = "default", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 h-9 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
        // every button is a capsule, like the iPhone app; the main action is filled
        "rounded-full",
        variant === "primary" ? "px-4 bg-accent text-accent-ink hover:bg-accent/90 shadow-[inset_0_1px_0_oklch(1_0_0/0.18)]" : "px-3.5",
        variant === "default" && "border border-input bg-panel dark:bg-input/30 hover:bg-hover dark:hover:bg-input/50",
        variant === "ghost" && "text-ink/85 hover:bg-hover hover:text-ink",
        variant === "danger" && "border border-input text-bad hover:bg-hover",
        className,
      )}
    />
  );
}

/**
 * A small action with an icon. The label is always its accessible name and tooltip; from the md
 * breakpoint up it also shows as text beside the icon, so nobody has to guess what an icon means.
 * Pass `labelAlways` to show the text on phones too.
 */
export function IconButton({ icon, label, labelAlways, tone = "default", className, ...p }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { icon: ReactNode; label: string; labelAlways?: boolean; tone?: "default" | "danger" }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...p}
      className={cx(
        "inline-flex items-center gap-1.5 h-8 min-w-8 justify-center rounded-full px-1.5 text-xs font-medium whitespace-nowrap text-muted transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 disabled:pointer-events-none",
        labelAlways ? "px-2" : "md:px-2",
        tone === "danger" ? "hover:bg-hover hover:text-bad" : "hover:bg-hover hover:text-ink",
        className,
      )}
    >
      <span aria-hidden className="shrink-0 grid place-items-center">{icon}</span>
      <span aria-hidden className={labelAlways ? undefined : "hidden md:inline"}>{label}</span>
    </button>
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-9 w-full rounded-xl border border-input bg-transparent px-3 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30", className)} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("w-full rounded-2xl border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30", className)} />;
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

export function Modal({ title, onClose, children, wide, drawer = false, headerless = false, className, contentClassName, label }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; drawer?: boolean; headerless?: boolean; className?: string; contentClassName?: string; label?: string }) {
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
    if (headerless) ref.current?.focus();
    return () => { window.removeEventListener("keydown", k); previous?.focus(); };
  }, []);
  return (
    <div className={drawer ? "fixed inset-0 z-50 flex justify-end" : "fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} tabIndex={-1} className={cx(drawer ? "w-full max-w-[480px] h-dvh bg-panel border-l border-line overflow-y-auto safe-bottom" : "w-full bg-panel border border-line rounded-t-3xl sm:rounded-3xl shadow-panel max-h-[92vh] overflow-y-auto safe-bottom", !drawer && (wide ? "sm:max-w-2xl" : "sm:max-w-md"), className)}>
        {!headerless && <div className="flex items-center justify-between px-5 pt-4 pb-2">
          {typeof title === "string" ? <h2 className="text-base font-semibold">{title}</h2> : <div className="text-base font-semibold">{title}</div>}
          <button onClick={onClose} className="size-8 grid place-items-center rounded-full bg-chip hover:bg-hover text-muted" aria-label="Close">
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>}
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
 * offline, focused while it works) and animates; elsewhere it only reacts to a poke or hover.
 * `badge` adds a status dot. Tiny avatars skip interaction entirely.
 */
export function AgentAvatar({
  agent,
  size = 32,
  badge = false,
  live = false,
  animate,
  interactive = size >= 24,
}: {
  agent: (Pick<Agent, "harness" | "name"> & { handle?: string; id?: string; status?: Agent["status"]; computerId?: string | null; settings?: Agent["settings"] }) | undefined;
  size?: number;
  badge?: boolean;
  live?: boolean;
  animate?: boolean;
  interactive?: boolean;
}) {
  const look = agent?.settings?.appearance ?? defaultAppearance(agent?.handle ?? agent?.name ?? "agent");
  const baseMood = useStore((s) => live ? agentMood(agent, s.approvals, s.computers) : "awake");
  const previous = useRef({ id: agent?.id, status: agent?.status });
  const [done, setDone] = useState(false);
  useEffect(() => {
    const finished = live && baseMood === "awake" && previous.current.id === agent?.id && previous.current.status === "busy" && agent?.status === "online";
    previous.current = { id: agent?.id, status: agent?.status };
    setDone(finished);
    if (!finished) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [agent?.id, agent?.status, live, baseMood]);
  const mood: GhostMood = done && baseMood === "awake" ? "done" : baseMood;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <Ghost key={agent?.id} look={look} size={size} mood={mood} animate={animate ?? (live || interactive)} ambient={live} interactive={interactive} label={agent?.name ?? "agent"} />
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
 * state, so it stays quiet (a gray chip with a green presence dot) and never reads as the mint
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

export function StatusChip({ status }: { status: Agent["status"] }) {
  const s = AGENT_STATUS[status];
  return (
    <span className={cx("status-chip inline-flex items-center gap-1.5 rounded-full px-2.5 h-[22px] text-xs font-medium leading-none whitespace-nowrap", status === "offline" && "opacity-70")} style={{ "--sc": s.hue } as CSSProperties}>
      {s.dot && <span className={cx("size-1.5 rounded-full", status === "busy" && "animate-pulse")} style={{ background: s.dot }} />}
      {s.label}
    </span>
  );
}

/** Warren's mark: a ghost outline. `draw` animates it drawing itself (the loading state). */
export function GhostMark({ size = 20, draw, className }: { size?: number; draw?: boolean; className?: string }) {
  return (
    <svg viewBox="22 10 76 104" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={draw ? 4.5 : 9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path className={draw ? "loader-draw" : undefined} pathLength={100} d="M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z" />
      {!draw && (
        <g fill="currentColor" stroke="none">
          <circle cx="50" cy="56" r="6" />
          <circle cx="70" cy="56" r="6" />
        </g>
      )}
    </svg>
  );
}

/** Full-page loading: a large, centered, gray ghost drawing itself. */
export function Loader({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="h-full w-full grid place-items-center bg-panel" style={{ color: "var(--loader)" }}>
      <GhostMark size={88} draw />
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
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is drawn on the page itself (fixed, in a portal) so cards and scroll areas that clip
  // their contents can't cut it off. It opens upward when there's no room below.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const h = menuRef.current?.offsetHeight ?? 0;
    const goUp = up || (h > 0 && r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8);
    const style: CSSProperties = { position: "fixed", maxWidth: "min(22rem, calc(100vw - 16px))" };
    if (goUp) style.bottom = window.innerHeight - r.top + 4;
    else style.top = r.bottom + 4;
    if (align === "right") style.right = Math.max(8, window.innerWidth - r.right);
    else style.left = Math.max(8, r.left);
    setPos(style);
  }, [open, up, align, items.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const shut = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => {
        setPos(null);
        setOpen((o) => !o);
      })}
      {open &&
        createPortal(
          <div ref={menuRef} role="menu" style={pos ?? { position: "fixed", visibility: "hidden", top: 0, left: 0 }} className="glass z-[100] min-w-48 rounded-2xl p-1.5">
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
                  className={cx("w-full px-2.5 py-1.5 min-h-9 rounded-xl flex items-start gap-2 text-sm text-left hover:bg-hover", it.danger && "text-bad")}
                >
                  {it.icon && <span className="shrink-0 mt-0.5">{it.icon}</span>}
                  <span className="min-w-0 break-words">{it.label}</span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Rounded status pill, Paperclip-style: a tinted chip, color only where it carries meaning. */
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
    <span className="status-chip inline-flex items-center gap-1 rounded-full px-2 h-5 text-[11px] font-medium leading-none whitespace-nowrap" style={{ "--sc": hues[tone] } as CSSProperties}>
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
export function Popover({ trigger, children, align = "left", up = true, className, inline }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; up?: boolean; className?: string; inline?: boolean }) {
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
    <div ref={ref} className={inline ? "relative inline-block" : "relative"}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div ref={panel} role="dialog" style={shift ? { transform: `translateX(${shift}px)` } : undefined} className={cx("glass absolute z-50 max-w-[calc(100vw-1rem)] rounded-2xl", align === "right" ? "right-0" : "left-0", up ? "bottom-full mb-2" : "top-full mt-2", className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * The one-line command that installs Warren on a device and connects it, served by this hub
 * (GET /install.sh, /install.ps1), with a tab per OS and the manual command for a device that
 * already has Warren.
 */
export function DeviceInstall({ token, name }: { token: string; name: string }) {
  const windowsGuess = /Windows/.test(navigator.userAgent);
  const [os, setOs] = useState<"unix" | "windows" | "manual">(windowsGuess ? "windows" : "unix");
  useAccess();
  const hub = shareOrigin();
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const pwsh = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const commands = {
    unix: `curl -fsSL ${hub}/install.sh | bash -s -- --hub ${hub} --token ${token} --name ${sh(name)}`,
    windows: `& ([scriptblock]::Create((irm ${hub}/install.ps1))) -Hub ${hub} -Token ${token} -Name ${pwsh(name)}`,
    manual: `warren node start --hub ${hub} --token ${token} --name ${sh(name)}`,
  };
  const tabs = [
    ["unix", "Mac or Linux"],
    ["windows", "Windows"],
    ["manual", "Warren already installed"],
  ] as const;
  return (
    <div className="space-y-2">
      <div className="flex gap-1 text-xs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cx("px-2.5 py-1 rounded-md border", os === id ? "bg-panel border-line text-ink font-medium" : "border-transparent text-muted hover:bg-hover")}
            onClick={() => setOs(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <CopyBlock text={commands[os]} />
      <p className="text-xs text-muted">
        {os === "unix" && "In Terminal. It installs Warren in ~/warren (it needs git and Node 22+, and offers Node with Homebrew on a Mac), checks for a VM engine, and keeps the device connected from then on."}
        {os === "windows" && "In PowerShell. It installs Warren in your home folder (offering git and Node with winget) and keeps the device connected whenever you're signed in."}
        {os === "manual" && "Inside the Warren folder on that device. It stays connected until you close the terminal; `warren service install node` keeps it running."}
      </p>
    </div>
  );
}
