import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, ChevronLeft, ChevronRight, Hand, ListTodo, Loader2, ShieldQuestion, Users } from "lucide-react";
import type { Actor, Agent } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type LiveRun } from "../store.ts";
import { go, href } from "../router.ts";
import { AgentAvatar, Pill, StatusChip, cx, timeAgo } from "../components/ui.tsx";

/** The fields of a task the dashboard reads (GET /api/tasks). */
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

/**
 * A bit of everything: what each agent is doing, which teams are at work, where tasks stand,
 * and anything waiting on you. Everything here is fed live by the store's websocket events.
 */
export function DashboardView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const live = useStore((s) => s.live);
  const computers = useStore((s) => s.computers);
  const approvals = useStore((s) => s.approvals);
  const channels = useStore((s) => s.channels);
  const version = useStore((s) => s.tasksVersion);
  // Tasks is an addon (Settings → Addons); the section only shows once it is on
  const orchestration = useStore((s) => s.orchestration);
  // null = not loaded or tasks are unavailable (an optional addon); the section hides then
  const [tasks, setTasks] = useState<TaskLite[] | null>(null);

  useEffect(() => {
    let off = false;
    api<TaskLite[]>("GET", "/api/tasks").then(
      (list) => !off && setTasks(Array.isArray(list) ? list : null),
      () => !off && setTasks(null),
    );
    return () => {
      off = true;
    };
  }, [version]);

  const isGuest = me.role === "guest";
  const pending = Object.values(approvals).filter((a) => a.status === "pending");
  const helpNeeded = computers.filter((c) => c.help);
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
  const busyCount = agents.filter((a) => a.status === "busy").length;
  const onlineCount = agents.filter((a) => a.status !== "offline").length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">Dashboard</h1>
        {agents.length > 0 && (
          <span className="text-xs text-muted tabular-nums">
            {busyCount} working · {onlineCount} online · {agents.length} agents
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 md:p-6 space-y-8 max-w-6xl">
          {!isGuest && pending.length + helpNeeded.length > 0 && (
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

          <Section title="Agents" count={agents.length} more={{ label: "All agents", to: href({ view: "agents", agentId: null }) }}>
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

          <Section title="Teams" count={teams.length} more={{ label: "All teams", to: href({ view: "teams", teamId: null }) }}>
            {teams.length === 0 ? (
              <Blank>
                No teams yet. <a className="text-accent-text underline" href={href({ view: "teams", teamId: null })}>Make a team</a> to group agents who work together.
              </Blank>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {teams.map((t) => {
                  const members = t.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a);
                  const teamTasks = (tasks ?? []).filter((x) => x.teamId === t.id && (x.status === "in_progress" || x.status === "open"));
                  const active = members.some((a) => a.status === "busy") || teamTasks.some((x) => x.status === "in_progress");
                  return (
                    <a key={t.id} href={href({ view: "teams", teamId: t.id })} className="rounded-xl border border-line bg-panel p-3 hover:shadow-panel transition-shadow space-y-2 min-w-0 block">
                      <div className="flex items-center gap-2">
                        {t.emoji && <span>{t.emoji}</span>}
                        <span className="text-sm font-medium truncate flex-1">{t.name}</span>
                        {active ? <Pill tone="info">working</Pill> : <Pill>quiet</Pill>}
                      </div>
                      <div className="flex items-center gap-1">
                        {members.slice(0, 8).map((a) => (
                          <span key={a.id} title={`${a.name} (${a.status})`}>
                            <AgentAvatar agent={a} size={20} badge />
                          </span>
                        ))}
                        {members.length === 0 && <span className="text-xs text-muted">No members</span>}
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
            )}
          </Section>

          {tasks && orchestration?.enabled && (
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
      </div>
    </div>
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
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted flex-1">
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
