import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, CornerUpLeft, MessageSquare, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { TAPBACKS, type Message, type Reaction } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Modal, cx } from "./ui.tsx";

/**
 * What you can do with a message: Reply, Reply in thread, Copy, Pin, Edit, Delete. The menu from
 * a right-click (desktop) or a press and hold (phone) lists them under the quick reactions.
 */
export interface MessageAction {
  id: "reply" | "thread" | "copy" | "pin" | "edit" | "delete";
  label: string;
  icon: ReactNode;
  danger?: boolean;
  run: () => void;
}

export function useMessageActionList(m: Message, opts: { onReply: () => void; onThread?: () => void; onEdit: () => void; onDelete: () => void }): MessageAction[] {
  const channel = useStore((s) => s.channels.find((c) => c.id === m.channelId));
  const canPin = useStore((s) => s.me?.role !== "guest") && channel?.kind === "channel" && !channel.archivedAt;
  const mine = useStore((s) => m.author.kind === "user" && m.author.id === s.me?.user.id);
  const owner = useStore((s) => s.me?.role === "owner");
  const writable = !channel?.archivedAt;
  const pinned = !!channel?.pinnedIds.includes(m.id);
  const list: MessageAction[] = [];
  if (writable) list.push({ id: "reply", label: "Reply", icon: <CornerUpLeft size={16} />, run: opts.onReply });
  if (opts.onThread) list.push({ id: "thread", label: "Reply in thread", icon: <MessageSquare size={16} />, run: opts.onThread });
  if (m.body) list.push({ id: "copy", label: "Copy", icon: <Copy size={16} />, run: () => void navigator.clipboard?.writeText(m.body) });
  if (canPin) list.push({ id: "pin", label: pinned ? "Unpin" : "Pin to team", icon: pinned ? <PinOff size={16} /> : <Pin size={16} />, run: () => void api(pinned ? "DELETE" : "PUT", `/api/messages/${m.id}/pin`).catch((e) => alert((e as Error).message)) });
  if (mine && writable && m.body) list.push({ id: "edit", label: "Edit", icon: <Pencil size={16} />, run: opts.onEdit });
  if ((mine || owner) && writable) list.push({ id: "delete", label: "Delete", icon: <Trash2 size={16} />, danger: true, run: opts.onDelete });
  return list;
}

/** Phones and touch screens get the lifted version of the menu; a mouse gets it at the pointer. */
const touchFirst = () => window.matchMedia("(hover: none)").matches || window.innerWidth < 768;

/** Letter keys for the menu's items, shown on desktops. */
const KEYS: Partial<Record<MessageAction["id"], string>> = { reply: "R", thread: "T", copy: "C", pin: "P", edit: "E", delete: "⌫" };

/**
 * Right-click (desktop) or press and hold (phone): quick reactions on top, then Reply, Reply in
 * thread, Copy, Pin, Edit and Delete. On a desktop it opens at the pointer; on a phone the message
 * lifts over a blurred chat with the reactions above it and the actions below.
 */
