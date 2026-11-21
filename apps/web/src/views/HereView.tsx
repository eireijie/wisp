import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, Blocks, Check, Clock, Eye, Monitor, Phone, UserRound, X } from "lucide-react";
import { FEATURE_INFO, FEATURE_PRESETS, FEATURE_KEYS, harnessLabel, type Agent, type FeatureKey, type Routine } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { setFeatures, useFeatures } from "../features.ts";
import { permission, useNotifyPrefs } from "../notifications.ts";
import { canRecognize, inDesktopApp } from "../voice/providers.ts";
import { setReadyItem, useOnboarding, useReadyChecklist, type ReadyItem } from "../onboarding.ts";
import { Modal, cx } from "../components/ui.tsx";
import { HOST_LOOK, HostGhost, hostReact } from "../components/onboarding/HostGhost.tsx";
import { DrawnCheck, useCountUp } from "../components/onboarding/obMotion.tsx";
import { useNarrow } from "../components/SetupShell.tsx";
import { hereSeenKey } from "../components/onboarding/FirstChat.tsx";
import { PhonePairing } from "./settings/mobile.tsx";
import { startNewAgent } from "../components/ChatList.tsx";
import { openDm } from "../openDm.ts";

/**
 * "Here's your Wisp" (#/here[/<agentId>], onboarding page 7): what setup really turned on, read from
 * the hub, ticking in one by one. Each row can be undone where Wisp has a way to (routines and
 * watches pause, mods turn off); what isn't ready says so with the one step that fixes it. On the
 * right, "When you're ready", which stays in the sidebar as "Finish setup" until it's done.
 */

interface Row {
  id: string;
  icon: ReactNode;
  title: string;
  sub: string;
  warn?: boolean;
  /** not done yet (no check, not counted as ready), without the warning colour */
  pending?: boolean;
  /** Undo/Redo: `off` is the undone state */
  toggle?: { off: boolean; run: (off: boolean) => Promise<void> };
  action?: { label: string; run: () => void };
}

type WatchRow = { id: string; label: string; agentIds: string[]; paused: boolean };

const ICON = { size: 17, strokeWidth: 1.7, "aria-hidden": true } as const;

function cronLine(schedule: string | null): string {
  if (!schedule) return "When you run it.";
  const m = schedule.trim().split(/\s+/);
  if (m.length === 5 && /^\d+$/.test(m[0]) && /^\d+$/.test(m[1]) && m[2] === "*" && m[3] === "*") {
    const t = `${m[1].padStart(2, "0")}:${m[0].padStart(2, "0")}`;
    if (m[4] === "*") return `Every day at ${t}.`;
    if (m[4] === "1-5") return `Weekdays at ${t}.`;
  }
  return "On a schedule.";
}

