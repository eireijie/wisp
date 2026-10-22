import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, BellRing, Check, ChevronRight, FolderOpen, Monitor, RefreshCw, X } from "lucide-react";
import type { Agent, BackgroundSource, BackgroundUsage, BackgroundWork, Followup, HarnessCatalog } from "@warren/core";
import { effortName, prettyModel } from "../components/EffortSlider.tsx";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { pathLabel } from "../components/AccessDialog.tsx";
import { pushOnHere } from "../push.ts";
import { tokensText, useAllowance } from "../changes.ts";
import { Toggle } from "./settings/parts.tsx";
import { Button, Pill, Popover, Textarea, agentColor, cx, timeAgo } from "../components/ui.tsx";

const PACES = [
  [15, "every 15 minutes"],
  [30, "every 30 minutes"],
  [60, "every hour"],
  [120, "every 2 hours"],
  [240, "every 4 hours"],
] as const;

const CAPS = [6, 12, 24, 48, 96] as const;

/** One plain sentence on what background work means, for the Simple view. */
export function backgroundSummary({ name, scope, everyMinutes, dailyCap, enabled }: { name: string; scope: string; everyMinutes: number; dailyCap: number | null; enabled: boolean }): string {
  const what = scope.trim().replace(/[.\s]+$/, "") || "everything it can reach";
  const pace = PACES.find(([m]) => m === everyMinutes)?.[1] ?? `every ${everyMinutes} minutes`;
  const limit = dailyCap ? `at most ${dailyCap} ${dailyCap === 1 ? "time" : "times"} a day` : "with no daily limit";
  const head = enabled ? "While" : "If you turn this on, while";
  return `${head} you're away, ${name} ${enabled ? "will" : "would"} check ${what} ${pace}, ${limit}, and ${enabled ? "" : "would "}message you when something needs you.`;
}

/** A memory folder as a person would name it: "agents/agt_x/" becomes "@handle". */
const folderName = (path: string, agents: Agent[], members: { id: string; name: string }[]) => {
  const p = path.replace(/\/+$/, "");
  return pathLabel(p, agents, members) || p.split("/").pop() || p;
};

/** 38,400 → "38k", 2,100,000 → "2.1M" */
const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const at = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};

/** "10pm", "7:30am" */
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

/** A word in the sentence that opens a small picker right under it. */
function Word({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  return (
    <Popover
      inline
      up={false}
      className="w-72 p-1.5"
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} className={cx("rounded-lg px-1.5 font-extrabold underline decoration-faint decoration-2 underline-offset-[5px] hover:bg-chip", open ? "bg-chip" : "bg-chip/60")}>
          {label}
        </button>
      )}
    >
      {children}
    </Popover>
  );
}

function Pick({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("w-full h-10 px-3 rounded-lg flex items-center justify-between text-left text-[15px] font-semibold hover:bg-hover", on && "bg-chip")}>
      {children}
      {on && <Check size={15} />}
    </button>
  );
}

/**
 * An agent working in the background for you: it checks in on its own, looks at what it can
 * reach, and writes to you only when something needs you. The settings read as one sentence;
 * each underlined word opens a picker. Anything else is under More, or you just tell the agent.
 */
