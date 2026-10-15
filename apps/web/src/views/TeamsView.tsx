import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Crown, GitBranch, GitMerge, Hash, MessagesSquare, Plus, Smile, Trash2, Users } from "lucide-react";
import { harnessLabel, type Agent } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type DiscussionInfo, type TeamInfo } from "../store.ts";
import { SlotEditor, TeamBuilder, createSlotAgents } from "../components/TeamBuilder.tsx";
import { useDevices } from "../devices.ts";
import { blankSlot, slotProblem, type Slot } from "../teamSetup.ts";
import { go, href, type TeamTab } from "../router.ts";
import { AgentAvatar, Button, EmojiPicker, Empty, Field, Input, Modal, Pill, Popover, Textarea, cx, timeAgo } from "../components/ui.tsx";

/**
 * Teams: agents working together, each with a role. A team has a lead who hands out the work, and
 * the workspace has a lead too, who takes every task nobody assigned.
 */
export function TeamsView({ teamId, tab, onBack }: { teamId: string | null; tab: TeamTab | null; onBack?: () => void }) {
  const teams = useStore((s) => s.teams);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const [creating, setCreating] = useState(false);
  const team = teams.find((t) => t.id === teamId);
  if (team) return <TeamDetail key={team.id} team={team} tab={tab ?? "members"} canEdit={canEdit} />;

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
        <div className="max-w-3xl px-4 md:px-6 py-5 space-y-6">
          <WorkspaceLead />
          {teams.length === 0 ? (
            <Empty icon={<Users />} title="Put agents to work together">
              <p>A team is a few agents with a role each, like a lead who hands out work, a backend, a frontend and a reviewer. Start from a template or build your own, and pick any agent for each role.</p>
              <p>Agents that aren't on a team keep working on their own.</p>
              {canEdit && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={16} /> New team
                </Button>
              )}
            </Empty>
          ) : (
            <TeamList />
          )}
        </div>
      </div>
      {creating && <TeamBuilder onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Who takes tasks nobody assigned: pick one, or leave it to Warren (a team lead, else the first agent). */
function WorkspaceLead() {
  const agents = useStore((s) => s.agents);
  const lead = useStore((s) => s.lead);
  const owner = useStore((s) => s.me)?.role === "owner";
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    useStore.getState().refreshLead();
  }, []);
  if (!agents.length) return null;
  const current = agents.find((a) => a.id === lead?.lead);
  const save = async (leadId: string | null) => {
    setError(null);
    try {
      useStore.setState({ lead: await api("PUT", "/api/settings/lead", { leadId }) });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="rounded-2xl border border-line p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Crown size={16} className="text-accent-text shrink-0" />
        <div className="flex-1 min-w-48">
          <div className="text-sm font-semibold">Lead</div>
          <p className="text-xs text-muted">Takes every task nobody assigned, splits it up and hands the pieces to agents by role.</p>
        </div>
        {owner ? (
          <select value={lead?.leadId ?? ""} onChange={(e) => save(e.target.value || null)} className={cx(selectCls, "max-w-60")} aria-label="Lead agent">
            <option value="">{current ? `Automatic (${current.name})` : "Automatic"}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.handle} ({a.name})
              </option>
            ))}
          </select>
        ) : (
          current && (
            <span className="inline-flex items-center gap-1.5 text-sm">
              <AgentAvatar agent={current} size={20} badge={false} /> {current.name}
            </span>
          )
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
    </section>
  );
}

