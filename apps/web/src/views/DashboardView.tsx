import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, ChevronLeft, ChevronRight, Hand, ListTodo, Loader2, MessageSquare, Plus, ShieldQuestion } from "lucide-react";
import type { Actor, Agent } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, useTeams, useWaitingOnYou, type LiveRun } from "../store.ts";
import { useFeatures } from "../features.ts";
import { allowanceText, useAllowance } from "../changes.ts";
import { go, href } from "../router.ts";
import { AgentAvatar, Button, Pill, StatusChip, cx, timeAgo } from "../components/ui.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { NEXT_STEP, homeReadiness, useOnboarding } from "../onboarding.ts";
import { agentReadiness, useDevices } from "../devices.ts";
import { openDm as openHelperDm } from "../openDm.ts";
import { setupNextStep } from "../components/AgentPanel.tsx";

/** The fields of a task the Inbox reads (GET /api/tasks). */
interface TaskLite {
  id: string;
  from: Actor;
  toAgentId: string | null;
  title: string;
  status: "open" | "in_progress" | "done" | "failed";
  channelId: string | null;
  threadId: string | null;
  teamId: string | null;
  updatedAt: string;
}

const RECENT_MS = 60_000;


const EXAMPLE_PROMPTS = ["Plan dinners for this week and make a shopping list", "Help me write a polite note to my landlord about a repair", "Summarize a document I'll paste in"];

/**
 * The Inbox (route: dashboard): what's waiting on you first, then what agents are doing, then new
 * replies in your chats; under More options also every agent, teams and tasks (when those features are on).
 * Everything here is fed live by the store's websocket events.
 */
