import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Crown, GitBranch, GitMerge, Hash, MessagesSquare, Network, Plus, Smile, Trash2, Users } from "lucide-react";
import type { Agent } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type DiscussionInfo, type TeamInfo } from "../store.ts";
import { StartDiscussion } from "../components/Discussion.tsx";
import { TeamChart } from "../components/TeamChart.tsx";
import { go, href, type TeamTab } from "../router.ts";
import { AgentAvatar, Button, EmojiPicker, Empty, Field, Input, Modal, Pill, Popover, Textarea, cx, timeAgo } from "../components/ui.tsx";

/**
 * Teams and how they fit together: agents work alone or in teams with a lead and roles, and
 * teams can report to a boss agent (who can report to another).
 */
export function TeamsView({ teamId, tab, onBack }: { teamId: string | null; tab: TeamTab | null; onBack?: () => void }) {
  const teams = useStore((s) => s.teams);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const [creating, setCreating] = useState(false);
  const team = teams.find((t) => t.id === teamId);
  if (team) return <TeamDetail key={team.id} team={team} tab={tab ?? "chart"} canEdit={canEdit} />;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">Teams</h1>
        {canEdit && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New team
          </Button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        {teams.length === 0 ? (
          <Empty icon={<Users />} title="Put agents to work together">
            <p>A team shares a channel and a memory pool. Give it a lead who hands out work, roles like reviewer or frontend, and optionally a boss agent it reports to, so you can ask the boss for anything and it gets done across teams.</p>
            <p>Agents that aren't on a team keep working on their own.</p>
            {canEdit && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> New team
              </Button>
            )}
          </Empty>
        ) : (
          <div className="max-w-5xl px-4 md:px-6 py-5 space-y-6">
            <OrgChart />
          </div>
        )}
      </div>
      {creating && <CreateTeam onClose={() => setCreating(false)} />}
    </div>
  );
}

