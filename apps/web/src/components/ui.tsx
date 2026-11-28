import { shareOrigin, useAccess } from "../access.ts";
import { LAYER } from "./layers.ts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { type Agent } from "@bubble-ai/core";
import { defaultAppearance } from "@bubble-ai/core/src/appearance.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";
import { MotionMark } from "./MotionMark.tsx";
import { PasswordInput } from "./PasswordInput.tsx";
import { familyColor } from "../ghostFamily.ts";
import { useStore } from "../store.ts";
import { agentMood } from "../ghostMood.ts";
import { EASE, play, useOnChange, usePresence, useSheetBackdrop } from "../motion.ts";
import { motionReduced } from "../theme.ts";
import { isTopOverlay, useOverlay } from "../overlays.ts";
import { copyText } from "../clipboard.ts";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Buttons (tokens.css): ink primary, outlined secondary, bare ghost, red-text danger, and violet for app-level actions. 8px corners, never a capsule. */
export function Button({ variant = "default", size, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" | "wisp"; size?: "sm" | "lg" }) {
  const look = { default: "btn-secondary", primary: "btn-primary", wisp: "btn-accent", ghost: "btn-ghost", danger: "btn-danger" }[variant];
  return <button {...p} className={cx("btn", look, size && `btn-${size}`, className)} />;
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
        "inline-flex items-center gap-1.5 h-8 min-w-8 justify-center rounded-[8px] px-1.5 text-[13px] font-medium whitespace-nowrap text-muted transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 disabled:pointer-events-none",
        labelAlways ? "px-2.5" : "md:px-2.5",
        tone === "danger" ? "hover:bg-hover hover:text-bad" : "hover:bg-hover hover:text-ink",
        className,
      )}
    >
      <span aria-hidden className="shrink-0 grid place-items-center">{icon}</span>
      <span aria-hidden className={labelAlways ? undefined : "hidden md:inline"}>{label}</span>
    </button>
  );
}

export function Input({ className, wrapClassName, ...p }: InputHTMLAttributes<HTMLInputElement> & { wrapClassName?: string }) {
  if (p.type === "password") return <PasswordInput {...p} wrapClassName={wrapClassName} className={cx(inputCls, className)} />;
  return <input {...p} className={cx(inputCls, className)} />;
}

const inputCls = "h-9 w-full rounded-[8px] border border-input bg-transparent px-3 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30";

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("w-full rounded-[10px] border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30", className)} />;
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

/** A phone or tablet: no mouse to hover with. Fields don't take focus on their own there, since that opens the keyboard over the page. */
export const touchFirst = () => typeof window !== "undefined" && !!window.matchMedia?.("(hover: none), (pointer: coarse)").matches;