export function MessageMenu({ actions, reacted, onReact, at, source, preview, mine, onClose }: {
  actions: MessageAction[];
  /** the reactions that are already yours: picking one again takes it back */
  reacted: string[];
  onReact?: (emoji: string) => void;
  /** where the pointer was; null when it was opened from the keyboard */
  at: { x: number; y: number } | null;
  /** the message's bubble (or the message), to lift and to give focus back to */
  source: HTMLElement | null;
  preview?: ReactNode;
  mine: boolean;
  onClose: () => void;
}) {
  const [lift] = useState(touchFirst);
  const [closing, setClosing] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; origin: string; shift: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const rect = useMemo(() => source?.getBoundingClientRect() ?? null, [source]);
  const close = (after?: () => void) => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      onClose();
      after?.();
      if (!after) (source?.closest<HTMLElement>("[tabindex]") ?? source)?.focus({ preventScroll: true });
    }, 140);
  };

  // place it before it paints: inside the window, flipped up when there's no room below
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (lift && rect) {
      // the group (reactions, message, actions) starts where the message is and rises to fit
      const taps = (el.querySelector("[data-taps]") as HTMLElement | null)?.offsetHeight ?? 0;
      const top = rect.top - taps - 8;
      const bottom = top + h;
      const shift = bottom > vh - 16 ? bottom - (vh - 16) : top < 16 ? top - 16 : 0;
      const left = mine ? Math.max(12, rect.right - w) : Math.min(rect.left, vw - w - 12);
      setBox({ left, top, origin: mine ? "100% 50%" : "0 50%", shift });
      return;
    }
    const x = at?.x ?? rect?.left ?? 16;
    const y = at?.y ?? (rect ? rect.bottom + 6 : 16);
    const up = y + h > vh - 8 && y - h > 8;
    setBox({ left: Math.min(Math.max(8, x), vw - w - 8), top: up ? y - h : Math.min(y, vh - h - 8), origin: `${x <= vw - w - 8 ? 0 : 100}% ${up ? 100 : 0}%`, shift: 0 });
  }, [lift, rect, at, mine]);

  // the message being lifted leaves its place in the chat while the menu shows it
  useEffect(() => {
    if (!lift || !source) return;
    source.style.visibility = "hidden";
    return () => {
      source.style.visibility = "";
    };
  }, [lift, source]);

  // focus goes into the menu, so arrows, letters and Escape work right away
  useEffect(() => {
    if (!box) return;
    ref.current?.querySelector<HTMLElement>(lift ? "[data-taps] button" : "[role=menuitem]")?.focus({ preventScroll: true });
  }, [!!box]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const away = () => close();
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  });

  const run = (a: MessageAction) => close(a.run);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const taps = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-taps] button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const j = taps.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") return e.preventDefault(), close();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      if (j >= 0) return void (down ? items[0] : null)?.focus();
      if (i < 0) return void items[0]?.focus();
      if (!down && i === 0 && taps.length) return void taps[0].focus();
      return void items[(i + (down ? 1 : -1) + items.length) % items.length]?.focus();
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && j >= 0) {
      e.preventDefault();
      return void taps[(j + (e.key === "ArrowRight" ? 1 : -1) + taps.length) % taps.length]?.focus();
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key === "Backspace" || e.key === "Delete" ? "⌫" : e.key.toUpperCase();
    const hit = actions.find((a) => KEYS[a.id] === key);
    if (hit) {
      e.preventDefault();
      run(hit);
    }
  };

  const menu = (
    <div
      ref={ref}
      role="dialog"
      aria-label="Message actions"
      onKeyDown={onKeyDown}
      data-closing={closing}
      className={cx("m-msgmenu fixed z-[61] flex flex-col gap-2", lift ? "m-lift items-start" : "w-[232px]", lift && mine && "items-end", !box && "invisible")}
      style={box ? { left: box.left, top: box.top, transformOrigin: box.origin, ["--shift" as string]: `${-box.shift}px` } : { left: 0, top: 0 }}
    >
      {onReact && (
        <div data-taps role="group" aria-label="React" className={cx("m-glass flex items-center gap-0.5 p-1", lift ? "self-start rounded-full" : "justify-between rounded-xl", lift && mine && "self-end")}>
          {TAPBACKS.map((emoji, k) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              aria-pressed={reacted.includes(emoji)}
              onClick={() => close(() => onReact(emoji))}
              style={{ animationDelay: `${40 + k * 30}ms` }}
              className={cx("m-tap grid place-items-center leading-none outline-none focus-visible:bg-hover hover:bg-hover", lift ? "size-10 rounded-full text-[21px]" : "h-[34px] w-9 rounded-lg text-[18px]", reacted.includes(emoji) && "bg-accent-soft")}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {lift && preview && (
        <div className="pointer-events-none max-h-[40vh] overflow-hidden rounded-2xl shadow-[0_14px_40px_rgb(0_0_0/0.35)]" style={rect ? { width: rect.width, alignSelf: mine ? "flex-end" : "flex-start" } : undefined}>
          {preview}
        </div>
      )}
      <div role="menu" aria-label="Message actions" className={cx("m-glass rounded-[14px] p-1", lift ? "w-[236px]" : "", lift && mine && "self-end")}>
        {actions.map((a, k) => (
          <div key={a.id}>
            {a.danger && k > 0 && <div className="mx-2 my-1 h-px bg-line" role="separator" />}
            <button
              type="button"
              role="menuitem"
              onClick={() => run(a)}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none",
                lift ? "h-11 text-[15px]" : "h-8 text-[14px]",
                a.danger ? "text-bad hover:bg-bad hover:text-white focus-visible:bg-bad focus-visible:text-white" : "hover:bg-accent hover:text-accent-ink focus-visible:bg-accent focus-visible:text-accent-ink",
              )}
            >
              <span className="shrink-0 opacity-80">{a.icon}</span>
              <span className="flex-1">{a.label}</span>
              {!lift && KEYS[a.id] && <span className="text-xs opacity-60">{KEYS[a.id]}</span>}
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return createPortal(
    <>
      <div
        role="presentation"
        data-closing={closing}
        className={cx("fixed inset-0 z-[60]", lift ? "m-lift-scrim bg-black/35 backdrop-blur-md" : "")}
        onMouseDown={() => close()}
        onTouchStart={() => close()}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      {menu}
    </>,
    document.body,
  );
}

/** The reactions on a message, as small badges on its top corner; tapping one adds or takes back yours. */
export function ReactionBadges({ reactions, meId, mine, onToggle }: { reactions: Reaction[]; meId?: string; mine: boolean; onToggle: (emoji: string) => void }) {
  const shown = reactions.filter((r) => r.actors.length);
  if (!shown.length) return null;
  return (
    <div className={cx("absolute -top-3.5 z-[1] flex gap-0.5", mine ? "-left-2.5" : "-right-2.5")}>
      {shown.map((r) => {
        const yours = !!meId && r.actors.some((a) => a.kind === "user" && a.id === meId);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            aria-label={`${r.emoji} ${r.actors.length}${yours ? ", including you" : ""}`}
            aria-pressed={yours}
            className={cx("m-react h-[26px] min-w-[26px] px-1.5 rounded-full border-2 border-panel inline-flex items-center justify-center gap-0.5 text-[13px] leading-none", yours ? "bg-accent-soft" : "bg-control")}
          >
            {r.emoji}
            {r.actors.length > 1 && <span className="text-[11px] text-muted">{r.actors.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Swipe a message to the right to open its thread: a finger on a touch screen, two fingers on a
 * trackpad. The message follows, a thread icon appears, and past ARM it opens on release.
 */
export const SWIPE_ARM = 64;
export function useSwipeToThread(onOpen: (() => void) | undefined) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; on: boolean } | null>(null);
  const wheel = useRef<{ dx: number; timer?: ReturnType<typeof setTimeout> }>({ dx: 0 });
  const armed = useRef(false);
  useEffect(() => () => clearTimeout(wheel.current.timer), []);
  const ease = (raw: number) => Math.min(raw <= SWIPE_ARM ? raw : SWIPE_ARM + (raw - SWIPE_ARM) * 0.35, 110);
  const follow = (next: number) => {
    const now = next >= SWIPE_ARM;
    if (now && !armed.current) navigator.vibrate?.(6);
    armed.current = now;
    setDx(next);
  };
  const release = () => {
    const open = armed.current;
    armed.current = false;
    setDragging(false);
    setDx(0);
    if (open) onOpen?.();
  };
  if (!onOpen) return { dx: 0, dragging: false, handlers: {} };
  return {
    dx,
    dragging,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        // the edge belongs to the browser's back swipe
        start.current = t.clientX > 24 ? { x: t.clientX, y: t.clientY, on: false } : null;
      },
      onTouchMove: (e: React.TouchEvent) => {
        const s = start.current;
        if (!s) return;
        const t = e.touches[0];
        const x = t.clientX - s.x;
        const y = t.clientY - s.y;
        if (!s.on) {
          if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return void (start.current = null);
          if (x > 12 && x > Math.abs(y) * 1.5) {
            s.on = true;
            setDragging(true);
          } else return;
        }
        follow(ease(Math.max(0, x)));
      },
      onTouchEnd: () => {
        if (start.current?.on) release();
        start.current = null;
      },
      onTouchCancel: () => {
        start.current = null;
        armed.current = false;
        setDragging(false);
        setDx(0);
      },
      onWheel: (e: React.WheelEvent) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        // code and tables that scroll sideways keep their own scrolling
        if ((e.target as HTMLElement).closest("pre, table, .overflow-x-auto")) return;
        const w = wheel.current;
        w.dx = Math.max(0, w.dx - e.deltaX);
        setDragging(true);
        follow(ease(w.dx));
        clearTimeout(w.timer);
        w.timer = setTimeout(() => {
          w.dx = 0;
          release();
        }, 140);
      },
    },
  };
}

/** Press and hold (touch only): runs `onPress` after about half a second without moving. */
export function useLongPress(onPress: () => void, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  if (!enabled) return {};
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        navigator.vibrate?.(8);
        onPress();
      }, 450);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 8) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    // the browser's own menu would open over ours
    onContextMenu: (e: React.MouseEvent) => {
      if (window.matchMedia("(hover: none)").matches) e.preventDefault();
    },
  };
}

/** "Delete this message?" Everyone sees "This message was deleted." instead; its thread stays. */
export function DeleteMessageDialog({ m, onClose }: { m: Message; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Delete this message?" label="Delete this message" onClose={onClose}>
      <p className="text-sm text-muted">Everyone will see “This message was deleted.” instead. Replies in its thread stay.</p>
      {m.body && <p className="mt-3 line-clamp-2 rounded-2xl bg-card px-3.5 py-2.5 text-sm">{m.body}</p>}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button onClick={onClose} className="h-11 rounded-full border border-control-line bg-control px-5 text-body font-medium">
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("DELETE", `/api/messages/${m.id}`);
              onClose();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
          className="h-11 rounded-full bg-bad px-5 text-body font-medium text-white disabled:opacity-50"
        >
          Delete message
        </button>
      </div>
    </Modal>
  );
}

/** Fix a sent message: Save puts "(edited)" next to its time. */
export function EditMessageDialog({ m, onClose }: { m: Message; onClose: () => void }) {
  const [text, setText] = useState(m.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a message that carries a file may lose its caption
  const canSave = !!text.trim() || m.parts.some((p) => p.type === "file");
  const save = async () => {
    if (text === m.body) return onClose();
    if (!canSave) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/messages/${m.id}`, { body: text });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit message" label="Edit message" onClose={onClose}>
      <textarea
        autoFocus
        rows={4}
        value={text}
        disabled={busy}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        className="block w-full resize-none rounded-2xl border border-control-line bg-control px-4 py-3 text-body outline-none focus:border-ring"
      />
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <p className="mr-auto text-xs text-faint">Others will see “(edited)” next to the time.</p>
        <button onClick={onClose} disabled={busy} className="h-11 rounded-full border border-control-line bg-control px-5 text-body font-medium">
          Cancel
        </button>
        <button onClick={() => void save()} disabled={busy || !canSave} className="h-11 rounded-full bg-accent px-5 text-body font-medium text-accent-ink disabled:opacity-50">
          Save
        </button>
      </div>
    </Modal>
  );
}
