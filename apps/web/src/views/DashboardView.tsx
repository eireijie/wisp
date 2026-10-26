import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Circle, CircleCheck, CircleX, Plus } from "lucide-react";
import type { Actor, Agent, Approval } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, useTeams, useWaitingOnYou, usePrefs, type LiveRun } from "../store.ts";
import { useFeatures } from "../features.ts";
import { allowanceText, useAllowance } from "../changes.ts";
import { go, href } from "../router.ts";
import { AgentAvatar, StatusChip, cx, timeAgo } from "../components/ui.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { UserAvatarButton } from "../components/Rail.tsx";
import { ChatAvatar, shortTime } from "../components/ChatList.tsx";
import { ApprovalNeedCard, CardButton, runSummary, GroupCard, HelpNeedCard, LoginNeedCard, Rule, SectionHead, useHelpSeen, helpKey } from "../components/InboxParts.tsx";
import { NEXT_STEP, homeReadiness, setupProgress, useOnboarding } from "../onboarding.ts";
import { useDevices } from "../devices.ts";
import { openDm as openHelperDm } from "../openDm.ts";
import { setupNextStep } from "../components/AgentPanel.tsx";
import { cleanPreview } from "../components/CommandPalette.tsx";

/** The fields of a task the Inbox reads (GET /api/tasks). */
interface TaskLite {
  id: string;
  from: Actor;
  toAgentId: string | null;
  title: string;
  status: "open" | "in_progress" | "done" | "failed";
  result?: string | null;
  channelId: string | null;
  threadId: string | null;
  teamId: string | null;
  updatedAt: string;
}

const RECENT_MS = 60_000;
const DAY_MS = 86_400_000;

const EXAMPLE_PROMPTS = ["Plan dinners for this week and make a shopping list", "Help me write a polite note to my landlord about a repair", "Summarize a document I'll paste in"];

const sameDay = (iso: string | null | undefined) => !!iso && new Date(iso).toDateString() === new Date().toDateString();

/**
 * The Inbox (route: dashboard): what's waiting on you first (approvals, logins, a hand on a
 * computer), then what agents are doing, new replies, tasks to check and teams. "Done" is the
 * history of what you decided and what finished. Everything is fed live by the store's websocket events.
 */