export function Modal({ title, onClose, children, wide, drawer = false, headerless = false, still = false, className, contentClassName, label }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; drawer?: boolean; headerless?: boolean; /** opens and closes instantly: no sheet slide, no fade, the app behind stays put */ still?: boolean; className?: string; contentClassName?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const id = useRef(Symbol("modal")).current;
  useOverlay(id, "modal");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => {
      // overlays stack (a New agent dialog over a step sheet, the search palette over a dialog): only the one on top answers Escape and Tab
      if (!isTopOverlay(id)) return;
      if (e.key === "Escape") { e.stopPropagation(); close.current(); }
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter((el) => el.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", k);
    if (!touchFirst()) ref.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    if (headerless) ref.current?.focus();
    return () => { window.removeEventListener("keydown", k); previous?.focus(); };
  }, []);
  // on phones the app behind a sheet scales back; the sheet lives in <body> so that scale doesn't touch it
  useSheetBackdrop(!drawer && !still);
  const dialog = (
    <div className={cx(drawer ? "fixed inset-0 flex justify-end" : cx(!still && "m-scrim", "fixed inset-0 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-12"), LAYER.modal)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} tabIndex={-1} className={cx(drawer ? "m-drawer w-full max-w-[480px] h-dvh bg-panel border-l border-line overflow-y-auto safe-bottom" : cx(!still && "m-dialog", "w-full bg-panel border border-line rounded-t-[16px] sm:rounded-[16px] shadow-panel max-h-[92vh] overflow-y-auto safe-bottom"), !drawer && (wide ? "sm:max-w-2xl" : "sm:max-w-md"), className)}>
        {!headerless && <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-3 sm:px-8 sm:pt-7">
          {typeof title === "string" ? <h2 className="text-base font-semibold">{title}</h2> : <div className="text-base font-semibold">{title}</div>}
          <button onClick={onClose} className="ibtn -mr-1.5" aria-label="Close" title="Close (Esc)">
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>}
        <div className={cx("px-5 pb-6 sm:px-8 sm:pb-8", contentClassName)}>{children}</div>
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

export { harnessLabel } from "@bubble-ai/core";

type AgentLike = { name: string; handle?: string; settings?: Agent["settings"] };

/**
 * An agent's own color: the more vivid of its ghost's two colors. Put it in `--agent` and use
 * the agent-ink / agent-tint classes, which keep it readable in both themes.
 */
export function agentColor(agent: AgentLike | undefined): string {
  const look = agent?.settings?.appearance ?? defaultAppearance(agent?.handle ?? agent?.name ?? "agent");
  // the same flat colour its ghost wears (ghost family)
  return familyColor(look, agent?.handle ?? agent?.name ?? "agent");
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
      <Ghost key={agent?.id} look={look} size={size} mood={mood} animate={animate ?? (live || interactive)} ambient={live || interactive} interactive={interactive} label={agent?.name ?? "agent"} seed={agent?.handle ?? agent?.name} />
      {badge && agent?.status && <StatusDot status={agent.status} needsSignIn={!!(agent as { signIn?: unknown }).signIn} className="absolute bottom-0 right-0 ring-2 ring-panel" />}
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
  online: { label: "Online", hue: "var(--status-online)" },
  busy: { label: "Working", hue: "var(--status-working)", dot: "var(--status-working)" },
  offline: { label: "Offline", hue: "var(--status-idle)" },
};

/** How an online agent that can't answer until someone signs its harness in shows. */
export const NEEDS_SIGN_IN = { label: "needs sign-in", hue: "var(--warn)", dot: "var(--warn)" };

/** The look for an agent's status; online but with its harness signed out where it runs reads "needs sign-in". */
const statusLook = (status: Agent["status"], needsSignIn?: boolean) => (needsSignIn && status === "online" ? NEEDS_SIGN_IN : AGENT_STATUS[status]);

export function StatusDot({ status, needsSignIn, className }: { status: Agent["status"]; needsSignIn?: boolean; className?: string }) {
  const s = statusLook(status, needsSignIn);
  return <span className={cx("inline-block size-2 rounded-full", status === "busy" && "animate-pulse", className)} style={{ background: s.dot ?? s.hue }} title={s.label} />;
}

export function StatusChip({ status, needsSignIn }: { status: Agent["status"]; needsSignIn?: boolean }) {
  const s = statusLook(status, needsSignIn);
  return (
    <span className={cx("status-chip inline-flex items-center gap-1.5 rounded-[6px] px-2 h-[22px] text-xs font-medium leading-none whitespace-nowrap", status === "offline" && "opacity-70")} style={{ "--sc": s.hue } as CSSProperties}>
      {s.dot && <span className={cx("size-1.5 rounded-full", status === "busy" && "animate-pulse")} style={{ background: s.dot }} />}
      {s.label}
    </span>
  );
}

/** Bubble AI's mark in one colour: the round bubble as a ring, two eyes glancing right (the menu bar and
 * status-bar glyph). `draw` animates the ring drawing itself (the loading state). */
export function BubbleMark({ size = 20, draw, className }: { size?: number; draw?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={draw ? 6 : 10.7} strokeLinecap="round" className={className} aria-hidden>
      <circle className={draw ? "loader-draw" : undefined} pathLength={100} cx="60" cy="60" r="44.7" />
      {!draw && (
        <g fill="currentColor" stroke="none">
          <ellipse cx="52" cy="56" rx="7.3" ry="13.5" />
          <ellipse cx="78.7" cy="56" rx="7.3" ry="13.5" />
        </g>
      )}
    </svg>
  );
}

/** Bubble AI's full-colour mark, the app icon: a frosted, blue-tinted round bubble with a rainbow rim and two eyes
 * glancing right. Light and dark follow the app's mode (`.app-mark` in index.css). */
export function AppMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cx("app-mark", className)} aria-hidden>
      <defs>
        <radialGradient id={`${id}g`} cx="32" cy="28.8" r="51.2" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="am-g0" />
          <stop offset=".7" className="am-g1" />
          <stop offset="1" className="am-g2" />
        </radialGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#bf86ff" />
          <stop offset=".25" stopColor="#ff7cc4" />
          <stop offset=".45" stopColor="#7fb0ff" />
          <stop offset=".65" stopColor="#6fe8c0" />
          <stop offset=".82" stopColor="#ffe27a" />
          <stop offset="1" stopColor="#ff9c80" />
        </linearGradient>
        <radialGradient id={`${id}h`}>
          <stop offset="0" stopColor="#fff" stopOpacity=".75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle className="am-base" cx="32" cy="32" r="32" />
      <circle fill={`url(#${id}g)`} cx="32" cy="32" r="32" />
      {size > 32 && <ellipse fill={`url(#${id}h)`} cx="19.84" cy="12.8" rx="8.96" ry="4.48" />}
      <circle cx="32" cy="32" r={size > 32 ? 31.04 : 29.44} fill="none" stroke={`url(#${id}r)`} strokeWidth={size > 32 ? 1.92 : 5.12} />
      <ellipse className="am-eye" cx="24.64" cy="29.28" rx="5.44" ry="10.72" />
      <ellipse className="am-eye" cx="44.48" cy="29.28" rx="5.44" ry="10.72" />
    </svg>
  );
}

