import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, CornerUpLeft, MessageSquare, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { Message } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Modal, cx } from "./ui.tsx";

/**
 * What you can do with a message: Reply, Reply in thread, Copy, Pin, Edit, Delete. A hover
 * toolbar on desktops and a sheet from a long-press on phones draw the same list.
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
  if (m.body) list.push({ id: "copy", label: "Copy text", icon: <Copy size={16} />, run: () => void navigator.clipboard?.writeText(m.body) });
  if (canPin) list.push({ id: "pin", label: pinned ? "Unpin" : "Pin to team", icon: pinned ? <PinOff size={16} /> : <Pin size={16} />, run: () => void api(pinned ? "DELETE" : "PUT", `/api/messages/${m.id}/pin`).catch((e) => alert((e as Error).message)) });
  if (mine && writable && m.body) list.push({ id: "edit", label: "Edit", icon: <Pencil size={16} />, run: opts.onEdit });
  if ((mine || owner) && writable) list.push({ id: "delete", label: "Delete", icon: <Trash2 size={16} />, danger: true, run: opts.onDelete });
  return list;
}

/** The hover toolbar: one icon for each action, on the message's top edge. */
export function ActionToolbar({ actions, side, onDone }: { actions: MessageAction[]; side: "left" | "right"; onDone?: () => void }) {
  if (!actions.length) return null;
  return (
    <div role="toolbar" aria-label="Message actions" className={cx("absolute -top-4 z-10 hidden group-hover:flex group-focus-within:flex items-center rounded-xl border border-control-line bg-control shadow-panel p-0.5", side === "right" ? "right-4 md:right-5" : "left-12 md:left-14")}>
      {actions.map((a) => (
        <button
          key={a.id}
          onClick={() => {
            a.run();
            onDone?.();
          }}
          aria-label={a.label}
          title={a.label}
          className={cx("size-8 rounded-lg grid place-items-center hover:bg-hover", a.danger ? "text-bad" : "text-muted hover:text-ink")}
        >
          {a.icon}
        </button>
      ))}
    </div>
  );
}

/** A long-press on a phone: the message lifted over a dimmed chat, its actions below. */
export function ActionSheet({ actions, preview, onClose }: { actions: MessageAction[]; preview: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end gap-3 bg-black/55 p-4 pb-8 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="presentation">
      <div className="max-h-[40vh] overflow-hidden pointer-events-none flex flex-col">{preview}</div>
      <div role="menu" aria-label="Message actions" className="glass rounded-3xl p-1.5">
        {actions.map((a) => (
          <button
            key={a.id}
            role="menuitem"
            onClick={() => {
              onClose();
              a.run();
            }}
            className={cx("w-full h-12 px-4 rounded-2xl flex items-center gap-3 text-[15px] hover:bg-hover", a.danger && "text-bad")}
          >
            <span className="flex-1 text-left">{a.label}</span>
            {a.icon}
          </button>
        ))}
      </div>
    </div>
  );
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
        <button onClick={onClose} className="h-11 rounded-full border border-control-line bg-control px-5 text-[15px] font-medium">
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
          className="h-11 rounded-full bg-bad px-5 text-[15px] font-medium text-white disabled:opacity-50"
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
        className="block w-full resize-none rounded-2xl border border-control-line bg-control px-4 py-3 text-[15px] outline-none focus:border-ring"
      />
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <p className="mr-auto text-xs text-faint">Others will see “(edited)” next to the time.</p>
        <button onClick={onClose} disabled={busy} className="h-11 rounded-full border border-control-line bg-control px-5 text-[15px] font-medium">
          Cancel
        </button>
        <button onClick={() => void save()} disabled={busy || !canSave} className="h-11 rounded-full bg-accent px-5 text-[15px] font-medium text-accent-ink disabled:opacity-50">
          Save
        </button>
      </div>
    </Modal>
  );
}