export function DashboardView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const teams = useTeams();
  const live = useStore((s) => s.live);
  const computers = useStore((s) => s.computers);
  const channels = useStore((s) => s.channels);
  const approvals = useStore((s) => s.approvals);
  const members = useStore((s) => s.members);
  const version = useStore((s) => s.tasksVersion);
  const features = useFeatures();
  const prefs = usePrefs();
  const helpSeen = useHelpSeen();
  const [tab, setTab] = useState<"needs" | "done">("needs");
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
  // "Not now" on a help request hides it here (it stays in the chat and on Computers)
  const helpNeeded = waiting.help.filter((c) => !helpSeen.includes(helpKey(c)));
  const needsCount = pending.length + helpNeeded.length;
  const working = (tasks ?? []).filter((t) => t.status === "in_progress");
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent";
  const channelLabel = (id: string | null) => {
    const c = id ? channels.find((x) => x.id === id) : null;
    return !c ? null : c.kind === "dm" ? "in a DM" : `in ${c.name}`;
  };

  /** One line per agent: what it is doing right now, from the most specific source we have. */
  const doing = useMemo(() => {
    const runs = Object.values(live);
    const out: Record<string, { text: string; where: string | null } | null> = {};
    for (const a of agents) {
      const run: LiveRun | undefined = runs.find((r) => r.agentId === a.id);
      const task = working.find((t) => t.toAgentId === a.id);
      const comp = computers.find((c) => c.activity?.agentId === a.id && Date.now() - new Date(c.activity.at).getTime() < RECENT_MS);
      const place = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ") || null;
      if (task) out[a.id] = { text: task.title, where: place(comp ? `on ${comp.name}` : null, channelLabel(task.channelId)) };
      else if (run) out[a.id] = { text: runSummary(run, agents), where: place(comp ? `on ${comp.name}` : null, channelLabel(run.channelId)) };
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
  // tasks this person handed off that haven't started, didn't finish, or just finished and wait for a look
  const isCancelled = (t: TaskLite) => t.status === "failed" && !!t.result?.startsWith("Cancelled");
  const mineToCheck = (tasks ?? []).filter(
    (t) => t.from.kind === "user" && t.from.id === me.user.id && !isCancelled(t) && (t.status === "open" || t.status === "failed" || (t.status === "done" && Date.now() - Date.parse(t.updatedAt) < 2 * DAY_MS)),
  );
  // new replies: DMs first, then channels, most unread first
  const unreadChats = channels
    .filter((c) => (c.joined || c.kind === "dm") && c.unread > 0)
    .sort((a, b) => Number(b.kind === "dm") - Number(a.kind === "dm") || b.unread - a.unread)
    .slice(0, 8);
  // unread first, then most recently active
  const recentAll = channels
    .filter((c) => (c.joined || c.kind === "dm") && !c.archivedAt)
    .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || (b.last?.at ?? b.lastReadAt ?? "").localeCompare(a.last?.at ?? a.lastReadAt ?? ""));
  const [moreRecent, setMoreRecent] = useState(false);
  const recentChats = recentAll.slice(0, moreRecent ? 20 : 5);
  const activeAgents = sortedAgents.filter((a) => doing[a.id] || a.status === "busy");
  const chatName = (c: (typeof channels)[number]) => (c.kind === "dm" ? agentName(c.name.split(":").pop()!) : c.name);
  const chatAvatar = (c: (typeof channels)[number], size: number) => {
    const agent = c.kind === "dm" ? agents.find((a) => a.id === c.name.split(":").pop()) : null;
    return <ChatAvatar chat={{ kind: c.kind === "dm" ? "dm" : "team", agent: agent ?? null, channel: c }} size={size} />;
  };
  const chatRow = (c: (typeof channels)[number], title: string) => (
    <a key={c.id} href={href({ view: "chat", channelId: c.id, threadId: null })} className="flex items-center gap-3 min-h-16 px-4 py-2 hover:bg-hover min-w-0">
      <span className="shrink-0 w-[46px] grid place-items-center">{chatAvatar(c, 40)}</span>
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-base font-semibold">{title}</span>
          <span className="text-[13px] text-faint shrink-0">{c.last ? shortTime(Date.parse(c.last.at), prefs.clock) : ""}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-faint flex-1">{c.last ? cleanPreview(c.last.body, 90) : "No messages yet"}</span>
          {c.unread > 0 && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-badge text-badge-ink text-[11px] font-semibold grid place-items-center tabular-nums">{c.unread}</span>}
        </span>
      </span>
    </a>
  );

  const nothingElse = activeAgents.length + unreadChats.length + recentChats.length + mineToCheck.length === 0;
  const newTask = () => useStore.setState({ newTaskOpen: true });
  const canNewTask = !isGuest && features.tasks && agents.length > 0;

  const switcher = (
    <div role="tablist" aria-label="Inbox" className="flex rounded-full bg-chip/60 dark:bg-[#222225] p-1 max-md:w-full">
      {(
        [
          ["needs", `Needs you${needsCount ? ` · ${needsCount}` : ""}`],
          ["done", "Done"],
        ] as const
      ).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx("h-9 md:h-8 px-3.5 rounded-full text-sm md:text-[13px] max-md:flex-1 transition-colors", tab === id ? "bg-card dark:bg-[#34343a] text-ink font-semibold" : "text-muted font-medium hover:text-ink")}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 px-[18px] md:px-7 pt-3 md:pt-[30px] pb-2 safe-top">
        <div className="mx-auto max-w-[820px] flex items-center gap-3 justify-between">
          {onBack ? (
            <button className="md:hidden! circle" onClick={onBack} aria-label="Back">
              <ChevronRight size={22} className="rotate-180" />
            </button>
          ) : (
            <span className="md:hidden">
              <UserAvatarButton size={52} />
            </span>
          )}
          <h1 className="text-xl md:text-[28px] font-bold tracking-tight md:flex-1 max-md:text-center">Inbox</h1>
          <span className="hidden md:flex items-center gap-3">
            {switcher}
            {canNewTask && (
              <button onClick={newTask} className="circle" aria-label="New task" title="New task">
                <Plus size={20} strokeWidth={2} />
              </button>
            )}
          </span>
          {canNewTask ? (
            <button onClick={newTask} className="md:hidden! circle" aria-label="New task">
              <Plus size={22} strokeWidth={2} />
            </button>
          ) : (
            <span className="md:hidden w-[52px]" />
          )}
        </div>
        <div className="md:hidden pt-1">{switcher}</div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-[18px] md:px-7 pt-2 pb-28 md:pb-10 flex flex-col gap-3">
          {tab === "done" ? (
            <DoneTab approvals={Object.values(approvals)} tasks={tasks} />
          ) : (
            <>
              {!isGuest && <ReadinessCard />}

              {needsCount > 0 ? (
                <>
                  <SectionHead title="Needs you" right={needsCount} />
                  {helpNeeded.map((c) => (
                    <HelpNeedCard key={c.id} computer={c} />
                  ))}
                  {pending.map((p) => (p.login ? <LoginNeedCard key={p.id} approval={p} /> : <ApprovalNeedCard key={p.id} approval={p} />))}
                </>
              ) : (
                <CaughtUp guest={isGuest} compact={!nothingElse} />
              )}

              {/* only the agents at work, one line each (every agent is under More options below) */}
              {activeAgents.length > 0 && (
                <>
                  <SectionHead title="What agents are doing" right={`${activeAgents.length} working`} />
                  <GroupCard className="py-1.5 px-3.5">
                    {activeAgents.map((a, i) => {
                      const now = doing[a.id];
                      return (
                        <div key={a.id}>
                          {i > 0 && <div className="h-px bg-line" />}
                          <button onClick={() => openDm(a)} className="w-full flex items-center gap-3 px-1 py-2 text-left min-w-0 rounded-2xl hover:bg-hover">
                            <AgentAvatar agent={a} size={36} live />
                            <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                              <span className="text-base font-semibold">{a.name}</span>
                              <span className="text-sm text-ok truncate">{now?.text ?? "Working"}</span>
                              {now?.where && <span className="text-[13px] text-faint truncate">{now.where}</span>}
                            </span>
                            <span className="flex gap-1" aria-hidden>
                              {[0, 1, 2].map((n) => (
                                <i key={n} className="size-1.5 rounded-full bg-ok animate-pulse" style={{ animationDelay: `${n * 200}ms` }} />
                              ))}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </GroupCard>
                </>
              )}

              {unreadChats.length > 0 && (
                <>
                  <SectionHead title="New replies" right={unreadChats.reduce((n, c) => n + c.unread, 0)} />
                  <GroupCard>
                    {unreadChats.map((c, i) => (
                      <div key={c.id}>
                        {i > 0 && <Rule />}
                        {chatRow(c, c.kind === "dm" ? `${chatName(c)} replied to you` : chatName(c))}
                      </div>
                    ))}
                  </GroupCard>
                </>
              )}

              {/* guests only see conversations here, so say so rather than leave the page blank */}
              {isGuest && recentAll.length === 0 && <p className="rounded-3xl border border-dashed border-line px-4 py-4 text-sm text-muted">Conversations you're invited to show up here.</p>}

              {unreadChats.length === 0 && recentChats.length > 0 && (
                <>
                  <SectionHead
                    title="Recent conversations"
                    right={
                      recentAll.length > 5 && (
                        <button onClick={() => setMoreRecent(!moreRecent)} className="hover:text-ink">
                          {moreRecent ? "Show less" : "Show more"}
                        </button>
                      )
                    }
                  />
                  <GroupCard>
                    {recentChats.map((c, i) => (
                      <div key={c.id}>
                        {i > 0 && <Rule />}
                        {chatRow(c, chatName(c))}
                      </div>
                    ))}
                  </GroupCard>
                </>
              )}

              {!isGuest && features.tasks && mineToCheck.length > 0 && (
                <>
                  <SectionHead title="Tasks to check" right={mineToCheck.length} />
                  <GroupCard>
                    {mineToCheck.map((t, i) => {
                      const who = t.toAgentId ? agentName(t.toAgentId) : "an agent";
                      const sub = t.status === "failed" ? `Failed · ${who}` : t.status === "done" ? `Done by ${who} · ready to review` : `Not started · ${who}`;
                      return (
                        <div key={t.id}>
                          {i > 0 && <Rule />}
                          <a href={t.channelId ? href({ view: "chat", channelId: t.channelId, threadId: t.threadId }) : href({ view: "tasks" })} className="flex items-center gap-3 min-h-16 px-4 py-2 hover:bg-hover min-w-0">
                            {t.status === "done" ? <CircleCheck size={26} strokeWidth={1.8} className="text-ok shrink-0" /> : t.status === "failed" ? <CircleX size={26} strokeWidth={1.8} className="text-bad shrink-0" /> : <Circle size={26} strokeWidth={1.8} className="text-faint shrink-0" />}
                            <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-base font-semibold">{t.title}</span>
                                <span className="text-[13px] text-faint shrink-0">{timeAgo(t.updatedAt)}</span>
                              </span>
                              <span className="truncate text-sm text-faint">{sub}</span>
                            </span>
                          </a>
                        </div>
                      );
                    })}
                  </GroupCard>
                </>
              )}

              {teams.length > 0 && (
                <>
                  <SectionHead title="Teams" />
                  <GroupCard>
                    {teams.map((t, i) => {
                      const members = t.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a);
                      const teamTasks = (tasks ?? []).filter((x) => x.teamId === t.id && (x.status === "in_progress" || x.status === "open"));
                      const busy = members.find((a) => a.status === "busy");
                      const active = !!busy || teamTasks.some((x) => x.status === "in_progress");
                      const channel = channels.find((c) => c.id === t.channelId);
                      return (
                        <div key={t.id}>
                          {i > 0 && <Rule />}
                          <a href={href({ view: "chat", channelId: t.channelId, threadId: null })} className="flex items-center gap-3 min-h-16 px-4 py-2 hover:bg-hover min-w-0">
                            <span className="shrink-0 w-[46px] grid place-items-center">
                              <ChatAvatar chat={{ kind: "team", agent: null, channel: channel ?? null }} size={40} />
                            </span>
                            <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                              <span className="truncate text-base font-semibold">{t.name}</span>
                              <span className="truncate text-sm text-faint">{active ? `Working${busy ? ` · ${busy.name} is on it` : ""}` : "Quiet"}</span>
                            </span>
                          </a>
                        </div>
                      );
                    })}
                  </GroupCard>
                </>
              )}

              {tasks && (
                <>
                  <SectionHead title="Tasks" />
                  <GroupCard className="flex py-3.5 px-2">
                    {(
                      [
                        ["To do", counts.open, false],
                        ["Working", counts.in_progress, false],
                        ["Done", counts.done, false],
                        ["Failed", counts.failed, counts.failed > 0],
                      ] as const
                    ).map(([label, n, bad]) => (
                      <span key={label} className="flex-1 text-center flex flex-col gap-0.5">
                        <span className={cx("text-[22px] font-bold tabular-nums", bad && "text-bad")}>{n}</span>
                        <span className="text-xs text-faint">{label}</span>
                      </span>
                    ))}
                  </GroupCard>
                  {tasks.length === 0 && <p className="text-sm text-muted px-1.5">No tasks yet. {canNewTask && <button className="underline hover:text-ink" onClick={newTask}>Hand an agent some work</button>}</p>}
                  {tasks.length > 0 && working.length === 0 && <p className="text-sm text-muted px-1.5">No agent is on a task right now.</p>}
                  <div className="flex justify-center">
                    <CardButton onClick={() => go({ view: "tasks" })}>Open Tasks</CardButton>
                  </div>
                </>
              )}

              {features.background && <AllowanceRow />}

              {/* every agent, quiet or not, for people who run a team of them */}
              {agents.length > 0 && (
                <MoreOptions about="every agent" className="mt-1">
                  <div className="grid gap-2 md:grid-cols-2">
                    {sortedAgents.map((a) => {
                      const now = doing[a.id];
                      return (
                        <button key={a.id} onClick={() => openDm(a)} className="text-left rounded-2xl bg-card border border-line p-3 hover:bg-hover transition-colors flex gap-3 min-w-0">
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
                  <p className="mt-2 text-xs">
                    <a className="text-muted hover:text-ink" href={href({ view: "agents", agentId: null })}>
                      All agents
                    </a>
                  </p>
                </MoreOptions>
              )}
              {agents.length === 0 && !isGuest && (
                <p className="text-sm text-muted px-1.5">
                  No agents yet. <a className="underline hover:text-ink" href={href({ view: "agents", agentId: null })}>Add your first agent</a> and it shows up here with what it's working on.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "All caught up": nothing needs you. */
function CaughtUp({ guest, compact }: { guest: boolean; compact: boolean }) {
  return (
    <div className={cx("flex flex-col items-center gap-3.5 text-center px-6", compact ? "py-6" : "py-24 md:py-32")}>
      <svg width={compact ? 56 : 84} height={compact ? 56 : 84} viewBox="0 0 24 24" aria-hidden className="text-faint">
        <path d="M12 2.5a7.5 7.5 0 0 0-7.5 7.5v11l2.5-1.7 2.5 1.7 2.5-1.7 2.5 1.7 2.5-1.7 2.5 1.7V10A7.5 7.5 0 0 0 12 2.5z" fill="currentColor" />
        <circle cx="9.5" cy="10.5" r="1.3" fill="var(--panel)" />
        <circle cx="14.5" cy="10.5" r="1.3" fill="var(--panel)" />
      </svg>
      <h2 className={cx("font-bold tracking-tight", compact ? "text-xl" : "text-2xl")}>All caught up</h2>
      <p className="text-[15px] text-muted leading-snug max-w-xs">Nothing needs you right now. {guest ? "Conversations you're invited to show up here." : "When an agent wants your OK or needs you on its computer, it shows up here."}</p>
      {!compact && <CardButton onClick={() => go({ view: "chats" })}>Open Chats</CardButton>}
    </div>
  );
}

/** What you decided and what finished: the Inbox's history. */
function DoneTab({ approvals, tasks }: { approvals: Approval[]; tasks: TaskLite[] | null }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const prefs = usePrefs();
  const decided = approvals
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))
    .slice(0, 30);
  const finished = (tasks ?? []).filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);

  const line = (a: Approval) => {
    const who = a.decidedBy === me.user.id || !a.decidedBy ? "You" : (members.find((m) => m.id === a.decidedBy)?.name ?? "Someone");
    const what = a.login ? `sign-in to ${a.login.site}` : a.summary;
    if (a.login) return a.status === "approved" ? `${who} allowed ${what}` : `${who} said not now to ${what}`;
    return a.status === "approved" ? `${who} approved ${what}` : `${who} said not now to ${what}`;
  };
  const group = (title: string, rows: { key: string; agent: Agent | undefined; text: string; at: string }[]) =>
    rows.length > 0 && (
      <>
        <SectionHead title={title} />
        <GroupCard className="px-3.5 py-1">
          {rows.map((r, i) => (
            <div key={r.key} className={cx("flex items-center gap-3 px-1 py-2.5", i > 0 && "border-t border-line")}>
              <AgentAvatar agent={r.agent} size={28} interactive={false} />
              <span className="flex-1 min-w-0 text-[15px] leading-snug break-words">{r.text}</span>
              <span className="text-[13px] text-faint shrink-0">{shortTime(Date.parse(r.at), prefs.clock)}</span>
            </div>
          ))}
        </GroupCard>
      </>
    );
  const dRows = decided.map((a) => ({ key: a.id, agent: agents.find((x) => x.id === a.agentId), text: line(a), at: a.decidedAt ?? a.createdAt }));
  const tRows = finished.map((t) => ({ key: t.id, agent: agents.find((x) => x.id === t.toAgentId), text: `${agents.find((x) => x.id === t.toAgentId)?.name ?? "An agent"} finished ${t.title}`, at: t.updatedAt }));
  if (dRows.length + tRows.length === 0) return <p className="py-16 text-center text-sm text-muted">Nothing yet. What you decide and what agents finish shows up here.</p>;
  return (
    <>
      {group("Decided today", dRows.filter((r) => sameDay(r.at)))}
      {group("Decided earlier", dRows.filter((r) => !sameDay(r.at)))}
      {group("Done today", tRows.filter((r) => sameDay(r.at)))}
      {group("Done earlier", tRows.filter((r) => !sameDay(r.at)))}
    </>
  );
}

/** The lead card: finish setup, see what a helper is waiting on, or try a first question. */
function ReadinessCard() {
  const agents = useStore((s) => s.agents);
  const { done } = useOnboarding();
  const devices = useDevices();
  // devices are null while loading; show a quiet placeholder instead of guessing a state
  if (devices === null) return <div className="h-24 rounded-3xl bg-card animate-pulse" aria-hidden />;
  const r: ReturnType<typeof homeReadiness<Agent>> = homeReadiness(done, agents, devices);
  const { progress, steps } = setupProgress(done);

  const Frame = ({ agent, title, sub, children }: { agent?: Agent; title: string; sub?: ReactNode; children: ReactNode }) => (
    <GroupCard className="p-[18px] flex flex-col gap-3" >
      <section aria-labelledby="ready-h" className="contents">
        <div className="flex items-center gap-3">
          {agent && <AgentAvatar agent={agent} size={40} live />}
          <div className="min-w-0 flex-1">
            <h2 id="ready-h" className="text-[17px] font-semibold leading-snug">
              {title}
            </h2>
            {sub && <p className="text-sm text-faint">{sub}</p>}
          </div>
        </div>
        {children}
      </section>
    </GroupCard>
  );
  const bar = (
    <>
      <div className="h-1.5 rounded-full bg-chip overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={steps} aria-valuenow={progress} aria-label="Setup progress">
        <div className="h-full rounded-full bg-badge" style={{ width: `${(progress / steps) * 100}%` }} />
      </div>
      <div className="text-[13px] text-faint">
        {progress} of {steps} done
      </div>
    </>
  );

  if (r.kind === "setup") {
    return (
      <Frame title="Your helper isn't ready yet" sub={`Next: ${NEXT_STEP[r.next]}`}>
        {bar}
        <div className="flex gap-2.5">
          <CardButton tone="primary" onClick={() => go({ view: "welcome" })}>
            Continue setup
          </CardButton>
        </div>
      </Frame>
    );
  }
  if (r.kind === "waiting") {
    // the fix depends on what's missing: a device, the device coming back, or the harness on it
    const next = setupNextStep(r.agent, devices);
    const onDevice = next?.href === href({ view: "computers", computerId: null });
    return (
      <Frame agent={r.agent} title={onDevice && r.deviceName ? `${r.agent.name} is waiting for ${r.deviceName}` : `${r.agent.name} isn't ready yet`} sub={next ? next.text : r.problem}>
        {bar}
        <div className="flex flex-wrap gap-2.5">
          <CardButton tone="primary" onClick={() => (location.hash = next?.href ?? href({ view: "computers", computerId: null }))}>
            {next?.action ?? "See computers"}
          </CardButton>
          <CardButton onClick={() => go({ view: "agents", agentId: r.agent.id, tab: "model" })}>Change its AI</CardButton>
        </div>
      </Frame>
    );
  }
  const agent = r.agent;
  return (
    <Frame agent={agent} title={`Try asking ${agent.name}…`}>
      <ul className="flex flex-col gap-2">
        {EXAMPLE_PROMPTS.map((text) => (
          <li key={text}>
            <button type="button" onClick={() => void openHelperDm(agent.id, text)} className="w-full text-left rounded-2xl bg-panel border border-line px-3.5 py-2.5 text-sm hover:bg-hover outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
              {text}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Pick one and it's ready in the chat. Change it if you like, then send.</p>
      <div>
        <CardButton onClick={() => void openHelperDm(agent.id)}>Open chat</CardButton>
      </div>
    </Frame>
  );
}

/** How much of today's background allowance is used, linking to Settings → Usage. */
function AllowanceRow() {
  const [a] = useAllowance();
  if (!a) return null;
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-[20px] bg-panel border border-line">
      <span className="flex-1 flex flex-col gap-0.5">
        <span className="text-sm">Background work</span>
        <span className="text-[13px] text-faint">{a.dailyTokens ? `${allowanceText(a)} used` : allowanceText(a)}</span>
      </span>
      <a href={href({ view: "settings", page: "usage" })} className="text-sm text-accent-text hover:underline">
        Open usage
      </a>
    </div>
  );
}
