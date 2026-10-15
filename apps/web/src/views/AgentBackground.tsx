import { useEffect, useState } from "react";
import { AppWindow, BellRing, Clock, FolderOpen, Monitor, Moon, RefreshCw, X } from "lucide-react";
import type { Agent, BackgroundSource, BackgroundWork, Followup } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { pushOnHere } from "../push.ts";
import { Intro } from "./SettingsParts.tsx";
import { Toggle } from "./settings/parts.tsx";
import { Button, Pill, Textarea, timeAgo } from "../components/ui.tsx";

const PACES = [
  [15, "every 15 minutes"],
  [30, "every 30 minutes"],
  [60, "every hour"],
  [120, "every 2 hours"],
  [240, "every 4 hours"],
] as const;

const at = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};

/**
 * An agent working in the background for you: it checks in on its own, looks at what it can
 * reach, and writes to you only when something needs you. You turn it on; it picks its pace.
 */
export function BackgroundPanel({ agent, active }: { agent: Agent; active: boolean }) {
  const version = useStore((s) => s.backgroundVersion);
  const offline = useStore((s) => s.agents.find((a) => a.id === agent.id)?.status === "offline");
  const [state, setState] = useState<{ background: BackgroundWork | null; followups: Followup[]; notAllowed: string | null; sources: BackgroundSource[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<NonNullable<typeof state>>("GET", `/api/agents/${agent.id}/background`).then(setState, (e) => setError((e as Error).message));
  useEffect(() => {
    if (active) void load();
  }, [active, agent.id, version]);

  const save = async (patch: Partial<Pick<BackgroundWork, "enabled" | "everyMinutes" | "focus" | "quietStart" | "quietEnd">>) => {
    setError(null);
    try {
      await api("PUT", `/api/agents/${agent.id}/background`, patch);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const checkNow = async () => {
    setError(null);
    await api("POST", `/api/agents/${agent.id}/background/check`).catch((e) => setError((e as Error).message));
    await load();
  };
  const cancel = async (f: Followup) => {
    await api("DELETE", `/api/followups/${f.id}`).catch((e) => setError((e as Error).message));
    await load();
  };

  const b = state?.background;
  const apps = state?.sources.filter((x) => x.kind === "app") ?? [];
  const on = !!b?.enabled;
  return (
    <div className="max-w-3xl space-y-5">
      <Intro title="Background">
        <p>
          @{agent.handle} keeps an eye on everything it can reach for you, on its own: your connected apps (email, calendars, drives, projects, to-do lists…), its computer, your memory and your conversations. It writes to you only when something needs you, with
          the work done and ready for your OK, and decides by itself when to look again.
        </p>
      </Intro>
      {error && <p className="text-sm text-bad">{error}</p>}
      {state === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : state.notAllowed ? (
        <p className="rounded-xl border border-line p-4 text-sm text-muted">{state.notAllowed}.</p>
      ) : (
        <>
          <div className="rounded-xl border border-line divide-y divide-line">
            <div className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1">
                <div className="font-medium">Work in the background for you</div>
                <div className="text-xs text-muted">Each check is a run of {agent.name}, so it uses your harness's plan like any other message.</div>
              </div>
              <Toggle label="Work in the background for you" on={on} onChange={(v) => void save({ enabled: v })} />
            </div>
            {b && (on || b.lastAt) && (
              <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <div className="flex-1 min-w-56 space-y-0.5">
                  <div className="flex items-center gap-2">
                    {b.checking ? <Pill tone={offline ? "warn" : "info"}>{offline ? "waiting for its device to come online" : "checking now"}</Pill> : b.lastAt ? <span className="text-muted">Last checked {timeAgo(b.lastAt)}</span> : <span className="text-muted">Hasn't checked yet</span>}
                    {on && !b.checking && b.nextAt && (
                      <span className="text-muted inline-flex items-center gap-1">
                        <Clock size={13} /> next {at(b.nextAt)}
                        {b.nextReason && <span>({b.nextReason})</span>}
                      </span>
                    )}
                  </div>
                  {b.lastNote && <div className="text-muted">Its note from last time: {b.lastNote}</div>}
                </div>
                <Button onClick={() => void checkNow()} disabled={b.checking}>
                  <RefreshCw size={14} /> Check now
                </Button>
              </div>
            )}
            {on && b && (
              <>
                <div className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
                  <div className="flex-1 min-w-56">
                    <div className="font-medium">When it doesn't say</div>
                    <div className="text-xs text-muted">It picks its own pace after each check, sooner while something's happening. This is the pace otherwise.</div>
                  </div>
                  <select className="h-8 rounded-lg border border-line bg-panel px-2" value={b.everyMinutes} onChange={(e) => void save({ everyMinutes: Number(e.target.value) })}>
                    {PACES.map(([m, label]) => (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    ))}
                    {!PACES.some(([m]) => m === b.everyMinutes) && <option value={b.everyMinutes}>every {b.everyMinutes} minutes</option>}
                  </select>
                </div>
                <div className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
                  <div className="flex-1 min-w-56">
                    <div className="font-medium inline-flex items-center gap-1.5">
                      <Moon size={14} /> Quiet hours
                    </div>
                    <div className="text-xs text-muted">No checks, and it only writes for something that can't wait. Follow-ups you asked for still happen.</div>
                  </div>
                  <input type="time" className="h-8 rounded-lg border border-line bg-panel px-2" value={b.quietStart} onChange={(e) => e.target.value && void save({ quietStart: e.target.value })} aria-label="Quiet hours start" />
                  <span className="text-muted">to</span>
                  <input type="time" className="h-8 rounded-lg border border-line bg-panel px-2" value={b.quietEnd} onChange={(e) => e.target.value && void save({ quietEnd: e.target.value })} aria-label="Quiet hours end" />
                </div>
              </>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">What to keep an eye on</h4>
            <Textarea
              rows={2}
              placeholder="Everything it can reach. Or say what matters most, like: my inbox and calendar, the launch project in Linear, anything from my landlord."
              value={focus ?? b?.focus ?? ""}
              onChange={(e) => setFocus(e.target.value)}
              onBlur={() => focus !== null && focus !== (b?.focus ?? "") && void save({ focus }).then(() => setFocus(null))}
            />
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">What it can see</h4>
            <div className="rounded-xl border border-line divide-y divide-line text-sm">
              {state.sources.map((x) => (
                <div key={`${x.kind}:${x.name}`} className="px-4 py-2 flex items-center gap-2.5">
                  {x.kind === "app" ? <AppWindow size={14} className="text-muted" /> : x.kind === "computer" ? <Monitor size={14} className="text-muted" /> : <FolderOpen size={14} className="text-muted" />}
                  <span className="font-medium">{x.name}</span>
                  <span className="text-muted truncate">{x.kind === "memory" ? "memory" : x.detail}</span>
                </div>
              ))}
              <div className="px-4 py-2 text-muted">
                {apps.length ? "Connect more apps" : "No apps yet. Connect your email, calendar, drive or project tools"} on{" "}
                <a className="text-accent-text hover:underline" href={href({ view: "connectors" })}>
                  Connectors
                </a>{" "}
                and let @{agent.handle} use them.{agent.computerId ? " It can also check sites you've signed in to on its computer." : ""}
              </div>
            </div>
          </div>

          {on && !pushOnHere() && (
            <p className="rounded-xl border border-line p-4 text-sm flex items-start gap-2">
              <BellRing size={15} className="mt-0.5 shrink-0 text-accent-text" />
              <span>
                To get its messages when Warren is closed, turn on{" "}
                <a className="text-accent-text hover:underline" href={href({ view: "settings", page: "notifications" })}>
                  push notifications
                </a>{" "}
                on your phone and computers.
              </span>
            </p>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Follow-ups</h4>
            {state.followups.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">None. Ask it to remind you of something, or to check back on something later, and it sets one.</p>
            ) : (
              <div className="rounded-xl border border-line divide-y divide-line">
                {state.followups.map((f) => (
                  <div key={f.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <span className="text-muted w-28 shrink-0">{at(f.dueAt)}</span>
                    <span className="flex-1">{f.note}</span>
                    <button type="button" className="p-1 rounded-md text-muted hover:text-ink hover:bg-hover" onClick={() => void cancel(f)} aria-label="Cancel this follow-up">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