/**
 * Full-page loading: the Bubble AI mark drifting, bobbing and spinning until the page is ready. On
 * launch (`launch`) it whooshes in first. Reduced motion: it just sits there.
 */
export function Loader({ label = "Loading…", launch = false }: { label?: string; launch?: boolean }) {
  return (
    <div role="status" className="h-full w-full grid place-items-center bg-panel">
      <MotionMark size={72} entrance={launch ? "whoosh" : undefined} mood="working" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function CopyBlock({ text }: { text: string }) {
  return (
    <div className="relative group">
      <pre className="bg-code rounded-lg p-3 pr-16 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
      <button className="absolute top-2 right-2 text-xs px-2 py-1 rounded-md bg-panel border border-line hover:bg-hover" onClick={() => void copyText(text).catch(() => {})}>
        Copy
      </button>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-8 text-center">
      <div className="max-w-sm space-y-3">
        <div className="mx-auto size-12 rounded-[12px] bg-chip text-muted grid place-items-center">{icon}</div>
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
  // it springs from its trigger on open and shrinks back on close
  const { mounted, closing } = usePresence(open, 180);
  // The menu is drawn on the page itself (fixed, in a portal) so cards and scroll areas that clip
  // their contents can't cut it off. It opens upward when there's no room below.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const h = menuRef.current?.offsetHeight ?? 0;
    const goUp = up || (h > 0 && r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8);
    const style: CSSProperties = { position: "fixed", maxWidth: "min(22rem, calc(100vw - 16px))", transformOrigin: `${goUp ? "bottom" : "top"} ${align === "right" ? "right" : "left"}` };
    if (goUp) style.bottom = window.innerHeight - r.top + 4;
    else style.top = r.bottom + 4;
    // a long menu in a short window scrolls instead of running off the screen
    style.maxHeight = Math.max(120, (goUp ? r.top : window.innerHeight - r.bottom) - 12);
    style.overflowY = "auto";
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
        if (!open) setPos(null); // opening measures afresh; closing keeps the spot so the menu can shrink away
        setOpen((o) => !o);
      })}
      {mounted &&
        createPortal(
          <div ref={menuRef} role="menu" data-closing={closing || undefined} style={pos ?? { position: "fixed", visibility: "hidden", top: 0, left: 0 }} className={cx("m-menu w-max min-w-[168px] p-[5px]", LAYER.menu)}>
            {items.map((it, i) =>
              it === "divider" ? (
                <div key={i} className="-mx-[5px] my-1 h-px bg-line" />
              ) : (
                <button
                  key={it.label}
                  role="menuitem"
                  aria-label={it.label}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                  className={cx("flex w-full items-center text-left", it.danger && "text-bad")}
                >
                  {it.icon && <span className={cx("shrink-0", !it.danger && "text-muted")}>{it.icon}</span>}
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

/**
 * An unread count. It stays in place (scaled to nothing at zero) so a new count can pop in:
 * .4, 1.3, 1 whenever the number changes. `className` carries the size and color.
 */
export function PopBadge({ count, label, className, style }: { count: number; label: string; className: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(label);
  if (count > 0) shown.current = label;
  useOnChange(count > 0 ? label : "", () => {
    if (count > 0 && !motionReduced()) play(ref.current, [{ transform: "scale(.4)" }, { transform: "scale(1.3)", offset: 0.55 }, { transform: "scale(1)" }], { duration: 320, easing: EASE.pop });
  });
  return (
    <span ref={ref} aria-hidden={count > 0 ? undefined : true} data-zero={count > 0 ? undefined : true} className={cx("m-badge", className)} style={style}>
      {shown.current}
    </span>
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
    <span className="status-chip inline-flex items-center gap-1 rounded-[5px] px-1.5 h-5 text-[11px] font-medium leading-none whitespace-nowrap" style={{ "--sc": hues[tone] } as CSSProperties}>
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
  const { mounted, closing } = usePresence(open, 180);
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
    if (!open) return; // closing: the panel stays where it was while it shrinks away
    if (!panel.current) {
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
      {mounted && (
        <div ref={panel} role="dialog" data-closing={closing || undefined} style={{ transformOrigin: `${up ? "bottom" : "top"} ${align === "right" ? "right" : "left"}`, ...(shift ? { transform: `translateX(${shift}px)` } : null) }} className={cx("m-menu absolute z-50 max-w-[calc(100vw-1rem)]", align === "right" ? "right-0" : "left-0", up ? "bottom-full mb-2" : "top-full mt-2", className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * The one-line command that installs Bubble AI on a device and connects it, served by this hub
 * (GET /install.sh, /install.ps1), with a tab per OS and the manual command for a device that
 * already has Bubble AI.
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
    manual: `bubble-ai node start --hub ${hub} --token ${token} --name ${sh(name)}`,
  };
  const tabs = [
    ["unix", "Mac or Linux"],
    ["windows", "Windows"],
    ["manual", "Bubble AI already installed"],
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
        {os === "unix" && "In Terminal. It installs Bubble AI in ~/bubble-ai (it needs git and Node 22+, and offers Node with Homebrew on a Mac), checks for a VM engine, and keeps the device connected from then on."}
        {os === "windows" && "In PowerShell. It installs Bubble AI in your home folder (offering git and Node with winget) and keeps the device connected whenever you're signed in."}
        {os === "manual" && "Inside the Bubble AI folder on that device. It stays connected until you close the terminal; `bubble-ai service install node` keeps it running."}
      </p>
    </div>
  );
}

/** A problem in plain words, with a tool's raw output folded away under Details. */
export function Problem({ text, details, className }: { text: string; details?: string | null; className?: string }) {
  return (
    <div role="alert" className={cx("space-y-1 text-[13px]", className)}>
      <p className="text-bad">{text}</p>
      {details && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{details}</pre>
        </details>
      )}
    </div>
  );
}