/** Every team, then the agents that work on their own. */
function TeamList() {
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const onTeams = new Set(teams.flatMap((t) => t.members.map((m) => m.agentId)));
  const solo = agents.filter((a) => !onTeams.has(a.id));
  return (
    <>
      <div className="space-y-3">
        {teams.map((t) => (
          <TeamCard key={t.id} team={t} />
        ))}
      </div>
      {solo.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">Working on their own</div>
          <div className="flex flex-wrap gap-2">
            {solo.map((a) => (
              <a key={a.id} href={`#/agents/${a.id}/overview`} className="inline-flex items-center gap-2 rounded-xl border border-line px-2.5 h-9 text-sm hover:bg-hover">
                <AgentAvatar agent={a} size={22} badge={false} /> @{a.handle}
              </a>
            ))}
          </div>
        </section>
      )}
    </>
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

const selectCls = "h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm";

const TABS = [
  { id: "members", label: "Members" },
  { id: "work", label: "Work" },
  { id: "settings", label: "Settings" },
] as const;

function TeamDetail({ team, tab, canEdit }: { team: TeamInfo; tab: TeamTab; canEdit: boolean }) {
  const channels = useStore((s) => s.channels);
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
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-4 md:px-6 py-5 space-y-8">{tab === "members" ? <TeamMembers team={team} canEdit={canEdit} /> : tab === "work" ? <TeamWork team={team} canEdit={canEdit} /> : <TeamSettings team={team} canEdit={canEdit} />}</div>
      </div>
    </div>
  );
}

/** The lead, then everyone else, with their roles. Edit a role in place; add or remove people. */
function TeamMembers({ team, canEdit }: { team: TeamInfo; canEdit: boolean }) {
  const refreshTeams = useStore((s) => s.refreshTeams);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refreshTeams();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const lead = team.members.find((m) => m.agentId === team.leadId);
  const others = team.members.filter((m) => m.agentId !== team.leadId);
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted">The lead takes the team's work and hands pieces to the others by role. Each role's note goes into that agent's prompt, so say what it owns and what to send its way.</p>
      {lead ? <MemberRow key={lead.agentId} team={team} member={lead} isLead canEdit={canEdit} call={call} /> : <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">No lead yet. Make one of the members the lead.</p>}
      {others.map((m) => (
        <MemberRow key={m.agentId} team={team} member={m} canEdit={canEdit} call={call} />
      ))}
      {team.members.length === 0 && <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">Nobody is on this team yet.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {canEdit && (
        <Button onClick={() => setAdding(true)}>
          <Plus size={15} /> Add someone
        </Button>
      )}
      {adding && <AddMember team={team} onClose={() => setAdding(false)} />}
    </section>
  );
}