export function BackgroundPanel({ agent, active }: { agent: Agent; active: boolean }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const timezone = useStore((s) => s.me?.user.timezone);
  const version = useStore((s) => s.backgroundVersion);
  const offline = useStore((s) => s.agents.find((a) => a.id === agent.id)?.status === "offline");
  const [allowance] = useAllowance();
  const [state, setState] = useState<{ background: BackgroundWork | null; followups: Followup[]; notAllowed: string | null; sources: BackgroundSource[]; usage: BackgroundUsage; defaultDailyCap: number } | null>(null);
  const [catalog, setCatalog] = useState<HarnessCatalog | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<NonNullable<typeof state>>("GET", `/api/agents/${agent.id}/background`).then(setState, (e) => setError((e as Error).message));
  useEffect(() => {
    if (active) void load();
  }, [active, agent.id, version]);
  // the same models the agent's Model tab offers
  useEffect(() => {
    if (active) api<{ catalog: HarnessCatalog | null }>("GET", `/api/agents/${agent.id}/models`).then((r) => setCatalog(r.catalog), () => setCatalog(null));
  }, [active, agent.id, agent.nodeId]);

  const save = async (patch: Partial<Pick<BackgroundWork, "enabled" | "everyMinutes" | "focus" | "quietStart" | "quietEnd" | "model" | "effort" | "dailyCap">>) => {
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
  const models = catalog?.models ?? [];
  const chosen = models.find((m) => m.id === (b?.model ?? agent.model));
  const efforts = chosen?.efforts ?? catalog?.efforts ?? [];
  const on = !!b?.enabled;
  const every = b?.everyMinutes ?? 60;
  const quietStart = b?.quietStart ?? "22:00";
  const quietEnd = b?.quietEnd ?? "07:00";
  const watch = (b?.focus ?? "").trim().replace(/[.\s]+$/, "") || "everything it can reach";
  const mine = allowance?.agents.find((a) => a.agentId === agent.id);
  const share = allowance?.dailyTokens && mine ? Math.round((mine.tokens / allowance.dailyTokens) * 100) : null;

  return (
    <div className="max-w-2xl space-y-7">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-2xl font-extrabold">Background</h2>
        {state && !state.notAllowed && <Toggle label="Work in the background for you" on={on} onChange={(v) => void save({ enabled: v })} />}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {state === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : state.notAllowed ? (
        <p className="rounded-xl border border-line p-4 text-sm text-muted">{state.notAllowed}.</p>
      ) : (
        <>
          <div className={cx("text-[21px] leading-[1.9] font-semibold", !on && "text-muted")}>
            While you're away, {agent.name} checks{" "}
            <Word label={watch}>
              {(close) => (
                <div className="p-1.5 space-y-2">
                  <Textarea rows={3} autoFocus placeholder="Everything it can reach. Or: my inbox and calendar, anything from my landlord." value={focus ?? b?.focus ?? ""} onChange={(e) => setFocus(e.target.value)} />
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => {
                      if (focus !== null) void save({ focus }).then(() => setFocus(null));
                      close();
                    }}
                  >
                    Save
                  </Button>
                </div>
              )}
            </Word>{" "}
            <Word label={PACES.find(([m]) => m === every)?.[1] ?? `every ${every} minutes`}>
              {(close) =>
                PACES.map(([m, label]) => (
                  <Pick
                    key={m}
                    on={m === every}
                    onClick={() => {
                      void save({ everyMinutes: m });
                      close();
                    }}
                  >
                    {label}
                  </Pick>
                ))
              }
            </Word>
            , stays quiet{" "}
            <Word label={quietStart === quietEnd ? "never" : `${clock(quietStart)}–${clock(quietEnd)}`}>
              {(close) => (
                <div className="p-1.5 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <input type="time" className="h-9 flex-1 rounded-lg border border-line bg-panel px-2" value={quietStart} onChange={(e) => e.target.value && void save({ quietStart: e.target.value })} aria-label="Quiet hours start" />
                    <span className="text-muted">to</span>
                    <input type="time" className="h-9 flex-1 rounded-lg border border-line bg-panel px-2" value={quietEnd} onChange={(e) => e.target.value && void save({ quietEnd: e.target.value })} aria-label="Quiet hours end" />
                  </div>
                  <Pick
                    on={quietStart === quietEnd}
                    onClick={() => {
                      void save({ quietEnd: quietStart });
                      close();
                    }}
                  >
                    No quiet hours
                  </Pick>
                  {!timezone && (
                    <a className="block px-3 text-xs text-accent-text hover:underline" href={href({ view: "settings", page: "profile" })}>
                      Set your time zone (now UTC)
                    </a>
                  )}
                </div>
              )}
            </Word>
            , and messages you when something needs you.
          </div>

          {b && (on || b.lastAt) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <span className="flex-1 min-w-56 text-muted">
                {b.checking ? (
                  <Pill tone={offline ? "warn" : "info"}>{offline ? "waiting for its device" : "checking now"}</Pill>
                ) : b.lastAt ? (
                  <>
                    Checked {timeAgo(b.lastAt)}
                    {b.lastNote && `: ${b.lastNote}`}
                  </>
                ) : (
                  "Hasn't checked yet"
                )}
                {on && !b.checking && b.nextAt && ` · next ${at(b.nextAt)}`}
              </span>
              <Button onClick={() => void checkNow()} disabled={b.checking}>
                <RefreshCw size={14} /> Check now
              </Button>
            </div>
          )}

          {allowance && (
            <a href={href({ view: "settings", page: "usage" })} className="flex items-center gap-3 rounded-2xl bg-bg px-4 py-3.5 text-sm font-bold hover:bg-hover">
              <span className="w-24 h-2 rounded-full bg-chip overflow-hidden">
                <span className="block h-full rounded-full" style={{ width: `${Math.min(100, share ?? 0)}%`, background: agentColor(agent) }} />
              </span>
              <span className="flex-1">{share !== null ? `${agent.name} used ${share}% of today's allowance` : mine ? `${agent.name} used ${tokensText(mine.tokens)} today` : `${agent.name} hasn't used any of today's allowance`}</span>
              <ChevronRight size={16} className="text-muted" />
            </a>
          )}

          {state.followups.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-[15px] font-extrabold text-muted">Coming up</h3>
              {state.followups.map((f) => (
                <div key={f.id} className="flex items-center gap-3 h-10 border-b border-line text-sm">
                  <span className="text-muted w-28 shrink-0 font-bold text-[13px]">{at(f.dueAt)}</span>
                  <span className="flex-1 truncate">{f.note}</span>
                  <button type="button" className="p-1 rounded-md text-muted hover:text-ink hover:bg-hover" onClick={() => void cancel(f)} aria-label="Cancel this follow-up">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </section>
          )}

          <details className="border-t border-line pt-3.5 group">
            <summary className="cursor-pointer text-sm font-bold text-muted hover:text-ink">More</summary>
            <div className="pt-3 space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-32 font-semibold">Model for checks</span>
                <select aria-label="Model for background checks" className="h-8 rounded-lg border border-line bg-panel px-2 max-w-52" value={b?.model ?? ""} onChange={(e) => void save({ model: e.target.value || null, effort: null })}>
                  <option value="">{agent.model ? `${agent.name}'s own (${prettyModel(models.find((m) => m.id === agent.model)?.label ?? agent.model)})` : `${agent.name}'s own model`}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {prettyModel(m.label)}
                    </option>
                  ))}
                  {b?.model && !models.some((m) => m.id === b.model) && <option value={b.model}>{b.model}</option>}
                </select>
                <select aria-label="Reasoning effort for background checks" className="h-8 rounded-lg border border-line bg-panel px-2" value={b?.effort ?? ""} onChange={(e) => void save({ effort: e.target.value || null })}>
                  <option value="">Default effort</option>
                  {efforts.map((x) => (
                    <option key={x} value={x}>
                      {effortName(x)} effort
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-32 font-semibold">Most checks a day</span>
                <select aria-label="Most checks a day" className="h-8 rounded-lg border border-line bg-panel px-2" value={b ? (b.dailyCap ?? "") : state.defaultDailyCap} onChange={(e) => void save({ dailyCap: e.target.value ? Number(e.target.value) : null })}>
                  {[...new Set<number>([...CAPS, ...(b?.dailyCap ? [b.dailyCap] : [])])]
                    .sort((x, y) => x - y)
                    .map((n) => (
                      <option key={n} value={n}>
                        {n} a day
                      </option>
                    ))}
                  <option value="">No limit</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <span className="font-semibold">Can see</span>
                <div className="flex flex-wrap gap-1.5">
                  {state.sources.map((x) => (
                    <span key={`${x.kind}:${x.name}`} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-chip text-[13px]">
                      {x.kind === "app" ? <AppWindow size={13} /> : x.kind === "computer" ? <Monitor size={13} /> : <FolderOpen size={13} />}
                      {x.kind === "memory" ? folderName(x.name, agents, members) : x.name}
                    </span>
                  ))}
                  <a href={href({ view: "connectors" })} className="inline-flex items-center h-7 px-2.5 rounded-full border border-line text-[13px] hover:bg-hover">
                    Connect an app
                  </a>
                </div>
              </div>
              <UsageLine usage={state.usage} cap={b?.dailyCap ?? null} simple={false} />
              {on && !pushOnHere() && (
                <a className="inline-flex items-center gap-1.5 text-accent-text hover:underline" href={href({ view: "settings", page: "notifications" })}>
                  <BellRing size={14} /> Get its messages on your phone
                </a>
              )}
            </div>
          </details>

          <p className="text-sm text-muted">Or just tell {agent.name}, like "check less on weekends".</p>
        </>
      )}
    </div>
  );
}

/** What the checks used, as far as the harness says: "Last check: 38k tokens · Today: 410k · This week: 2.1M". */
function UsageLine({ usage, cap, simple }: { usage: BackgroundUsage; cap: number | null; simple: boolean }) {
  const known = usage.lastTokens !== null || usage.todayTokens !== null || usage.weekTokens !== null;
  const parts = [
    usage.lastTokens !== null && `Last check: ${tokens(usage.lastTokens)} tokens`,
    usage.todayTokens !== null && `Today: ${tokens(usage.todayTokens)}`,
    usage.weekTokens !== null && `This week: ${tokens(usage.weekTokens)}`,
  ].filter(Boolean);
  return (
    <div className="text-xs text-muted">
      {known ? parts.join(" · ") : simple ? "Cost per check isn't reported." : "Token use: not reported by this harness."}
      {usage.checksToday > 0 && `${known ? " · " : " "}${usage.checksToday}${cap ? ` of ${cap}` : ""} ${usage.checksToday === 1 && !cap ? "check" : "checks"} today`}
    </div>
  );
}