export function DashboardView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const teams = useTeams();
  const live = useStore((s) => s.live);
  const computers = useStore((s) => s.computers);
  const channels = useStore((s) => s.channels);
  const version = useStore((s) => s.tasksVersion);
  const features = useFeatures();
  // null = not loaded or tasks are unavailable; the section hides then
  const [tasks, setTasks] = useState<TaskLite[] | null>(null);

  useEffect(() => {
    if (!features.tasks) return setTasks(null);
    let off = false;
    api<TaskLite[]>("GET", "/api/tasks").then(
      (list) => !off && setTasks(Array.isArray(list) ? list : null),
      () => !off && setTasks(null),
    );
    return () => {
      off = true;
    };
  }, [version, features.tasks]);

  const isGuest = me.role === "guest";
  const waiting = useWaitingOnYou();
  const pending = waiting.approvals;
  const helpNeeded = waiting.help;
  const working = (tasks ?? []).filter((t) => t.status === "in_progress");
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent";
  const channelLabel = (id: string | null) => {
    const c = id ? channels.find((x) => x.id === id) : null;
    return !c ? null : c.kind === "dm" ? "in a DM" : `in #${c.name}`;
  };

  /** One line per agent: what it is doing right now, from the most specific source we have. */
  const doing = useMemo(() => {
    const runs = Object.values(live);
    const out: Record<string, { text: string; where: string | null } | null> = {};
    for (const a of agents) {
      const run: LiveRun | undefined = runs.find((r) => r.agentId === a.id);
      const task = working.find((t) => t.toAgentId === a.id);
      const comp = computers.find((c) => c.activity?.agentId === a.id && Date.now() - new Date(c.activity.at).getTime() < RECENT_MS);
      if (task) out[a.id] = { text: task.title, where: channelLabel(task.channelId) };
      else if (run) out[a.id] = { text: runSummary(run, agents), where: channelLabel(run.channelId) };
      else if (comp?.activity) out[a.id] = { text: comp.activity.text, where: `on ${comp.name}` };
      else out[a.id] = null;
    }
    return out;
    // channelLabel reads channels
  }, [agents, live, working, computers, channels]);

  const sortedAgents = useMemo(() => {
    const rank = { busy: 0, online: 1, offline: 2 } as const;
    return [...agents].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  }, [agents]);

  async function openDm(agent: Agent) {
    const existing = channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`));
    if (existing) return go({ view: "chat", channelId: existing.id, threadId: null });
    const ch = await api<{ id: string }>("POST", `/api/dm/${agent.id}`);
    await useStore.getState().refreshChannels();
    go({ view: "chat", channelId: ch.id, threadId: null });
  }

  const counts = { open: 0, in_progress: 0, done: 0, failed: 0 };
  for (const t of tasks ?? []) counts[t.status]++;
  // tasks this person handed off that haven't started or didn't finish
  const mineToCheck = (tasks ?? []).filter((t) => t.from.kind === "user" && t.from.id === me.user.id && (t.status === "open" || t.status === "failed"));
  // new replies: DMs first, then channels, most unread first
  const unreadChats = channels
    .filter((c) => (c.joined || c.kind === "dm") && c.unread > 0)
    .sort((a, b) => Number(b.kind === "dm") - Number(a.kind === "dm") || b.unread - a.unread)
    .slice(0, 8);
  // unread first, then most recently read
  const recentChats = channels
    .filter((c) => c.joined || c.kind === "dm")
    .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || (b.lastReadAt ?? "").localeCompare(a.lastReadAt ?? ""))
    .slice(0, 5);
  const chatName = (c: (typeof channels)[number]) => (c.kind === "dm" ? agentName(c.name.split(":").pop()!) : `#${c.name}`);
  const activeAgents = sortedAgents.filter((a) => doing[a.id] || a.status === "busy");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-lg font-bold tracking-tight flex-1 truncate">Inbox</h1>
        {features.background && <AllowancePill />}
        {/* phones have no sidebar button for this, so start a task from here */}
        {!isGuest && features.tasks && agents.length > 0 && (
          <Button variant="primary" className="md:hidden" onClick={() => useStore.setState({ newTaskOpen: true })}>
            <Plus size={16} /> New task
          </Button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 md:p-6 space-y-8 max-w-6xl">
          {pending.length + helpNeeded.length > 0 && (
            <Section title="Waiting on you" count={pending.length + helpNeeded.length}>
              <div className="rounded-xl border border-accent/50 bg-panel divide-y divide-line overflow-hidden">
                {helpNeeded.map((c) => (
                  <Row key={c.id} to={href({ view: "computers", computerId: c.id })} icon={<Hand size={16} className="text-warn" />}>
                    <span className="font-medium">{agentName(c.help!.agentId)}</span> needs you on {c.name}: <span className="text-muted">{c.help!.request}</span>
                  </Row>
                ))}
                {pending.map((p) => (
                  <Row key={p.id} to={href({ view: "chat", channelId: p.channelId, threadId: p.threadId })} icon={<ShieldQuestion size={16} className="text-warn" />}>
                    <span className="font-medium">{agentName(p.agentId)}</span> wants your OK: <span className="text-muted">{p.summary}</span>
                  </Row>
                ))}
              </div>
            </Section>
          )}

          {!isGuest && <ReadinessCard />}

          {/* only the agents at work, one line each (every agent is under More options below) */}
          {activeAgents.length > 0 && (
            <Section title="What agents are doing" count={activeAgents.length}>
              <div className="rounded-xl border border-line bg-panel divide-y divide-line overflow-hidden">
                {activeAgents.map((a) => {
                  const now = doing[a.id];
                  return (
                    <button key={a.id} onClick={() => openDm(a)} className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left hover:bg-hover min-w-0">
                      <AgentAvatar agent={a} size={22} live />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{a.name}</span> <span className="text-muted">{now ? `· ${now.text}${now.where ? ` ${now.where}` : ""}` : "· working"}</span>
                      </span>
                      <ChevronRight size={14} className="text-faint shrink-0" />
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          {unreadChats.length > 0 && (
            <Section title="New replies" count={unreadChats.reduce((n, c) => n + c.unread, 0)}>
              <div className="rounded-xl border border-line bg-panel divide-y divide-line overflow-hidden">
                {unreadChats.map((c) => (
                  <Row key={c.id} to={href({ view: "chat", channelId: c.id, threadId: null })} icon={<MessageSquare size={16} className="text-muted" />}>
                    <span className="font-medium">{chatName(c)}</span>
                    <span className="text-accent-text"> · {c.unread} new</span>
                  </Row>
                ))}
              </div>
            </Section>
          )}

          {/* guests only see conversations here, so say so rather than leave the page blank */}
          {isGuest && recentChats.length === 0 && <Blank>Conversations you're invited to show up here.</Blank>}

          {unreadChats.length === 0 && recentChats.length > 0 && (
            <Section title="Recent conversations">
              <div className="rounded-xl border border-line bg-panel divide-y divide-line overflow-hidden">
                {recentChats.map((c) => (
                  <Row key={c.id} to={href({ view: "chat", channelId: c.id, threadId: null })} icon={<MessageSquare size={16} className="text-muted" />}>
                    <span className="font-medium">{chatName(c)}</span>
                    {c.unread > 0 && <span className="text-accent-text"> · {c.unread} new</span>}
                  </Row>
                ))}
              </div>
            </Section>
          )}

          {!isGuest && features.tasks && mineToCheck.length > 0 && (
            <Section title="Tasks to check" count={mineToCheck.length}>
              <div className="rounded-xl border border-line bg-panel divide-y divide-line overflow-hidden">
                {mineToCheck.map((t) => (
                  <Row
                    key={t.id}
                    to={t.channelId ? href({ view: "chat", channelId: t.channelId, threadId: t.threadId }) : href({ view: "tasks" })}
                    icon={<ListTodo size={16} className={t.status === "failed" ? "text-bad" : "text-muted"} />}
                  >
                    <span className="font-medium">{t.title}</span>
                    <span className="text-muted">
                      {" "}
                      · {t.status === "failed" ? "didn't finish" : "not started"} · {timeAgo(t.updatedAt)}
                    </span>
                  </Row>
                ))}
              </div>
            </Section>
          )}

          {/* the rest is for people who run teams of agents */}
          <MoreOptions about="every agent, teams and tasks">
            <div className="space-y-8">
          <Section title="What agents are doing" count={agents.length} more={{ label: "All agents", to: href({ view: "agents", agentId: null }) }}>
            {agents.length === 0 ? (
              <Blank>
                No agents yet. <a className="text-accent-text underline" href={href({ view: "agents", agentId: null })}>Add your first agent</a> and it shows up here with what it's working on.
              </Blank>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {sortedAgents.map((a) => {
                  const now = doing[a.id];
                  return (
                    <button key={a.id} onClick={() => openDm(a)} className="text-left rounded-xl border border-line bg-panel p-3 hover:shadow-panel transition-shadow flex gap-3 min-w-0">
                      <AgentAvatar agent={a} size={36} live />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate flex-1">{a.name}</span>
                          <StatusChip status={a.status} />
                        </div>
                        {now ? (
                          <p className="text-xs leading-snug">
                            <span className="line-clamp-2">{now.text}</span>
                            {now.where && <span className="text-muted">{now.where}</span>}
                          </p>
                        ) : (
                          <p className="text-xs text-muted">{a.status === "offline" ? "Offline" : a.status === "busy" ? "Working" : "Not working on anything"}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>

          {/* each channel's team */}
          {teams.length > 0 && (
          <Section title="Teams" count={teams.length}>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {teams.map((t) => {
                  const members = t.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a);
                  const teamTasks = (tasks ?? []).filter((x) => x.teamId === t.id && (x.status === "in_progress" || x.status === "open"));
                  const active = members.some((a) => a.status === "busy") || teamTasks.some((x) => x.status === "in_progress");
                  return (
                    <a key={t.id} href={href({ view: "chat", channelId: t.channelId, threadId: null })} className="rounded-xl border border-line bg-panel p-3 hover:shadow-panel transition-shadow space-y-2 min-w-0 block">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate flex-1">#{t.name}</span>
                        {active ? <Pill tone="info">working</Pill> : <Pill>quiet</Pill>}
                      </div>
                      <div className="flex items-center gap-1">
                        {members.slice(0, 8).map((a) => (
                          <span key={a.id} title={`${a.name} (${a.status})`}>
                            <AgentAvatar agent={a} size={20} badge />
                          </span>
                        ))}
                        {members.length > 8 && <span className="text-xs text-muted">+{members.length - 8}</span>}
                      </div>
                      {teamTasks.length > 0 && (
                        <ul className="space-y-1">
                          {teamTasks.slice(0, 3).map((x) => (
                            <li key={x.id} className="text-xs flex items-center gap-1.5 min-w-0">
                              {x.status === "in_progress" ? <Loader2 size={12} className="animate-spin text-muted shrink-0" /> : <ListTodo size={12} className="text-faint shrink-0" />}
                              <span className="truncate">{x.title}</span>
                            </li>
                          ))}
                          {teamTasks.length > 3 && <li className="text-xs text-muted">and {teamTasks.length - 3} more</li>}
                        </ul>
                      )}
                    </a>
                  );
                })}
              </div>
          </Section>
          )}

          {tasks && (
            <Section title="Tasks" count={tasks.length} more={{ label: "Open Tasks", to: href({ view: "tasks" }) }}>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <Stat label="To do" value={counts.open} />
                <Stat label="Working" value={counts.in_progress} />
                <Stat label="Done" value={counts.done} />
                <Stat label="Failed" value={counts.failed} tone={counts.failed > 0 ? "bad" : undefined} />
              </div>
              {tasks.length === 0 ? (
                <Blank>
                  No tasks yet.{" "}
                  {!isGuest && (
                    <button className="text-accent-text underline" onClick={() => useStore.setState({ newTaskOpen: true })}>
                      Hand an agent some work
                    </button>
                  )}
                </Blank>
              ) : working.length === 0 ? (
                <Blank>No agent is on a task right now.</Blank>
              ) : (
                <div className="rounded-xl border border-line bg-panel divide-y divide-line overflow-hidden">
                  {working.map((t) => {
                    const agent = agents.find((a) => a.id === t.toAgentId);
                    return (
                      <Row
                        key={t.id}
                        to={t.channelId ? href({ view: "chat", channelId: t.channelId, threadId: t.threadId }) : href({ view: "tasks" })}
                        icon={agent ? <AgentAvatar agent={agent} size={20} /> : <Bot size={16} />}
                      >
                        <span className="font-medium">{t.title}</span>
                        <span className="text-muted">
                          {" "}
                          · {agent?.name ?? "an agent"} · {timeAgo(t.updatedAt)}
                        </span>
                      </Row>
                    );
                  })}
                </div>
              )}
            </Section>
          )}
            </div>
          </MoreOptions>
        </div>
      </div>
    </div>
  );
}

/** The lead card: finish setup, see what a helper is waiting on, or try a first question. */
function ReadinessCard() {
  const agents = useStore((s) => s.agents);
  const { done } = useOnboarding();
  const devices = useDevices();
  // devices are null while loading; show a quiet placeholder instead of guessing a state
  if (devices === null) return <div className="h-24 rounded-xl border border-line bg-chip animate-pulse" aria-hidden />;
  const r: ReturnType<typeof homeReadiness<Agent>> = homeReadiness(done, agents, devices);

  const box = "rounded-xl border border-line bg-accent-soft p-4 space-y-3";
  if (r.kind === "setup") {
    return (
      <section className={box} aria-labelledby="ready-h">
        <h2 id="ready-h" className="text-base font-semibold">
          Your helper isn't ready yet
        </h2>
        <p className="text-sm text-muted">Next: {NEXT_STEP[r.next]}</p>
        <Button variant="primary" onClick={() => go({ view: "welcome" })}>
          Continue setup
        </Button>
      </section>
    );
  }
  if (r.kind === "waiting") {
    // the fix depends on what's missing: a device, the device coming back, or the harness on it
    const next = setupNextStep(r.agent, devices);
    const onDevice = next?.href === href({ view: "computers", computerId: null });
    return (
      <section className={box} aria-labelledby="ready-h">
        <h2 id="ready-h" className="text-base font-semibold">
          {onDevice && r.deviceName ? `${r.agent.name} is waiting for ${r.deviceName}` : `${r.agent.name} isn't ready yet`}
        </h2>
        <p className="text-sm text-muted">{next ? next.text : r.problem}</p>
        <a
          className="inline-flex items-center h-9 rounded-full px-4 text-sm font-medium bg-accent text-accent-ink hover:bg-accent/90 outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          href={next?.href ?? href({ view: "computers", computerId: null })}
        >
          {next?.action ?? "See computers"}
        </a>
      </section>
    );
  }
  const agent = r.agent;
  return (
    <section className={box} aria-labelledby="ready-h">
      <h2 id="ready-h" className="text-base font-semibold">
        Try asking {agent.name}…
      </h2>
      <ul className="flex flex-col gap-2">
        {EXAMPLE_PROMPTS.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => void openHelperDm(agent.id, text)}
              className="w-full text-left rounded-lg border border-line bg-panel px-3 py-2 text-sm hover:bg-hover outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Pick one and it's ready in the chat. Change it if you like, then send.</p>
      <Button onClick={() => void openHelperDm(agent.id)}>Open chat</Button>
    </section>
  );
}

/** "Sending to @chief…", or the tail of what it's writing. */
function runSummary(r: LiveRun, agents: Agent[]): string {
  const last = r.last;
  if (last) {
    const input = (last.input ?? {}) as Record<string, unknown>;
    const to = typeof input.to === "string" ? input.to : typeof input.agent === "string" ? input.agent : null;
    if (to) return `Using ${last.name} → ${agents.find((a) => a.id === to || a.handle === to.replace(/^@/, ""))?.name ?? to}`;
    return `Using ${last.name}`;
  }
  const text = r.text.trim().split("\n").filter(Boolean).pop() ?? "";
  if (text) return text.length > 140 ? "…" + text.slice(-140) : text;
  return r.usedComputer ? "Using its computer" : "Thinking";
}

function Section({ title, count, more, children }: { title: string; count?: number; more?: { label: string; to: string }; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-muted flex-1">
          {title} {count !== undefined && <span className="tabular-nums text-faint">{count}</span>}
        </h2>
        {more && (
          <a href={more.to} className="text-xs text-muted hover:text-ink inline-flex items-center gap-0.5">
            {more.label} <ChevronRight size={13} />
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a href={to} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-hover min-w-0">
      <span className="shrink-0 grid place-items-center w-5">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={14} className="text-faint shrink-0" />
    </a>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2">
      <div className={cx("text-lg font-semibold tabular-nums", tone === "bad" && "text-bad")}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function Blank({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-3 py-4 text-sm text-muted">{children}</p>;
}

/** How much of today's background allowance is used, linking to Settings → Usage. */
function AllowancePill() {
  const [a] = useAllowance();
  if (!a) return null;
  const share = a.dailyTokens ? Math.min(100, (a.todayTokens / a.dailyTokens) * 100) : 0;
  return (
    <a href={href({ view: "settings", page: "usage" })} className="h-9 px-3.5 rounded-full bg-chip hover:bg-hover inline-flex items-center gap-2.5 text-[13px] font-bold">
      {a.dailyTokens && (
        <span className="w-14 h-1.5 rounded-full bg-line overflow-hidden" aria-hidden>
          <span className="block h-full bg-accent" style={{ width: `${share}%` }} />
        </span>
      )}
      {allowanceText(a)}
    </a>
  );
}
