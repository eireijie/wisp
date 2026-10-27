import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, BellRing, Check, ChevronDown, ChevronRight, FolderOpen, Monitor, RefreshCw, X } from "lucide-react";
import type { Agent, BackgroundSource, BackgroundUsage, BackgroundWork, Followup, HarnessCatalog } from "@wisp/core";
import { effortName, prettyModel } from "../components/EffortSlider.tsx";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { pathLabel } from "../components/AccessDialog.tsx";
import { pushOnHere } from "../push.ts";
import { tokensText, useAllowance } from "../changes.ts";
import { Toggle } from "./settings/parts.tsx";
import { Button, Popover, Textarea, agentColor, cx, timeAgo } from "../components/ui.tsx";

const PACES = [
  [15, "every 15 minutes"],
  [30, "every 30 minutes"],
  [60, "every hour"],
  [120, "every 2 hours"],
  [240, "every 4 hours"],
] as const;

const CAPS = [6, 12, 24, 48, 96] as const;

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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "10pm", "7:30am" */
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

/** A setting's current value; clicking it opens a small picker right under it. */
function Choice({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  return (
    <Popover
      inline
      up={false}
      align="right"
      className="w-72 p-1.5"
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} className={cx("max-w-64 h-8 pl-3 pr-2 rounded-lg inline-flex items-center gap-1 text-muted hover:text-ink hover:bg-hover", open && "bg-hover text-ink")}>
          <span className="truncate">{label}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      )}
    >
      {children}
    </Popover>
  );
}

function Pick({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("w-full h-10 px-3 rounded-lg flex items-center justify-between text-left text-body font-medium hover:bg-hover", on && "bg-chip")}>
      {children}
      {on && <Check size={15} />}
    </button>
  );
}

/**
 * An agent working in the background for you: it checks in on its own, looks at what it can
 * reach, and writes to you only when something needs you. A few settings as a plain list;
 * the rest under More, or you just tell the agent.
 */
export function BackgroundPanel({ agent, active, onDirty }: { agent: Agent; active: boolean; onDirty?: (dirty: boolean) => void }) {
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
  const dirty = focus !== null && focus !== (state?.background?.focus ?? "");
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
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
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
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
  const watch = (b?.focus ?? "").trim().replace(/[.\s]+$/, "") || "Everything it can reach";
  const mine = allowance?.agents.find((a) => a.agentId === agent.id);
  const failed = !!b?.lastNote && /fail|error|isn't signed in|can't/i.test(b.lastNote);
  const share = allowance?.dailyTokens && mine ? Math.round((mine.tokens / allowance.dailyTokens) * 100) : null;

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="t-title">Background</h2>
        </div>
        {state && !state.notAllowed && (
          <span className="mt-1.5">
            <Toggle label="Work in the background for you" on={on} onChange={(v) => void save({ enabled: v })} />
          </span>
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {state === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : state.notAllowed ? (
        <p className="rounded-xl border border-line p-4 text-sm text-muted">{state.notAllowed}.</p>
      ) : (
        <>
          {b && (on || b.lastAt) && (
            <div className="rounded-xl border border-line px-4 py-3 flex items-center gap-3">
              <span className={cx("size-2 shrink-0 rounded-full", b.checking ? (offline ? "bg-warn" : "bg-ok animate-pulse") : failed ? "bg-warn" : on ? "bg-ok" : "bg-faint")} aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium">
                  {b.checking ? (offline ? "Waiting for its device" : "Checking now") : b.lastAt ? `Checked ${timeAgo(b.lastAt)}` : "Hasn't checked yet"}
                  {on && !b.checking && b.nextAt && <span className="font-normal text-muted"> · next {at(b.nextAt)}</span>}
                </div>
                {!b.checking && b.lastNote && <div className={cx("mt-0.5 text-xs line-clamp-2", failed ? "text-warn" : "text-muted")}>{b.lastNote}</div>}
              </div>
              <Button onClick={() => void checkNow()} disabled={b.checking}>
                <RefreshCw size={14} /> Check now
              </Button>
            </div>
          )}

          <div className={cx("rounded-xl border border-line divide-y divide-line", !on && "opacity-60")}>
            <Setting label="Watches">
              <Choice label={watch}>
                {(close) => (
                  <div className="p-1.5 space-y-2">
                    <Textarea rows={3} autoFocus placeholder="Everything it can reach. Or: my inbox and calendar, anything from my landlord." value={focus ?? b?.focus ?? ""} onChange={(e) => setFocus(e.target.value)} />
                    <Button
                      variant="primary"
                      className="w-full"
                      onClick={() => {
                        if (focus !== null) {
                          const submitted = focus;
                          void save({ focus }).then((ok) => {
                            if (ok) {
                              setFocus((current) => current === submitted ? null : current);
                              close();
                            }
                          });
                        } else close();
                      }}
                    >
                      Save
                    </Button>
                  </div>
                )}
              </Choice>
            </Setting>
            <Setting label="Checks">
              <Choice label={cap(PACES.find(([m]) => m === every)?.[1] ?? `every ${every} minutes`)}>
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
                      {cap(label)}
                    </Pick>
                  ))
                }
              </Choice>
            </Setting>
            <Setting label="Quiet hours">
              <Choice label={quietStart === quietEnd ? "None" : `${clock(quietStart)} – ${clock(quietEnd)}`}>
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
              </Choice>
            </Setting>
            {allowance && (
              <a href={href({ view: "settings", page: "usage" })} className="flex items-center gap-3 px-4 h-12 text-sm hover:bg-hover rounded-b-xl">
                <span className="flex-1 font-medium">Today</span>
                <span className="text-muted">{share !== null ? `${share}% of the allowance` : mine ? tokensText(mine.tokens) : "Nothing used yet"}</span>
                <span className="w-16 h-1.5 rounded-full bg-chip overflow-hidden">
                  <span className="block h-full rounded-full" style={{ width: `${Math.min(100, share ?? 0)}%`, background: agentColor(agent) }} />
                </span>
                <ChevronRight size={15} className="text-faint" />
              </a>
            )}
          </div>

          {state.followups.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Coming up</h3>
              <div className="rounded-xl border border-line divide-y divide-line">
                {state.followups.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 px-4 h-11 text-sm">
                    <span className="text-muted w-28 shrink-0">{at(f.dueAt)}</span>
                    <span className="flex-1 truncate">{f.note}</span>
                    <button type="button" className="p-1 rounded-md text-muted hover:text-ink hover:bg-hover" onClick={() => void cancel(f)} aria-label="Cancel this follow-up">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <details className="group">
            <summary className="list-none cursor-pointer inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
              <ChevronRight size={14} className="transition-transform group-open:rotate-90" /> More
            </summary>
            <div className="mt-3 rounded-xl border border-line divide-y divide-line text-sm">
              <Setting label="Model for checks">
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
              </Setting>
              <Setting label="Most checks a day">
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
              </Setting>
              <div className="px-4 py-3 space-y-2">
                <div className="font-medium">Can see</div>
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
              <div className="px-4 py-3">
                <UsageLine usage={state.usage} cap={b?.dailyCap ?? null} simple={false} />
              </div>
              {on && !pushOnHere() && (
                <a className="flex items-center gap-1.5 px-4 py-3 text-accent-text hover:underline" href={href({ view: "settings", page: "notifications" })}>
                  <BellRing size={14} /> Get its messages on your phone
                </a>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

/** One setting: its name on the left, the value (or control) on the right. */
function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 min-h-12 py-2 text-sm">
      <span className="flex-1 font-medium">{label}</span>
      <span className="flex items-center gap-2 min-w-0">{children}</span>
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