export function HereView({ agentId }: { agentId?: string | null }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const agent: Agent | undefined = useMemo(() => {
    if (agentId) return agents.find((a) => a.id === agentId);
    const mine = agents.filter((a) => a.settings.setup?.userId === me.user.id);
    return mine.sort((a, b) => Date.parse(b.settings.setup!.startedAt) - Date.parse(a.settings.setup!.startedAt))[0] ?? agents[0];
  }, [agentId, agents, me.user.id]);
  const { state: onboarding } = useOnboarding();
  const features = useFeatures();
  const notify = useNotifyPrefs();
  const ready = useReadyChecklist();
  const owner = me.role === "owner";

  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [watches, setWatches] = useState<WatchRow[] | null>(null);
  const [notes, setNotes] = useState<number | null>(null);
  const [openaiKey, setOpenaiKey] = useState<boolean | null>(null);
  const [shown, setShown] = useState(0);
  const [pairing, setPairing] = useState(false);
  // mods that were on when the page opened: undoing one keeps its row, as "Undone."
  // (calls have their own row below)
  const [mods] = useState<FeatureKey[]>(() => FEATURE_KEYS.filter((k) => features[k] && !FEATURE_PRESETS.simple[k]));

  const load = useCallback(() => {
    if (!agent) return;
    api<Routine[]>("GET", `/api/routines?agent=${agent.id}`).then(setRoutines, () => setRoutines([]));
    api<{ watches: WatchRow[] }>("GET", "/api/watches").then((r) => setWatches(r.watches.filter((w) => w.agentIds.includes(agent.id))), () => setWatches([]));
    api<{ path: string }[]>("GET", "/api/vault/notes").then(
      (all) => setNotes(all.filter((n) => (n.path.startsWith(`agents/${agent.id}/`) && !/\/(About|SOUL)\.md$/.test(n.path) && !/\/skills\//.test(n.path)) || n.path.startsWith(`people/${me.user.id}/`)).length),
      () => setNotes(null),
    );
  }, [agent, me.user.id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (inDesktopApp()) api<{ openaiKey: string }>("GET", "/api/voice/settings").then((s) => setOpenaiKey(!!s.openaiKey), () => setOpenaiKey(false));
  }, []);
  // the first look at this page ends in one celebration; coming back later doesn't repeat it
  const [firstLook] = useState(() => {
    try {
      return !agent || !localStorage.getItem(hereSeenKey(agent.id));
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (agent) try { localStorage.setItem(hereSeenKey(agent.id), "1"); } catch {}
    if (ready.workspaceId && !ready.started) setReadyItem(ready.workspaceId, "started", true);
  }, [agent, ready.workspaceId, ready.started]);

  const rows: Row[] = [];
  if (agent) {
    const knows = notes ? `Knows ${notes} thing${notes === 1 ? "" : "s"} about you.` : "Nothing in its notes yet.";
    rows.push({ id: "agent", icon: <UserRound {...ICON} />, title: agent.name, sub: `Runs on ${harnessLabel(agent.harness)}. ${knows}`, action: { label: "Change", run: () => go({ view: "agents", agentId: agent.id, tab: null }) } });
    const computer = agent.computerId ? onboarding?.computers.find((c) => c.id === agent.computerId) : undefined;
    if (computer) {
      const shared = agents.filter((a) => a.computerId === computer.id).length > 1;
      rows.push({ id: "computer", icon: <Monitor {...ICON} />, title: shared ? "Shared computer" : computer.name, sub: computer.status === "running" ? `Started. ${shared ? "Your agents take turns on it." : `${agent.name} works on it.`}` : `Starts when ${agent.name} needs it.`, action: { label: "Change", run: () => go({ view: "agents", agentId: agent.id, tab: null }) } });
    }
    for (const r of routines ?? []) {
      rows.push({
        id: `r:${r.id}`,
        icon: <Clock {...ICON} />,
        title: r.name,
        sub: cronLine(r.schedule),
        toggle: {
          off: !r.enabled,
          run: async (off) => {
            await api("PATCH", `/api/routines/${r.id}`, { enabled: !off });
            setRoutines((list) => list?.map((x) => (x.id === r.id ? { ...x, enabled: !off } : x)) ?? null);
          },
        },
      });
    }
    for (const w of watches ?? []) {
      rows.push({
        id: `w:${w.id}`,
        icon: <Eye {...ICON} />,
        title: `Watching ${w.label}`,
        sub: "Tells you when something needs you.",
        toggle: {
          off: w.paused,
          run: async (off) => {
            await api("PATCH", `/api/watches/${w.id}`, { paused: off });
            setWatches((list) => list?.map((x) => (x.id === w.id ? { ...x, paused: off } : x)) ?? null);
          },
        },
      });
    }
  }
  for (const k of mods) {
    rows.push({
      id: `m:${k}`,
      icon: <Blocks {...ICON} />,
      title: `${FEATURE_INFO[k].name} mod`,
      sub: "Turned on.",
      ...(owner ? { toggle: { off: !features[k], run: async (off: boolean) => void (await setFeatures({ [k]: !off })) } } : {}),
    });
  }
  const perm = permission();
  const notifOn = perm === "granted" && notify.enabled;
  rows.push({ id: "notif", icon: <Bell {...ICON} />, title: "Notifications", pending: !notifOn, sub: notifOn ? "On. Only when something's done or needs a yes." : perm === "denied" ? "Off. Blocked in this browser's settings." : "Off.", action: notifOn ? undefined : { label: "Settings", run: () => go({ view: "settings", page: "notifications" }) } });
  if (agent) {
    const listen = inDesktopApp() ? openaiKey : canRecognize();
    if (listen === true) rows.push({ id: "calls", icon: <Phone {...ICON} />, title: "Calls", sub: `Ready. Call ${agent.name} from the name pill.` });
    else if (listen === false)
      rows.push({
        id: "calls",
        icon: <Phone {...ICON} />,
        title: "Calls",
        sub: "Can't listen yet: needs an OpenAI key.",
        warn: true,
        action: { label: "Add key", run: () => go({ view: "settings", page: "voice" }) },
      });
  }

  // rows tick in one by one
  const loading = !!agent && (routines === null || watches === null);
  useEffect(() => {
    if (loading || shown >= rows.length) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return setShown(rows.length);
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 250 : 140);
    return () => clearTimeout(t);
  }, [loading, shown, rows.length]);

  const openItem = (id: ReadyItem) => {
    if (id === "phone") setPairing(true);
    else if (id === "logins") go({ view: "settings", page: "logins" });
    else if (id === "email") go({ view: "marketplace", section: "apps" });
    else startNewAgent();
  };
  const first = me.user.preferredName || me.user.name.split(" ")[0];
  // while the rows land the host stands big beside them, then settles above the title and celebrates once
  const narrow = useNarrow("(max-width: 767px)");
  const filling = loading || shown < rows.length;
  const readyCount = useCountUp(rows.slice(0, shown).filter((r) => !r.warn && !r.pending && !r.toggle?.off).length);
  const readyTotal = rows.filter((r) => !r.warn && !r.toggle?.off).length;
  const cheered = useRef(false);
  useEffect(() => {
    if (filling || cheered.current || !firstLook) return;
    cheered.current = true;
    const t = setTimeout(() => hostReact("celebrate"), 450);
    return () => clearTimeout(t);
  }, [filling, firstLook]);
  const look = agent?.settings.appearance ?? HOST_LOOK;

  return (
    <div className="here-page flex-1 overflow-y-auto bg-panel">
      <style>{HERE_STYLE}</style>
      <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-8 md:grid-cols-[minmax(0,1fr)_300px] md:px-8 md:py-12">
        <main className="min-w-0">
          {(narrow || !filling) && <HostGhost key="settled" look={look} size={64} happy={!filling} />}
          <h1 className="mt-4 text-[26px] font-semibold leading-tight tracking-[-0.01em] text-ink">Here's your Wisp, {first}.</h1>
          <p className="mt-1.5 text-[15px] text-muted">I set this up from your answers. Undo anything.</p>
          {readyTotal > 0 && (
            <p className="mt-3 text-[13px] text-muted tabular-nums" aria-live="polite" data-testid="here-count">
              <b className="font-semibold text-ink">{readyCount}</b> of {readyTotal} ready
            </p>
          )}
          <ul className="mt-6 overflow-hidden rounded-[18px] border border-line bg-panel" aria-live="polite">
            {rows.slice(0, shown).map((r, i) => {
              const off = !!r.toggle?.off;
              return (
                <li key={r.id} className={cx("here-pop flex items-center gap-3 px-4 py-3", i < Math.min(shown, rows.length) - 1 && "border-b border-line")}>
                  <span className={cx("grid size-9 shrink-0 place-items-center rounded-full bg-chip text-ink", off && "opacity-60")}>{r.icon}</span>
                  <div className={cx("min-w-0 flex-1", off && "opacity-60")}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-[14px] font-medium text-ink">{r.title}</span>
                      {!r.warn && !r.pending && !off && <DrawnCheck size={14} />}
                    </div>
                    <div className={cx("text-[13px] leading-5", r.warn ? "text-warn" : "text-muted")}>{off ? "Undone." : r.sub}</div>
                  </div>
                  {r.toggle && <UndoButton off={off} run={r.toggle.run} />}
                  {r.action && (
                    <button type="button" onClick={r.action.run} className="here-btn h-8 shrink-0 rounded-full border border-line2 px-3 text-[13px] text-ink hover:bg-hover">
                      {r.action.label}
                    </button>
                  )}
                </li>
              );
            })}
            {loading && <li className="px-4 py-3 text-[13px] text-faint">Checking…</li>}
          </ul>
          {agent && (
            <button type="button" onClick={() => (agent.settings.setup?.channelId ? go({ view: "chat", channelId: agent.settings.setup.channelId, threadId: null }) : void openDm(agent.id))} className="here-btn mt-6 h-10 rounded-full bg-ink px-5 text-[14px] font-medium text-panel">
              Back to {agent.name}
            </button>
          )}
        </main>
        <aside className="flex flex-col gap-4">
          {!narrow && filling && (
            <div className="grid place-items-center py-6">
              <HostGhost key="filling" look={look} size={150} mood="working" />
            </div>
          )}
          <section className="rounded-[18px] border border-line bg-card p-4" aria-labelledby="ready-list">
            <h2 id="ready-list" className="text-[15px] font-semibold text-ink">When you're ready</h2>
            <p className="mt-0.5 text-[13px] text-muted">This list stays in the sidebar until it's done.</p>
            <ul className="mt-3 flex flex-col">
              {ready.items.map((t) => (
                <li key={t.id} className="flex items-center gap-2.5 py-1.5">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={t.done}
                    aria-label={`${t.label}: ${t.done ? "done" : "not done"}`}
                    onClick={() => setReadyItem(ready.workspaceId, t.id, !t.done)}
                    className={cx("grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors", t.done ? "border-ink bg-ink text-panel" : "border-[var(--input)]")}
                  >
                    {t.done && <Check size={11} strokeWidth={2.4} aria-hidden />}
                  </button>
                  <button type="button" onClick={() => openItem(t.id)} className={cx("min-w-0 flex-1 truncate text-left text-[14px] hover:underline", t.done ? "text-muted line-through" : "text-ink")}>
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-[18px] border border-line p-4">
            <p className="text-[14px] leading-[22px] text-ink">Thanks for trying Wisp. Your agents will get things wrong sometimes. Tell them, and they'll remember.</p>
            <p className="mt-2 text-[13px] text-muted">The Wisp team</p>
          </section>
        </aside>
      </div>
      {pairing && (
        <Modal title="Get Wisp on your phone" onClose={() => setPairing(false)}>
          <PhonePairing autoStart compact />
        </Modal>
      )}
    </div>
  );
}

function UndoButton({ off, run }: { off: boolean; run: (off: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title={error ? "That didn't work. Try again." : undefined}
      onClick={async () => {
        setBusy(true);
        setError(false);
        try {
          await run(!off);
        } catch {
          setError(true);
        } finally {
          setBusy(false);
        }
      }}
      className={cx("here-btn h-8 shrink-0 rounded-full border px-3 text-[13px] hover:bg-hover disabled:opacity-60", error ? "border-bad text-bad" : "border-line2 text-ink")}
    >
      {error ? <X size={13} aria-label="Failed" /> : off ? "Redo" : "Undo"}
    </button>
  );
}

const HERE_STYLE = `
@keyframes here-pop{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:none}}
.here-pop{animation:here-pop .42s cubic-bezier(.22,1,.36,1) both}
.here-btn{transition:transform .15s ease,background .15s ease}
.here-btn:active{transform:scale(.97)}
@media (prefers-reduced-motion: reduce){.here-pop{animation:none}.here-btn{transition:none}}
`;