/** You at the top, then bosses and the teams under them, then agents working alone. */
function OrgChart() {
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const me = useStore((s) => s.me);
  const agent = (id: string | null) => agents.find((a) => a.id === id);
  // a team sits under the team its boss leads; otherwise under its boss directly, or at the top
  const parentTeam = (t: TeamInfo) => (t.reportsTo ? teams.find((x) => x.leadId === t.reportsTo && x.id !== t.id) : undefined);
  const roots = teams.filter((t) => !parentTeam(t));
  const bosses = [...new Set(roots.map((t) => t.reportsTo).filter((a): a is string => !!a))];
  const onTeams = new Set(teams.flatMap((t) => t.members.map((m) => m.agentId)));
  const solo = agents.filter((a) => !onTeams.has(a.id) && !bosses.includes(a.id));

  const branch = (t: TeamInfo): ReactNode => {
    const kids = teams.filter((x) => parentTeam(x)?.id === t.id);
    return (
      <li key={t.id} className="relative pl-6 before:absolute before:left-2 before:top-0 before:h-6 before:w-3 before:border-l before:border-b before:border-line before:rounded-bl-lg">
        <TeamCard team={t} />
        {kids.length > 0 && <ul className="mt-2 space-y-2 border-l border-line ml-2">{kids.map(branch)}</ul>}
      </li>
    );
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Network size={15} className="text-muted" /> How your agents are organized
      </div>
      <div className="rounded-2xl border border-line p-4">
        <div className="inline-flex items-center gap-2 rounded-xl bg-accent-soft text-accent-text px-3 h-9 text-sm font-medium">You{me ? ` (${me.user.name})` : ""}</div>
        <ul className="mt-2 space-y-3 border-l border-line ml-3">
          {bosses.map((b) => {
            const a = agent(b);
            return (
              <li key={b} className="relative pl-6 before:absolute before:left-0 before:top-0 before:h-5 before:w-5 before:border-b before:border-line">
                <a href={`#/agents/${b}/overview`} className="inline-flex items-center gap-2 rounded-xl border border-line px-3 h-10 hover:bg-hover">
                  <AgentAvatar agent={a} size={24} badge={false} />
                  <span className="font-medium">@{a?.handle ?? "boss"}</span>
                  <Pill tone="accent">
                    <Crown size={11} /> boss
                  </Pill>
                </a>
                <ul className="mt-2 space-y-2 border-l border-line ml-3">{roots.filter((t) => t.reportsTo === b).map(branch)}</ul>
              </li>
            );
          })}
          {roots
            .filter((t) => !t.reportsTo)
            .map((t) => (
              <li key={t.id} className="relative pl-6 before:absolute before:left-0 before:top-0 before:h-6 before:w-5 before:border-b before:border-line">
                <TeamCard team={t} />
                <ul className="mt-2 space-y-2 border-l border-line ml-2">{teams.filter((x) => parentTeam(x)?.id === t.id).map(branch)}</ul>
              </li>
            ))}
          {solo.length > 0 && (
            <li className="relative pl-6 before:absolute before:left-0 before:top-0 before:h-5 before:w-5 before:border-b before:border-line">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">Working on their own</div>
              <div className="flex flex-wrap gap-2">
                {solo.map((a) => (
                  <a key={a.id} href={`#/agents/${a.id}/overview`} className="inline-flex items-center gap-2 rounded-xl border border-line px-2.5 h-9 text-sm hover:bg-hover">
                    <AgentAvatar agent={a} size={22} badge={false} /> @{a.handle}
                  </a>
                ))}
              </div>
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

function TeamCard({ team }: { team: TeamInfo }) {
  const agents = useStore((s) => s.agents);
  const lead = agents.find((a) => a.id === team.leadId);
  return (
    <a href={`#/teams/${team.id}`} className="block rounded-xl border border-line p-3 hover:bg-hover max-w-xl">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {team.emoji ? <span className="leading-none">{team.emoji}</span> : <Users size={15} className="text-accent-text shrink-0" />}
        <span className="font-semibold break-all">{team.name}</span>
        <span className="text-xs text-muted whitespace-nowrap">
          {team.members.length} agent{team.members.length === 1 ? "" : "s"}
        </span>
        {lead && (
          <span className="ml-auto text-xs text-muted flex items-center gap-1 whitespace-nowrap">
            lead <AgentAvatar agent={lead} size={18} badge={false} /> @{lead.handle}
          </span>
        )}
      </div>
      {team.description && <p className="mt-1 text-sm text-muted line-clamp-2">{team.description}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {team.members.map((m) => {
          const a = agents.find((x) => x.id === m.agentId);
          return (
            <span key={m.agentId} className="inline-flex items-center gap-1 rounded-full bg-hover pl-0.5 pr-2 h-6 text-xs">
              <AgentAvatar agent={a} size={20} badge={false} /> @{a?.handle}
              {m.role && <span className="text-muted">· {m.role}</span>}
            </span>
          );
        })}
      </div>
    </a>
  );
}

const agentOptions = (agents: Agent[], none: string) => [
  <option key="" value="">
    {none}
  </option>,
  ...agents.map((a) => (
    <option key={a.id} value={a.id}>
      @{a.handle} ({a.name})
    </option>
  )),
];
const selectCls = "h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm";

function CreateTeam({ onClose }: { onClose: () => void }) {
  const refreshTeams = useStore((s) => s.refreshTeams);
  const [f, setF] = useState({ name: "", emoji: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New team" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const t = await api<TeamInfo>("POST", "/api/teams", f);
            await refreshTeams();
            onClose();
            go({ view: "teams", teamId: t.id });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="flex gap-3">
          <Field label="Label">
            <Popover
              up={false}
              trigger={(_, toggle) => (
                <button type="button" onClick={toggle} className="size-9 rounded-lg border border-line bg-panel text-lg grid place-items-center hover:bg-hover" aria-label="Pick a label">
                  {f.emoji || <Smile size={16} className="text-muted" />}
                </button>
              )}
            >
              {(close) => (
                <div>
                  <EmojiPicker onPick={(emoji) => (setF({ ...f, emoji }), close())} />
                  {f.emoji && (
                    <button type="button" onClick={() => (setF({ ...f, emoji: "" }), close())} className="w-full h-8 text-xs text-muted hover:text-ink border-t border-line">
                      No label
                    </button>
                  )}
                </div>
              )}
            </Popover>
          </Field>
          <div className="flex-1">
            <Field label="Name" hint="Becomes the channel #team-name and the memory folder teams/name/.">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="web" required autoFocus />
            </Field>
          </div>
        </div>
        <Field label="What it's for" hint="Starts the team's brief, which every member reads before working.">
          <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Builds and ships the website." />
        </Field>
        <p className="text-xs text-muted">Next you'll build the team on its chart: drag agents in, draw who reports to whom, and give them roles.</p>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!f.name.trim()}>
            Create team
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const TABS = [
  { id: "chart", label: "Chart" },
  { id: "work", label: "Work" },
  { id: "settings", label: "Settings" },
] as const;

function TeamDetail({ team, tab, canEdit }: { team: TeamInfo; tab: TeamTab; canEdit: boolean }) {
  const channels = useStore((s) => s.channels);
  const [discussing, setDiscussing] = useState(false);
  const channel = channels.find((c) => c.id === team.channelId);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        <a href="#/teams" className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover text-muted" aria-label="All teams">
          <ChevronLeft size={20} />
        </a>
        <a href="#/teams" className="hidden md:inline text-sm font-semibold uppercase tracking-wider text-muted hover:text-ink">
          Teams
        </a>
        <ChevronRight size={14} className="hidden md:block text-faint shrink-0" />
        {team.emoji && <span className="text-base leading-none">{team.emoji}</span>}
        <h1 className="text-sm font-medium truncate">{team.name}</h1>
        <nav className="ml-2 flex gap-0.5 rounded-lg border border-line p-0.5" role="tablist">
          {TABS.map((t) => (
            <a key={t.id} role="tab" aria-selected={tab === t.id} href={href({ view: "teams", teamId: team.id, tab: t.id })} className={cx("h-7 px-2.5 rounded-md text-sm inline-flex items-center", tab === t.id ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink")}>
              {t.label}
            </a>
          ))}
        </nav>
        <span className="flex-1" />
        {channel && (
          <Button variant="ghost" onClick={() => go({ view: "chat", channelId: channel.id, threadId: null })} title={`#${channel.name}`}>
            <Hash size={15} /> <span className="hidden lg:inline">{channel.name}</span>
          </Button>
        )}
        <Button variant="ghost" onClick={() => go({ view: "vault", path: `${team.folder}/README.md` })} title="Team memory">
          <BookOpen size={15} /> <span className="hidden lg:inline">Memory</span>
        </Button>
        {canEdit && team.members.length >= 2 && (
          <Button variant="ghost" onClick={() => setDiscussing(true)} title="Have the team talk something through">
            <MessagesSquare size={15} /> <span className="hidden lg:inline">Discuss</span>
          </Button>
        )}
      </header>
      {tab === "chart" ? (
        <TeamChart team={team} canEdit={canEdit} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl px-4 md:px-6 py-5 space-y-8">{tab === "work" ? <TeamWork team={team} canEdit={canEdit} /> : <TeamSettings team={team} canEdit={canEdit} />}</div>
        </div>
      )}
      {discussing && <StartDiscussion teamId={team.id} onClose={() => setDiscussing(false)} />}
    </div>
  );
}

/** Everything about a team that isn't on its chart: label, brief, boss, code. */
function TeamSettings({ team, canEdit }: { team: TeamInfo; canEdit: boolean }) {
  const agents = useStore((s) => s.agents);
  const refreshTeams = useStore((s) => s.refreshTeams);
  const initial = { emoji: team.emoji, description: team.description, reportsTo: team.reportsTo ?? "", repo: team.repo ?? "", baseBranch: team.baseBranch };
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const handle = (id: string | null) => (id ? `@${agents.find((a) => a.id === id)?.handle ?? "?"}` : null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refreshTeams();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <p className="text-sm text-muted">
        Members and {team.reportsTo ? "everyone the team reports to" : "its boss, if it gets one,"} can read and write <b className="text-ink">{team.folder}/</b>. Every member reads the team brief, its recent decisions and the chart before working
        {team.above.length ? (
          <>
            . Reports to <b className="text-ink">{team.above.map(handle).join(" → ")}</b>
          </>
        ) : null}
        .
      </p>
      <section className="space-y-4">
        <div className="flex gap-3">
          <Field label="Label">
            <Popover
              up={false}
              trigger={(_, toggle) => (
                <button type="button" disabled={!canEdit} onClick={toggle} className="size-9 rounded-lg border border-line bg-panel text-lg grid place-items-center hover:bg-hover" aria-label="Pick a label">
                  {f.emoji || <Smile size={16} className="text-muted" />}
                </button>
              )}
            >
              {(close) => (
                <div>
                  <EmojiPicker onPick={(emoji) => (setF({ ...f, emoji }), close())} />
                  <button type="button" onClick={() => (setF({ ...f, emoji: "" }), close())} className="w-full h-8 text-xs text-muted hover:text-ink border-t border-line">
                    No label
                  </button>
                </div>
              )}
            </Popover>
          </Field>
          <div className="flex-1">
            <Field label="What it's for">
              <Textarea rows={3} value={f.description} disabled={!canEdit} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </Field>
          </div>
        </div>
        <Field label="Reports to" hint="A boss agent outside the team: it can see the team's memory and hand it work. The team's lead is whoever's at the top of the chart.">
          <select value={f.reportsTo} disabled={!canEdit} onChange={(e) => setF({ ...f, reportsTo: e.target.value })} className={selectCls}>
            {agentOptions(
              agents.filter((a) => a.id !== team.leadId),
              "No one (reports to you)",
            )}
          </select>
        </Field>
        <div className="grid sm:grid-cols-[1fr_10rem] gap-4">
          <Field label="Code repository" hint="A git URL, or a path on the device the agents run on. Tasks for this team get their own branch and checkout.">
            <Input value={f.repo} disabled={!canEdit} onChange={(e) => setF({ ...f, repo: e.target.value })} placeholder="git@github.com:you/app.git" />
          </Field>
          <Field label="Base branch">
            <Input value={f.baseBranch} disabled={!canEdit} onChange={(e) => setF({ ...f, baseBranch: e.target.value })} />
          </Field>
        </div>
        {canEdit && dirty && (
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => run(() => api("PATCH", `/api/teams/${team.id}`, { emoji: f.emoji, description: f.description, reportsTo: f.reportsTo || null, repo: f.repo.trim() || null, baseBranch: f.baseBranch.trim() || "main" }))}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setF(initial)}>
              Discard
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
      </section>
      {canEdit && (
        <section className="space-y-2">
          <h2 className="font-semibold">Delete team</h2>
          <p className="text-sm text-muted">Its channel and its notes in memory stay.</p>
          <Button variant="danger" onClick={() => confirm(`Delete team ${team.name}?`) && run(() => api("DELETE", `/api/teams/${team.id}`)).then(() => go({ view: "teams", teamId: null }))}>
            <Trash2 size={15} /> Delete team
          </Button>
        </section>
      )}
    </>
  );
}

interface TaskRow {
  id: string;
  title: string;
  status: "open" | "in_progress" | "done" | "failed";
  toAgentId: string | null;
  branch: string | null;
  reviewOf: string | null;
  mergedAt: string | null;
  channelId: string | null;
  threadId: string | null;
  updatedAt: string;
}

const TASK_TONE = { open: "warn", in_progress: "info", done: "ok", failed: "bad" } as const;

/** What the team is working on: tasks (with their branches when it codes), and its discussions. */
function TeamWork({ team, canEdit }: { team: TeamInfo; canEdit: boolean }) {
  const agents = useStore((s) => s.agents);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [discussions, setDiscussions] = useState<DiscussionInfo[]>([]);
  const [merging, setMerging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api<TaskRow[]>("GET", `/api/tasks?team=${team.id}`).then(setTasks, () => setTasks([]));
    api<DiscussionInfo[]>("GET", `/api/discussions${team.channelId ? `?channel=${team.channelId}` : ""}`).then((d) => setDiscussions(d.filter((x) => x.teamId === team.id).slice(0, 8)), () => {});
  };
  useEffect(load, [team.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const merge = async (t: TaskRow) => {
    setMerging(t.id);
    setError(null);
    try {
      await api("POST", `/api/tasks/${t.id}/merge`);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMerging(null);
    }
  };
  const open = (t: { channelId: string | null; threadId: string | null }) => t.channelId && go({ view: "chat", channelId: t.channelId, threadId: t.threadId });
  return (
    <>
      <section className="space-y-3">
        <h2 className="font-semibold">Work</h2>
        {team.repo ? (
          <p className="text-sm text-muted">
            Tasks handed out in this team's channel get their own branch of <code>{team.repo}</code>. When one is done, {team.members.some((m) => /review/i.test(m.role)) ? "the reviewer" : "the lead"} gets a review task and merges it into <code>{team.baseBranch}</code>.
          </p>
        ) : (
          <p className="text-sm text-muted">Set a code repository above and coding tasks get their own branch, a review, and a merge.</p>
        )}
        {error && <p className="text-sm text-bad whitespace-pre-wrap">{error}</p>}
        {!tasks ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">No tasks yet. Ask the lead (or the boss) for something, or have the team discuss it first.</p>
        ) : (
          <div className="rounded-xl border border-line divide-y divide-line">
            {tasks.slice(0, 30).map((t) => {
              const a = agents.find((x) => x.id === t.toAgentId);
              return (
                <div key={t.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <AgentAvatar agent={a} size={26} badge={false} />
                  <button onClick={() => open(t)} className="min-w-0 flex-1 text-left">
                    <div className="truncate font-medium hover:underline">{t.title}</div>
                    <div className="text-xs text-muted flex items-center gap-1.5 truncate">
                      @{a?.handle} · {timeAgo(t.updatedAt)}
                      {t.branch && (
                        <span className="inline-flex items-center gap-1 font-mono truncate">
                          <GitBranch size={11} /> {t.branch}
                        </span>
                      )}
                    </div>
                  </button>
                  {t.mergedAt ? (
                    <Pill tone="ok">
                      <GitMerge size={11} /> merged
                    </Pill>
                  ) : (
                    <Pill tone={TASK_TONE[t.status]}>{t.status.replace("_", " ")}</Pill>
                  )}
                  {canEdit && t.branch && !t.reviewOf && t.status === "done" && !t.mergedAt && (
                    <Button className="h-7" disabled={merging === t.id} onClick={() => merge(t)} title={`Merge ${t.branch} into ${team.baseBranch}`}>
                      <GitMerge size={13} /> {merging === t.id ? "Merging…" : "Merge"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {discussions.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Discussions</h2>
          <div className="rounded-xl border border-line divide-y divide-line">
            {discussions.map((d) => (
              <button key={d.id} onClick={() => open(d)} className="w-full px-4 py-2.5 flex items-center gap-3 text-sm text-left hover:bg-hover">
                <MessagesSquare size={15} className="text-muted shrink-0" />
                <span className="flex-1 truncate">{d.topic}</span>
                <span className="text-xs text-muted">{timeAgo(d.updatedAt)}</span>
                <Pill tone={d.status === "done" ? "ok" : d.status === "cancelled" ? "neutral" : "info"}>{d.status === "done" ? "decided" : d.status === "cancelled" ? "stopped" : "in progress"}</Pill>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
