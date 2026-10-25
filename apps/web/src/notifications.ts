import { useSyncExternalStore } from "react";
import type { ClientEvent } from "@wisp/core";
import { api } from "./api.ts";
import { go } from "./router.ts";
import { pushOnHere, reconcilePush, syncPushPrefs } from "./push.ts";
import type { useStore } from "./store.ts";

/**
 * Desktop notifications, set up per device (Settings → Notifications): the browser asks once for
 * permission, and Wisp then tells you about the things you choose, by default only while you're
 * looking at something else.
 */
export interface NotifyPrefs {
  enabled: boolean;
  /** an agent wrote to you in a DM */
  dms: boolean;
  /** an agent answered in a thread you started */
  replies: boolean;
  /** an agent wants your OK */
  approvals: boolean;
  /** an agent needs you on its computer (to sign in, a code…) */
  help: boolean;
  /** a task you handed off is done or failed */
  tasks: boolean;
  sound: boolean;
  /** only when Wisp isn't the window you're in */
  onlyAway: boolean;
}

const KEY = "wisp.notify";
const DEFAULTS: NotifyPrefs = { enabled: false, dms: true, replies: true, approvals: true, help: true, tasks: true, sound: false, onlyAway: true };
const listeners = new Set<() => void>();

function load(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}
let prefs = load();
let snap = JSON.stringify(prefs);

export const getNotifyPrefs = () => prefs;

export function setNotifyPrefs(patch: Partial<NotifyPrefs>) {
  const categoriesChanged = (["dms", "replies", "approvals", "help", "tasks"] as const).some((key) => patch[key] !== undefined && patch[key] !== prefs[key]);
  prefs = { ...prefs, ...patch };
  snap = JSON.stringify(prefs);
  try {
    localStorage.setItem(KEY, snap);
  } catch {}
  listeners.forEach((l) => l());
  if (categoriesChanged) void syncPushPrefs();
}

export function useNotifyPrefs(): NotifyPrefs {
  return JSON.parse(
    useSyncExternalStore(
      (l) => (listeners.add(l), () => listeners.delete(l)),
      () => snap,
    ),
  );
}

export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;
export const permission = (): NotificationPermission | "unsupported" => (notificationsSupported() ? Notification.permission : "unsupported");

/** Ask the browser, then turn notifications on if it said yes. */
export async function enableNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  setNotifyPrefs({ enabled: p === "granted" });
  return p;
}

let audio: AudioContext | null = null;
/** A short two-note chime, made on the spot (no sound file to load). */
export function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.3);
    }
  } catch {}
}

export function show(title: string, body: string, open?: () => void, opts: { test?: boolean } = {}) {
  if (!opts.test && (!prefs.enabled || permission() !== "granted")) return;
  if (!opts.test && prefs.onlyAway && document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const n = new Notification(title, { body: body.slice(0, 180), icon: "/icon-192.png", tag: `${title}:${body.slice(0, 40)}` });
    n.onclick = () => {
      window.wispDesktop?.focus();
      window.focus();
      open?.();
      n.close();
    };
  } catch {}
  if (prefs.sound) chime();
}

type State = ReturnType<typeof useStore.getState>;
const taskStatus = new Map<string, string>();

/** Remember where your tasks stand now, so a later change can be told apart. */
export function primeTasks() {
  void reconcilePush();
  void api<{ id: string; status: string }[]>("GET", "/api/tasks").then((tasks) => tasks.forEach((t) => taskStatus.set(t.id, t.status)), () => {});
}

/** Called with every event from the hub, with the app's state before and after it. */
export function notifyOn(e: ClientEvent, before: State, after: State) {
  if (!prefs.enabled || !after.me) return;
  const me = after.me.user.id;
  const agentName = (id: string | null) => after.agents.find((a) => a.id === id)?.name ?? "An agent";

  if (e.type === "message" && e.message.body.trim()) {
    const m = e.message;
    const ch = after.channels.find((c) => c.id === m.channelId);
    if (ch?.notify === "mute") return;
    const open = () => go({ view: "chat", channelId: m.channelId, threadId: m.threadId });
    if (ch?.notify === "all" && ch.joined) {
      if (m.author.id === "system" || (m.author.kind === "user" && m.author.id === me) || (m.author.kind === "agent" && pushOnHere())) return;
      const from = m.author.kind === "agent" ? agentName(m.author.id) : after.members.find((u) => u.id === m.author.id)?.name ?? "Someone";
      return show(ch.kind === "dm" ? from : `${from} in #${ch.name}`, m.body, open);
    }
    if (m.author.kind !== "agent") return;
    // with push on here, the hub's push notification covers DMs
    if (ch?.kind === "dm") return prefs.dms && !pushOnHere() ? show(agentName(m.author.id), m.body, open) : undefined;
    if (m.threadId && prefs.replies) {
      const root = Object.values(after.messages)
        .flat()
        .find((x) => x.id === m.threadId);
      if (root?.author.kind === "user" && root.author.id === me) show(`${agentName(m.author.id)} in a thread`, m.body, open);
    }
    return;
  }
  if (e.type === "approval" && prefs.approvals && !pushOnHere() && e.approval.status === "pending" && !before.approvals[e.approval.id]) {
    const a = e.approval;
    if (after.channels.some((c) => c.id === a.channelId && c.joined)) show(`${agentName(a.agentId)} wants your OK`, a.summary, () => go({ view: "chat", channelId: a.channelId, threadId: a.threadId }));
    return;
  }
  if (e.type === "computer" && prefs.help && e.computer.help && !before.computers.find((c) => c.id === e.computer.id)?.help) {
    const h = e.computer.help;
    show(`${agentName(h.agentId)} needs you on ${e.computer.name}`, h.request, () => go({ view: "computers", computerId: e.computer.id }));
    return;
  }
  if (e.type === "tasks_changed" && prefs.tasks) {
    void api<{ id: string; title: string; status: string; from: { kind: string; id: string }; toAgentId: string | null; channelId: string | null; threadId: string | null; result: string | null }[]>("GET", "/api/tasks").then(
      (tasks) => {
        for (const t of tasks) {
          const was = taskStatus.get(t.id);
          taskStatus.set(t.id, t.status);
          const finished = (t.status === "done" || t.status === "failed") && was && was !== t.status;
          if (finished && t.from.kind === "user" && t.from.id === me)
            show(`${agentName(t.toAgentId)} ${t.status === "done" ? "finished" : "couldn't finish"}: ${t.title}`, t.result ?? "", () => t.channelId && go({ view: "chat", channelId: t.channelId, threadId: t.threadId }));
        }
      },
      () => {},
    );
  }
}