function MemberRow({ team, member, isLead, canEdit, call }: { team: TeamInfo; member: TeamInfo["members"][number]; isLead?: boolean; canEdit: boolean; call: (fn: () => Promise<unknown>) => Promise<void> }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === member.agentId));
  const [role, setRole] = useState(member.role);
  const [notes, setNotes] = useState(member.roleNotes);
  const dirty = role.trim() !== member.role || notes.trim() !== member.roleNotes;
  return (
    <div className="rounded-xl border border-line p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <a href={`#/agents/${member.agentId}/overview`} className="inline-flex items-center gap-2 min-w-0 hover:underline">
          <AgentAvatar agent={agent} size={28} badge={false} />
          <span className="font-medium truncate">{agent?.name ?? "Agent"}</span>
          <span className="text-xs text-muted">@{agent?.handle}</span>
        </a>
        {agent && <span className="text-xs text-muted">{harnessLabel(agent.harness)}</span>}
        {isLead && (
          <Pill tone="accent">
            <Crown size={11} /> lead
          </Pill>
        )}
        <span className="flex-1" />
        {canEdit && !isLead && (
          <Button variant="ghost" className="h-7" onClick={() => call(() => api("PATCH", `/api/teams/${team.id}`, { leadId: member.agentId }))}>
            Make lead
          </Button>
        )}
        {canEdit && (
          <Button variant="ghost" className="h-7" onClick={() => confirm(`Take @${agent?.handle} off ${team.name}?`) && call(() => api("DELETE", `/api/teams/${team.id}/members/${member.agentId}`))}>
            Remove
          </Button>
        )}
      </div>
      <Input value={role} disabled={!canEdit} onChange={(e) => setRole(e.target.value)} placeholder="Role, e.g. Backend" aria-label="Role" maxLength={60} />
      <Textarea rows={2} value={notes} disabled={!canEdit} onChange={(e) => setNotes(e.target.value)} placeholder="What it owns and what to send its way. The agent reads this." aria-label="What the role owns" maxLength={4000} />
      {canEdit && dirty && (
        <div className="flex gap-2">
          <Button variant="primary" className="h-8" onClick={() => call(() => api("PUT", `/api/teams/${team.id}/members/${member.agentId}`, { role: role.trim(), roleNotes: notes.trim() }))}>
            Save
          </Button>
          <Button variant="ghost" className="h-8" onClick={() => (setRole(member.role), setNotes(member.roleNotes))}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

/** Put an agent on the team in a role: one you have, or a new one on any harness. */
function AddMember({ team, onClose }: { team: TeamInfo; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const refreshTeams = useStore((s) => s.refreshTeams);
  const devices = useDevices(10_000);
  const free = agents.filter((a) => !team.members.some((m) => m.agentId === a.id));
  const [slot, setSlot] = useState<Slot>(() => ({ ...blankSlot(), pick: free[0]?.id ?? "new" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = (devices ?? []).some((d) => (d.mine || d.shared) && d.online);
  const problem = slotProblem([slot], canCreate);
  return (
    <Modal title={`Add to ${team.name}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (problem || busy) return;
          setBusy(true);
          setError(null);
          try {
            const who = await createSlotAgents([slot], agents, devices ?? [], (k, id) => setSlot((cur) => (cur.key === k ? { ...cur, pick: id } : cur)));
            // new members report to the lead, like the rest of the team
            await api("PUT", `/api/teams/${team.id}/members/${who.get(slot.key)}`, { role: slot.role.trim(), roleNotes: slot.notes.trim(), ...(team.leadId ? { managerId: team.leadId } : {}) });
            await Promise.all([refreshTeams(), useStore.getState().refreshAgents()]);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <SlotEditor slot={slot} devices={devices ?? []} agents={free} taken={new Set()} canCreate={canCreate} onChange={(p) => setSlot({ ...slot, ...p })} />
        {(problem || error) && <p className="text-sm text-bad">{problem ?? error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !!problem}>
            {busy ? "Adding…" : "Add to team"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Everything about a team that isn't its members: label, brief, code. */
function TeamSettings({ team, canEdit }: { team: TeamInfo; canEdit: boolean }) {
  const agents = useStore((s) => s.agents);
  const refreshTeams = useStore((s) => s.refreshTeams);
  const initial = { emoji: team.emoji, description: team.description, repo: team.repo ?? "", baseBranch: team.baseBranch };
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
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
        Members can read and write <b className="text-ink">{team.folder}/</b>. Every member reads the team brief, its recent decisions and who's on the team before working.
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
              onClick={() => run(() => api("PATCH", `/api/teams/${team.id}`, { emoji: f.emoji, description: f.description, repo: f.repo.trim() || null, baseBranch: f.baseBranch.trim() || "main" }))}
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
  toAgentId: string;
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
            Tasks handed out in this team's channel get their own branch of <code>{team.repo}</code>. When one is done, someone other than whoever built it reviews it ({team.members.some((m) => /review/i.test(m.role)) ? "the reviewer, preferably on another harness" : "a teammate on another harness if there is one, else the lead"}) and merges it into <code>{team.baseBranch}</code>.
          </p>
        ) : (
          <p className="text-sm text-muted">Set a code repository above and coding tasks get their own branch, a review, and a merge.</p>
        )}
        {error && <p className="text-sm text-bad whitespace-pre-wrap">{error}</p>}
        {!tasks ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">No tasks yet. Ask the lead for something and it hands the pieces out.</p>
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
