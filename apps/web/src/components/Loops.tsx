import { useState } from "react";
import { Check, Clock, CornerUpLeft, MessageCircle, Minus, X } from "lucide-react";
import type { Followup, Message, MessagePart } from "@wisp/core";
import { api } from "../api.ts";
import { usePrefs, useStore } from "../store.ts";
import { useChangedSinceMount } from "../motion.ts";
import { Menu, Modal, clockTime, cx } from "./ui.tsx";

type Pill = Extract<MessagePart, { type: "followup" }>;

/** "4:35 PM" today, "Tomorrow 9 AM", "Sat" this week, "Oct 30" after that. On the hour, no ":00". */
export function whenText(iso: string, now = new Date(), clock?: "auto" | "12h" | "24h"): string {
  const d = new Date(iso);
  const time = clockTime(d, clock).replace(/:00(?=\s|$)/, "");
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The quick times a reminder can move to: in an hour, tonight at 8 (while that's still ahead), tomorrow at 9. */
export function reminderTimes(now = new Date()): { label: string; at: Date }[] {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0);
  const out = [{ label: "In 1 hour", at: new Date(now.getTime() + 3_600_000) }];
  if (now.getHours() < 19) out.push({ label: "Tonight", at: at(0, 20) });
  out.push({ label: "Tomorrow morning", at: at(1, 9) });
  return out;
}

export const changeFollowup = (id: string, body: { dueAt?: string; status?: "done" | "cancelled" }) => api<Followup>("PATCH", `/api/followups/${id}`, body);

/** What a follow-up can do from a menu: move it, say it already happened, or drop it. */
export function useReminderItems(id: string, onPick: () => void) {
  const { clock } = usePrefs();
  // "Tomorrow morning · 9 AM", not "· Tomorrow 9 AM"
  const items = reminderTimes().map((t) => ({ label: `${t.label} · ${whenText(t.at.toISOString(), new Date(), clock).replace(/^Tomorrow /, "")}`, onSelect: () => void changeFollowup(id, { dueAt: t.at.toISOString() }) }));
  return [
    ...items,
    { label: "Pick a time…", onSelect: onPick },
    "divider" as const,
    { label: "Already done", icon: <Check size={15} className="text-ok" />, onSelect: () => void changeFollowup(id, { status: "done" }) },
    { label: "Don't remind me", icon: <X size={15} />, danger: true, onSelect: () => void changeFollowup(id, { status: "cancelled" }) },
  ];
}

/** A date and time of your choosing, on your own clock. */
export function PickTime({ title, dueAt, onClose, onPick }: { title: string; dueAt: string; onClose: () => void; onPick: (at: Date) => void }) {
  const local = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const [value, setValue] = useState(local(new Date(Math.max(Date.parse(dueAt), Date.now() + 3_600_000)).toISOString()));
  const at = new Date(value);
  const ok = !isNaN(at.getTime()) && at.getTime() > Date.now();
  return (
    <Modal title={title} onClose={onClose}>
      <label className="block text-[13px] text-muted mb-1.5" htmlFor="pick-time">
        When
      </label>
      <input id="pick-time" type="datetime-local" value={value} min={local(new Date().toISOString())} onChange={(e) => setValue(e.target.value)} className="w-full h-10 rounded-lg border border-control-line bg-control px-3 text-[14px]" />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="h-9 px-4 rounded-full border border-control-line bg-control text-[13px] font-medium hover:bg-hover">
          Cancel
        </button>
        <button
          disabled={!ok}
          onClick={() => {
            onPick(at);
            onClose();
          }}
          className="h-9 px-4 rounded-full bg-accent text-accent-ink text-[13px] font-medium disabled:opacity-40"
        >
          Set
        </button>
      </div>
    </Modal>
  );
}

/** A promise under the reply that made it: "Check the build · 4:35 PM". Tap it to move it or let it go. */
function FollowupPill({ p, animate }: { p: Pill; animate: boolean }) {
  const { clock } = usePrefs();
  const [picking, setPicking] = useState(false);
  const items = useReminderItems(p.followupId, () => setPicking(true));
  const icon = p.status === "done" ? <Check size={13} className="text-ok shrink-0" /> : p.status === "cancelled" ? <Minus size={13} className="shrink-0" /> : <Clock size={13} className="text-accent-chats shrink-0" />;
  const base = "inline-flex max-w-full items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-full border border-control-line bg-card text-[13px]";
  if (p.status !== "pending")
    return (
      <span className={cx(base, "text-faint", animate && "m-pill-in")}>
        {icon}
        <span className="truncate">{p.label}</span>
        <span className="shrink-0">· {p.status === "done" ? "done" : "cancelled"}</span>
      </span>
    );
  return (
    <>
      <Menu
        items={items}
        trigger={(open, toggle) => (
          <button onClick={toggle} aria-expanded={open} aria-label={`Reminder: ${p.label}, ${whenText(p.dueAt, new Date(), clock)}. Change or cancel`} className={cx(base, "text-muted hover:bg-hover m-press", animate && "m-pill-in")}>
            {icon}
            <b className="font-medium text-ink truncate">{p.label}</b>
            <span className="shrink-0">· {whenText(p.dueAt, new Date(), clock)}</span>
          </button>
        )}
      />
      {picking && <PickTime title={p.label} dueAt={p.dueAt} onClose={() => setPicking(false)} onPick={(at) => void changeFollowup(p.followupId, { dueAt: at.toISOString() })} />}
    </>
  );
}

/** "Checking back", over a message the agent wrote because something came due. */
export function CheckbackLabel() {
  return (
    <div className="px-1 pb-0.5 pt-1 text-[12px] text-faint inline-flex items-center gap-1">
      <CornerUpLeft size={12} aria-hidden /> Checking back
    </div>
  );
}

/** Quick answers to a check-back, while it's still the latest thing in the chat. Tapping one sends it. */
function QuickReplies({ channelId, replies }: { channelId: string; replies: string[] }) {
  const [sent, setSent] = useState(false);
  if (sent) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {replies.map((r, i) => (
        <button
          key={r}
          style={{ animationDelay: `${i * 50}ms` }}
          onClick={() => {
            setSent(true);
            void api("POST", `/api/channels/${channelId}/messages`, { body: r }).catch(() => setSent(false));
          }}
          className="m-chip-in h-8 px-3.5 rounded-full border border-control-line bg-card text-[13px] font-medium hover:bg-hover"
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/** What a finished chat came to: what got done, what was saved, what's next. */
function WrapUp({ p, animate }: { p: Extract<MessagePart, { type: "wrapup" }>; animate: boolean }) {
  const rows = [
    ["Did", p.did],
    ["Saved", p.saved],
    ["Next", p.next],
  ].filter(([, v]) => v);
  return (
    <div role="group" aria-label="Wrap-up" className={cx("mt-1.5 w-full max-w-sm rounded-xl border border-line bg-card px-3.5 py-3 flex flex-col gap-2", animate && "m-unfold")}>
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ok">
        <Check size={15} strokeWidth={2.4} /> Done
      </span>
      {rows.map(([k, v]) => (
        <span key={k} className="flex gap-2 text-[14px] leading-snug">
          <span className="w-11 shrink-0 text-faint">{k}</span>
          <span className="min-w-0">{v}</span>
        </span>
      ))}
    </div>
  );
}

/** Everything about open loops a message carries, under its bubble. */
export function LoopParts({ m, arrived }: { m: Message; arrived: boolean }) {
  const latest = useStore((s) => {
    const list = s.messages[m.channelId];
    const last = list?.filter((x) => x.author.id !== "system").at(-1);
    const busy = Object.values(s.live).some((r) => r.channelId === m.channelId);
    return last?.id === m.id && !busy;
  });
  const loopParts = m.parts.filter((p) => p.type === "followup" || p.type === "wrapup" || p.type === "closed");
  // parts that turn up after the message (a reply's pills come right after it) pop in; history doesn't
  const animate = useChangedSinceMount(loopParts.length) || arrived;
  const back = m.parts.find((p) => p.type === "checkback");
  const pills = m.parts.filter((p): p is Pill => p.type === "followup");
  return (
    <>
      {pills.length > 0 && (
        <div className="mt-1 flex flex-col items-start gap-1">
          {pills.map((p) => (
            <FollowupPill key={p.followupId} p={p} animate={animate} />
          ))}
        </div>
      )}
      {back?.type === "checkback" && back.replies.length > 0 && latest && <QuickReplies channelId={m.channelId} replies={back.replies} />}
      {m.parts.map((p, i) => p.type === "wrapup" && <WrapUp key={`w${i}`} p={p} animate={animate} />)}
    </>
  );
}

/** "Closed · not answered", centered under the message where the agent let a chat go. */
export function ClosedLine({ animate }: { animate: boolean }) {
  return (
    <div className={cx("flex justify-center py-1.5 text-[12px] text-faint", animate && "m-fade-in")}>
      <span className="inline-flex items-center gap-1.5">
        <Minus size={12} aria-hidden /> Closed · not answered
      </span>
    </div>
  );
}

/** A DM's line in the chat list, when it waits on you or its agent will come back to something. */
export function loopLine(c: { loop?: { status: string; summary: string } | null; next?: { label: string; dueAt: string; waitingOn: string } | null }, clock?: "auto" | "12h" | "24h") {
  if (c.loop?.status === "waiting") return { tone: "warn" as const, icon: <MessageCircle size={12} aria-hidden />, text: `Waiting on you${c.loop.summary ? ` · ${c.loop.summary}` : ""}` };
  // one that already came due waits for the list to catch up; don't show it as still coming
  if (c.next && c.next.waitingOn === "agent" && Date.parse(c.next.dueAt) > Date.now()) {
    // "Back at 4:35", "Back tomorrow 9 AM", "Back on Sat"
    const when = whenText(c.next.dueAt, new Date(), clock);
    const back = /^\d/.test(when) ? `at ${when}` : when.startsWith("Tomorrow") ? when.replace("Tomorrow", "tomorrow") : `on ${when}`;
    return { tone: "muted" as const, icon: <Clock size={12} aria-hidden />, text: `Back ${back} · ${c.next.label}` };
  }
  return null;
}
