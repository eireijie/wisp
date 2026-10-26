import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronRight, Circle, CircleCheck, CircleX, Crown, Loader2, MoreHorizontal, Paperclip, Plus, Sparkles, Users, WifiOff, X } from "lucide-react";
import { harnessInfo, type Actor, type Agent } from "@wisp/core";
import { api, uploadFile } from "../api.ts";
import { useStore, useTeams, usePrefs } from "../store.ts";
import { go, href } from "../router.ts";
import { agentReadiness, useDevices } from "../devices.ts";
import { AgentAvatar, Menu, Modal, cx, timeAgo } from "../components/ui.tsx";
import { CardButton, ConfirmDialog, GroupCard, Rule, SectionHead, StateChip, runSummary } from "../components/InboxParts.tsx";
import { shortTime } from "../components/ChatList.tsx";

export interface TaskRow {
  id: string;
  from: Actor;
  /** null once that agent was removed */
  toAgentId: string | null;
  title: string;
  brief: string;
  status: "open" | "in_progress" | "done" | "failed";
  result: string | null;
  channelId: string | null;
  threadId: string | null;
  teamId: string | null;
  reviewOf: string | null;
  /** coding work for a channel team with a repo happens on its own branch */
  branch?: string | null;
  mergedAt?: string | null;
  /** the task this is a piece of; null at the top */
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

type State = "todo" | "working" | "blocked" | "needsYou" | "done" | "failed" | "cancelled";
type Tone = "neutral" | "ok" | "warn" | "bad" | "info";
const STATE: Record<State, { label: string; tone: Tone }> = {
  todo: { label: "To do", tone: "neutral" },
  working: { label: "Working", tone: "ok" },
  blocked: { label: "Waiting for a device", tone: "neutral" },
  needsYou: { label: "Needs you", tone: "warn" },
  done: { label: "Done", tone: "info" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
const isCancelled = (t: TaskRow) => t.status === "failed" && !!t.result?.startsWith("Cancelled");
const isClosed = (t: TaskRow) => t.status === "done" || t.status === "failed";
const cancellable = (s: State) => s === "todo" || s === "blocked" || s === "working";

/** True on phone widths, where the detail is a sheet and the board is one grouped list. */
function useIsPhone() {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/**
 * Tasks: work that's been planned and handed out. A task nobody assigned goes to the lead, who
 * splits it up; the pieces show up under it as subtasks. Four columns on a desktop with the
 * open task in a panel beside them; one grouped list on a phone with the task in a sheet.
 */
export function TasksView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const status = useStore((s) => s.lead);
  const agents = useStore((s) => s.agents);
  const lead = agents.find((a) => a.id === status?.lead);
  useEffect(() => {
    useStore.getState().refreshLead();
  }, []);
  const canNew = me.role !== "guest" && agents.length > 0;
  const newTask = () => useStore.setState({ newTaskOpen: true });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 px-[18px] md:px-7 pt-3 md:pt-[30px] pb-3 safe-top flex items-center gap-3.5">
        {onBack && (
          <button className="md:hidden! circle" onClick={onBack} aria-label="Back to Inbox">
            <ChevronRight size={22} strokeWidth={2} className="rotate-180" />
          </button>
        )}
        <h1 className="text-xl md:text-[28px] font-bold tracking-tight flex-1 truncate max-md:text-center">Tasks</h1>
        {lead && (
          <a href={href({ view: "settings", page: "agents" })} className="hidden lg:flex items-center gap-1.5 text-xs text-muted hover:text-ink" title="The lead takes every task nobody assigned">
            <Crown size={13} /> Lead <AgentAvatar agent={lead} size={18} /> <span className="text-ink">{lead.name}</span>
          </a>
        )}
        {canNew && (
          <>
            <CardButton tone="primary" onClick={newTask} className="hidden md:inline-flex items-center gap-2">
              <Plus size={16} strokeWidth={2} /> New task
            </CardButton>
            <button className="md:hidden! circle" onClick={newTask} aria-label="New task">
              <Plus size={22} strokeWidth={2} />
            </button>
          </>
        )}
        {!canNew && onBack && <span className="md:hidden w-[52px]" />}
      </header>
      <div className="flex-1 min-h-0 flex">{agents.length === 0 ? <div className="flex-1 overflow-y-auto"><NoAgents /></div> : <Board leadId={status?.lead ?? null} />}</div>
    </div>
  );
}

/** Tasks need someone to hand them to. */
function NoAgents() {
  /** this also shows inside the New task dialog; leave it before navigating */
  const to = (view: Parameters<typeof go>[0]) => {
    useStore.setState({ newTaskOpen: false });
    go(view);
  };
  return (
    <div className="mx-auto max-w-xl px-4 py-12 md:py-16 text-center space-y-3">
      <h2 className="text-lg font-semibold">Add an agent to hand work to</h2>
      <p className="text-sm text-muted">Tasks are how you give agents work and follow it from the plan to the pieces to done. Add an agent first.</p>
      <div className="flex justify-center gap-2">
        <CardButton tone="primary" onClick={() => to({ view: "agents", agentId: null })}>
          Add an agent
        </CardButton>
      </div>
    </div>
  );
}

interface Ctx {
  agents: Agent[];
  leadId: string | null;
  children: Map<string, TaskRow[]>;
  byId: Map<string, TaskRow>;
  stateOf: (t: TaskRow) => State;
  stateLabel: (t: TaskRow) => string;
  deviceName: (t: TaskRow) => string | null;
  canCancel: boolean;
  refetch: () => void;
  waitingOn: (t: TaskRow) => string | null;
  fromName: (a: Actor) => string;
}

function Board({ leadId }: { leadId: string | null }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const teams = useTeams();
  const members = useStore((s) => s.members);
  const approvals = useStore((s) => s.approvals);
  const computers = useStore((s) => s.computers);
  const version = useStore((s) => s.tasksVersion);
  const devices = useDevices();
  const phone = useIsPhone();
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [who, setWho] = useState("");
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refetch = () => api<TaskRow[]>("GET", "/api/tasks").then(setTasks, () => setTasks((t) => t ?? []));
  useEffect(() => {
    refetch();
  }, [version]);

  const waitingOn = (t: TaskRow) => {
    if (isClosed(t)) return null;
    const inThread = (x: { channelId: string; threadId: string | null }) => x.channelId === t.channelId && (x.threadId === t.threadId || (!!t.threadId && x.threadId === null));
    const approval = Object.values(approvals).find((a) => a.status === "pending" && a.agentId === t.toAgentId && inThread(a));
    if (approval) return `Wants your OK: ${approval.summary}`;
    const help = computers.find((c) => c.help && c.help.agentId === t.toAgentId && inThread(c.help));
    return help ? `Needs you on ${help.name}: ${help.help!.request}` : null;
  };
  /** the device an agent runs on, if we know it */
  const deviceOf = (a: Agent | undefined) => (a?.nodeId ? devices?.find((d) => d.id === a.nodeId) : undefined);
  const stateOf = (t: TaskRow): State => {
    if (t.status === "done") return "done";
    if (isCancelled(t)) return "cancelled";
    if (t.status === "failed") return "failed";
    if (waitingOn(t)) return "needsYou";
    const agent = agents.find((a) => a.id === t.toAgentId);
    // agents that connect on their own (mcp) have no device to wait for
    if (agent && harnessInfo(agent.harness)?.protocol !== "mcp") {
      const dev = deviceOf(agent);
      const unreachable = !agent.nodeId || (devices ? !dev || !dev.online || !!dev.paused : agent.status === "offline");
      if (unreachable) return "blocked";
    }
    return t.status === "in_progress" || agent?.status === "busy" ? "working" : "todo";
  };
  const stateLabel = (t: TaskRow) => {
    const s = stateOf(t);
    if (s !== "blocked") return STATE[s].label;
    const name = deviceOf(agents.find((a) => a.id === t.toAgentId))?.name;
    return name ? `Waiting for ${name}` : "Waiting for a device";
  };
  const deviceName = (t: TaskRow) => deviceOf(agents.find((a) => a.id === t.toAgentId))?.name ?? null;

  // the tree: subtasks (and reviews) hang under the task they're a piece of
  const { roots, children, byId } = useMemo(() => {
    const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
    const children = new Map<string, TaskRow[]>();
    const roots: TaskRow[] = [];
    for (const t of [...(tasks ?? [])].reverse()) {
      const up = t.parentId ?? t.reviewOf;
      if (up && byId.has(up)) children.set(up, [...(children.get(up) ?? []), t]);
      else roots.push(t);
    }
    return { roots: roots.reverse(), children, byId };
  }, [tasks]);

  const all = (t: TaskRow): TaskRow[] => [t, ...(children.get(t.id) ?? []).flatMap(all)];
  const matches = (t: TaskRow) => {
    if (mine && !(t.from.kind === "user" && t.from.id === me.user.id)) return false;
    if (!who) return true;
    const tree = all(t);
    return who.startsWith("team:") ? tree.some((x) => x.teamId === who.slice(5)) : tree.some((x) => x.toAgentId === who);
  };
  const shown = roots.filter(matches);
  const open = shown.filter((t) => !isClosed(t));
  // the pieces of a task that wait on you count too: the root stays where it is, the piece is listed here
  const needsYou = shown.flatMap(all).filter((t) => !isClosed(t) && stateOf(t) === "needsYou");
  const inProgress = open.filter((t) => ["working", "blocked"].includes(stateOf(t)) && !needsYou.includes(t));
  const toDo = open.filter((t) => !inProgress.includes(t) && !needsYou.includes(t));
  const closed = shown.filter(isClosed).slice(0, 20);

  const fromName = (a: Actor) => (a.kind === "agent" ? `@${agents.find((x) => x.id === a.id)?.handle ?? "agent"}` : a.id === me.user.id ? "you" : (members.find((m) => m.id === a.id)?.name ?? "someone"));
  const ctx: Ctx = { agents, leadId, children, byId, stateOf, stateLabel, deviceName, waitingOn, fromName, canCancel: me.role !== "guest", refetch };
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  if (!tasks) return <div className="flex-1 grid place-items-center text-sm text-muted">Loading…</div>;

  const columns: { title: string; list: TaskRow[]; empty: string }[] = [
    { title: "Waiting on you", list: needsYou, empty: "Nothing is waiting on you." },
    { title: "In progress", list: inProgress, empty: "No agent is on a task right now." },
    { title: "To do", list: toDo, empty: "Nothing queued." },
    { title: "Done", list: closed, empty: "Nothing finished yet." },
  ];

  const filters = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="inline-flex items-center gap-2 h-11 md:h-10 rounded-full bg-control border border-control-line pl-4 pr-3 text-[15px] md:text-sm max-md:w-full">
        <span className="text-faint whitespace-nowrap">Show tasks for</span>
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Show tasks for" className="bg-transparent outline-none font-medium max-md:flex-1 max-md:text-right min-w-0">
          <option value="">Everyone</option>
          <optgroup label="Agents">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.settings.role ? ` (${a.settings.role})` : ""}
              </option>
            ))}
          </optgroup>
          {teams.length > 0 && (
            <optgroup label="Teams">
              {teams.map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  Team {t.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only what I asked for
      </label>
    </div>
  );

  const empty = roots.length === 0 && (
    <div className="rounded-3xl border border-dashed border-line px-4 py-6 text-sm text-muted">
      Nothing yet. Start a task and {agents.find((a) => a.id === leadId)?.name ?? "the lead"} plans it and hands the pieces out.{" "}
      {me.role !== "guest" && (
        <button className="text-accent-text hover:underline" onClick={() => useStore.setState({ newTaskOpen: true })}>
          New task
        </button>
      )}
    </div>
  );

  return (
    <>
      {phone ? (
        <div className="flex-1 overflow-y-auto px-[18px] pb-28 flex flex-col gap-3">
          {filters}
          {empty}
          {columns.map(
            (c) =>
              c.list.length > 0 && (
                <section key={c.title} className="flex flex-col gap-3">
                  <SectionHead title={c.title} right={c.list.length} />
                  <GroupCard>
                    {c.list.map((t, i) => (
                      <div key={t.id}>
                        {i > 0 && <Rule />}
                        <TaskRowItem task={t} ctx={ctx} onOpen={() => setSelectedId(t.id)} />
                      </div>
                    ))}
                  </GroupCard>
                </section>
              ),
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 min-w-0 overflow-y-auto px-7 pb-8 flex flex-col gap-5">
            {filters}
            {empty}
            <div className="flex gap-3.5 items-start">
              {columns.map((c) => (
                <section key={c.title} className="flex-1 min-w-0 flex flex-col gap-2.5" aria-label={c.title}>
                  <div className="flex justify-between px-1 text-[13px] font-semibold text-muted">
                    <h2>{c.title}</h2>
                    <span className="font-medium text-faint">{c.list.length}</span>
                  </div>
                  {c.list.map((t) => (
                    <TaskCardItem key={t.id} task={t} ctx={ctx} selected={t.id === selectedId} onOpen={() => setSelectedId(t.id)} />
                  ))}
                </section>
              ))}
            </div>
          </div>
          {selected && (
            <aside className="w-[400px] max-w-[45%] shrink-0 border-l border-line overflow-y-auto px-6 pt-[30px] pb-6 flex flex-col" aria-label="Task">
              <TaskDetail key={selected.id} task={selected} ctx={ctx} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />
            </aside>
          )}
        </>
      )}
      {phone && selected && (
        <Modal title={selected.title} headerless onClose={() => setSelectedId(null)} className="!rounded-t-[38px] sm:!rounded-[38px]" contentClassName="!px-0 !pb-0">
          <div className="px-[18px] pt-4 pb-8">
            <TaskDetail key={selected.id} task={selected} ctx={ctx} onSelect={setSelectedId} onClose={() => setSelectedId(null)} sheet />
          </div>
        </Modal>
      )}
    </>
  );
}

const iconFor = (s: State, size = 22) => {
  const p = { size, strokeWidth: 1.8, className: "shrink-0" };
  if (s === "done") return <CircleCheck {...p} className="shrink-0 text-ok" />;
  if (s === "failed") return <CircleX {...p} className="shrink-0 text-bad" />;
  if (s === "cancelled") return <CircleX {...p} className="shrink-0 text-faint" />;
  if (s === "working") return <Loader2 {...p} className="shrink-0 animate-spin text-ok" />;
  if (s === "blocked") return <WifiOff {...p} className="shrink-0 text-faint" />;
  return <Circle {...p} className="shrink-0 text-faint" />;
};

/** A phone row: the assignee's ghost, the title, its state and who has it. */
function TaskRowItem({ task: t, ctx, onOpen }: { task: TaskRow; ctx: Ctx; onOpen: () => void }) {
  const agent = ctx.agents.find((a) => a.id === t.toAgentId);
  const state = ctx.stateOf(t);
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-3 min-h-[68px] px-4 py-3 text-left hover:bg-hover min-w-0">
      <AgentAvatar agent={agent} size={32} interactive={false} />
      <span className="min-w-0 flex-1 flex flex-col gap-[5px]">
        <span className="truncate text-base font-semibold">{t.title}</span>
        <span className="flex items-center gap-2 min-w-0">
          <StateChip tone={STATE[state].tone}>{ctx.stateLabel(t)}</StateChip>
          <span className="text-[13px] text-faint truncate">{agent?.name ?? "an agent"}</span>
        </span>
      </span>
      <ChevronRight size={16} strokeWidth={2} className="text-faint shrink-0" />
    </button>
  );
}

/** A desktop column card. */
function TaskCardItem({ task: t, ctx, selected, onOpen }: { task: TaskRow; ctx: Ctx; selected: boolean; onOpen: () => void }) {
  const agent = ctx.agents.find((a) => a.id === t.toAgentId);
  const state = ctx.stateOf(t);
  const subs = ctx.children.get(t.id) ?? [];
  const done = subs.filter((s) => s.status === "done").length;
  return (
    <button onClick={onOpen} aria-pressed={selected} className={cx("text-left rounded-[18px] bg-card border px-3.5 py-3 flex flex-col gap-2 w-full transition-colors hover:bg-hover", selected ? "border-badge/70" : "border-line")}>
      <span className="text-sm font-semibold leading-snug break-words">{t.title}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <AgentAvatar agent={agent} size={22} interactive={false} />
        <span className="text-xs text-faint flex-1 min-w-12 truncate">{agent?.name ?? "an agent"}</span>
        <StateChip tone={STATE[state].tone}>{ctx.stateLabel(t)}</StateChip>
      </span>
      {subs.length > 0 && (
        <span className="flex items-center gap-2 text-xs text-faint">
          <span className="h-1 w-16 rounded-full bg-chip overflow-hidden" aria-hidden>
            <span className="block h-full bg-ok" style={{ width: `${(done / subs.length) * 100}%` }} />
          </span>
          <span className="tabular-nums">
            {done}/{subs.length} subtasks
          </span>
        </span>
      )}
    </button>
  );
}

/**
 * One task, in full: who has it and where it stands, what the agent is doing or what it found,
 * the pieces it was split into, and Merge or Cancel. A panel beside the board on a desktop, a sheet on a phone.
 */
function TaskDetail({ task: t, ctx, onSelect, onClose, sheet }: { task: TaskRow; ctx: Ctx; onSelect: (id: string) => void; onClose: () => void; sheet?: boolean }) {
  const live = useStore((s) => s.live);
  const prefs = usePrefs();
  const agent = ctx.agents.find((a) => a.id === t.toAgentId);
  const state = ctx.stateOf(t);
  const note = ctx.waitingOn(t);
  const subs = ctx.children.get(t.id) ?? [];
  const name = agent?.name ?? "The agent";
  const [confirm, setConfirm] = useState<"merge" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canMerge = !!t.branch && !t.reviewOf && t.status === "done" && !t.mergedAt && ctx.canCancel;

  /** the newest thing the agent is doing for this task, when it's at work on it */
  const run = Object.values(live).find((r) => r.agentId === t.toAgentId && r.channelId === t.channelId && (r.threadId ?? null) === (t.threadId ?? null));
  const doing = state === "needsYou" ? note : state === "working" ? (run ? runSummary(run, ctx.agents) : "Working on it") : null;

  const act = async (kind: "merge" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/tasks/${t.id}/${kind}`);
      setConfirm(null);
      ctx.refetch();
    } catch (err) {
      setConfirm(null);
      setError((err as Error).message);
      ctx.refetch();
    } finally {
      setBusy(false);
    }
  };

  const flat = (list: TaskRow[], depth: number): { t: TaskRow; depth: number }[] => list.flatMap((s) => [{ t: s, depth }, ...flat(ctx.children.get(s.id) ?? [], depth + 1)]);
  const rows = flat(subs, 0);
  const conversation = t.channelId ? () => go({ view: "chat", channelId: t.channelId!, threadId: t.threadId }) : null;
  const when = `${shortTime(Date.parse(t.createdAt), prefs.clock)}`;

  const rowCls = "flex items-center gap-3 px-4 min-h-[52px] py-2";
  const field = (k: string, v: ReactNode) => (
    <div className={rowCls}>
      <span className="w-[78px] shrink-0 text-sm text-faint">{k}</span>
      <span className="flex-1 min-w-0 flex items-center gap-2 text-[15px]">{v}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3.5 flex-1">
      <div className={cx("flex items-start gap-3", sheet ? "justify-between" : "flex-row-reverse")}>
        <button onClick={onClose} className="circle" aria-label={sheet ? "Close" : "Close task"}>
          <X size={20} strokeWidth={2} />
        </button>
        {sheet && (
          <Menu
            align="right"
            trigger={(isOpen, toggle) => (
              <button onClick={toggle} aria-expanded={isOpen} aria-haspopup="menu" aria-label="More" className="circle">
                <MoreHorizontal size={22} strokeWidth={1.8} />
              </button>
            )}
            items={[...(conversation ? [{ label: "Open conversation", onSelect: conversation }] : []), ...(ctx.canCancel && cancellable(state) ? [{ label: "Cancel task", danger: true, onSelect: () => setConfirm("cancel") }] : []), ...(!conversation && !(ctx.canCancel && cancellable(state)) ? [{ label: "Close", onSelect: onClose }] : [])]}
          />
        )}
        {!sheet && (
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <h2 className="text-[22px] font-bold leading-tight break-words">{t.title}</h2>
            <span className="flex items-center gap-2.5 flex-wrap">
              <StateChip tone={STATE[state].tone}>{ctx.stateLabel(t)}</StateChip>
              <span className="text-[13px] text-faint">
                Asked by {ctx.fromName(t.from)} · {when}
              </span>
            </span>
          </div>
        )}
      </div>
      {sheet && (
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-bold leading-tight break-words">{t.title}</h2>
          <span className="flex items-center gap-2.5 flex-wrap">
            <StateChip tone={STATE[state].tone}>{ctx.stateLabel(t)}</StateChip>
            <span className="text-sm text-faint">
              Asked by {ctx.fromName(t.from)} · {when}
            </span>
          </span>
        </div>
      )}

      <GroupCard>
        {field(
          "Assignee",
          <>
            <AgentAvatar agent={agent} size={26} interactive={false} />
            <span className="truncate">
              {agent?.name ?? "an agent"}
              {t.toAgentId === ctx.leadId ? " · lead" : agent?.settings.role ? ` · ${agent.settings.role}` : ""}
            </span>
          </>,
        )}
        <Rule />
        {field("Status", ctx.stateLabel(t))}
        {t.branch && (
          <>
            <Rule />
            {field("Branch", <span className="font-mono text-sm break-all">{t.branch}</span>)}
            {t.mergedAt && (
              <>
                <Rule />
                {field("Merged", timeAgo(t.mergedAt))}
              </>
            )}
          </>
        )}
      </GroupCard>

      {state === "blocked" && (
        <p className="text-sm text-muted flex gap-2 px-1">
          <WifiOff size={15} className="shrink-0 mt-0.5 text-warn" />
          <span>
            {name} is offline. {ctx.deviceName(t) ? `It starts when ${ctx.deviceName(t)} reconnects.` : "It starts once it has a device."}{" "}
            <a href={href({ view: "nodes" })} className="underline hover:text-ink">
              Devices
            </a>
          </span>
        </p>
      )}

      {(doing || conversation) && state !== "done" && state !== "failed" && state !== "cancelled" && (
        <>
          <SectionHead title={`What ${name} is doing`} />
          <GroupCard className="px-4 py-3.5 flex flex-col gap-2">
            {doing && (
              <span className="flex items-start gap-2.5">
                {state === "working" && (
                  <span className="flex gap-1 mt-2" aria-hidden>
                    {[0, 1, 2].map((n) => (
                      <i key={n} className="size-1.5 rounded-full bg-ok animate-pulse" style={{ animationDelay: `${n * 200}ms` }} />
                    ))}
                  </span>
                )}
                <span className={cx("text-[15px] leading-snug", state === "working" ? "text-ok" : "text-warn")}>{doing}</span>
              </span>
            )}
            {t.brief && t.brief !== t.title && <span className="text-sm leading-snug text-ink/80 whitespace-pre-wrap break-words">{t.brief}</span>}
            {conversation && (
              <button onClick={conversation} className="self-start text-sm text-accent-text hover:underline">
                Open conversation
              </button>
            )}
          </GroupCard>
        </>
      )}

      {(t.status === "done" || state === "cancelled" || state === "failed") && (
        <>
          <SectionHead title={state === "cancelled" ? "Cancelled" : state === "failed" ? "What happened" : "Result"} />
          <GroupCard className="px-4 py-3.5 flex flex-col gap-2">
            <span className="text-sm leading-snug text-ink/85 whitespace-pre-wrap break-words">{t.result || (t.brief && t.brief !== t.title ? t.brief : "Nothing was written down.")}</span>
            {conversation && (
              <button onClick={conversation} className="self-start text-sm text-accent-text hover:underline">
                Open conversation
              </button>
            )}
          </GroupCard>
        </>
      )}

      {rows.length > 0 && (
        <>
          <SectionHead title="Subtasks" right={rows.length} />
          <GroupCard>
            {rows.map(({ t: s, depth }, i) => {
              const sa = ctx.agents.find((a) => a.id === s.toAgentId);
              const ss = ctx.stateOf(s);
              return (
                <div key={s.id}>
                  {i > 0 && <Rule />}
                  <button onClick={() => onSelect(s.id)} className="w-full flex items-center gap-3 min-h-[52px] py-2 pr-4 text-left hover:bg-hover" style={{ paddingLeft: 16 + depth * 20 }}>
                    {iconFor(ss, 22)}
                    <span className="flex-1 min-w-0 text-[15px] leading-snug">
                      {s.reviewOf && <span className="text-muted">Review · </span>}
                      {s.title}
                      {sa && <span className="text-faint"> · {sa.name}</span>}
                    </span>
                    <StateChip tone={STATE[ss].tone}>{ctx.stateLabel(s)}</StateChip>
                  </button>
                </div>
              );
            })}
          </GroupCard>
        </>
      )}

      {t.mergedAt && (
        <p className="text-sm text-muted px-1">
          <Check size={14} className="inline mr-1 text-ok" /> The branch was merged {timeAgo(t.mergedAt)}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad whitespace-pre-wrap px-1">
          {error}
        </p>
      )}

      {(canMerge || (ctx.canCancel && cancellable(state))) && (
        <div className="flex gap-2.5 mt-auto pt-1">
          {canMerge && (
            <CardButton tone="primary" className="flex-1 h-11" aria-label="Merge this task's branch" disabled={busy} onClick={() => setConfirm("merge")}>
              Merge
            </CardButton>
          )}
          {ctx.canCancel && cancellable(state) && (
            <CardButton className="flex-1 h-11 text-bad" disabled={busy} onClick={() => setConfirm("cancel")}>
              Cancel task
            </CardButton>
          )}
        </div>
      )}

      {confirm === "merge" && (
        <ConfirmDialog title="Merge this task's branch?" body={`${t.branch} goes into the team's main branch. ${name}'s changes become part of the project.`} confirm="Merge" busy={busy} onConfirm={() => act("merge")} onClose={() => setConfirm(null)} />
      )}
      {confirm === "cancel" && (
        <ConfirmDialog title="Cancel this task?" body={`${name} won't work on it.`} confirm="Cancel task" keep="Keep it" danger busy={busy} onConfirm={() => act("cancel")} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}

/** Start a task. It goes to the lead to plan by default, or straight to an agent or a team's lead. */
export function NewTask({ onClose, defaultTo }: { onClose: () => void; defaultTo?: string }) {
  const agents = useStore((s) => s.agents);
  const teams = useTeams();
  const status = useStore((s) => s.lead);
  const lead = agents.find((a) => a.id === status?.lead);
  const phone = useIsPhone();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [to, setTo] = useState(defaultTo ?? "auto");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = agents.find((a) => a.id === to);
  const devices = useDevices();
  const solo = agents.length === 1 ? agents[0]! : null;
  // who ends up with it, when that is a single agent (not a team)
  const taker = solo ?? (to === "auto" ? lead : picked);
  const readiness = taker ? agentReadiness(taker, devices) : { ready: true, problem: null };
  const takerDevice = taker?.nodeId ? devices?.find((d) => d.id === taker.nodeId) : undefined;
  const waitNote = !readiness.ready && taker?.nodeId && takerDevice && (!takerDevice.online || takerDevice.paused)
    ? `It'll wait until ${takerDevice.name} is connected.`
    : !readiness.ready && taker && !taker.nodeId
      ? "It'll wait until this agent has a device."
      : null;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const fileIds = [];
      for (const f of files) fileIds.push((await uploadFile(f)).id);
      const t = await api<TaskRow>("POST", "/api/tasks", { to, title: title.trim(), brief: brief.trim() || title.trim(), fileIds });
      await useStore.getState().refreshChannels();
      onClose();
      if (t.channelId) go({ view: "chat", channelId: t.channelId, threadId: t.threadId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hint =
    to === "auto" && lead
      ? `${lead.name} breaks it into pieces and hands each to the agent whose role fits. You'll see them as subtasks.`
      : to.startsWith("team:")
        ? "The team's lead takes it and splits it up as needed."
        : picked?.status === "offline"
          ? `${picked.name} is offline; it starts when its device connects.`
          : picked
            ? `${picked.name} starts right away.`
            : "";

  const attach = (
    <div className="flex flex-wrap items-center gap-2">
      <label className={cx("inline-flex items-center gap-2 text-[15px] md:text-sm cursor-pointer", phone ? "w-full" : "text-muted hover:text-ink")}>
        <Paperclip size={phone ? 20 : 17} strokeWidth={1.8} /> <span className={phone ? "flex-1" : undefined}>Attach files</span>
        <input type="file" multiple className="hidden" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
      </label>
      {files.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-chip px-2.5 h-7 text-xs">
          {f.name}
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );

  const choice = (selected: boolean, onClick: () => void, icon: ReactNode, text: ReactNode, aside?: ReactNode) =>
    phone ? (
      <button type="button" onClick={onClick} aria-pressed={selected} className="w-full flex items-center gap-3 min-h-[54px] px-[18px] text-left text-base hover:bg-hover">
        {icon}
        <span className="flex-1 min-w-0 truncate">{text}</span>
        {aside}
        {selected && <CircleCheck size={22} strokeWidth={2} className="text-badge shrink-0" />}
      </button>
    ) : (
      <button type="button" onClick={onClick} aria-pressed={selected} className={cx("inline-flex items-center gap-2 h-10 rounded-full px-4 text-sm font-semibold border", selected ? "bg-chip border-badge" : "bg-chip/60 border-line hover:bg-hover")}>
        {icon}
        {text}
        {aside}
      </button>
    );

  const who = solo ? (
    <p className="text-sm">{solo.name} will do this.</p>
  ) : !lead ? null : (
    <>
      <div className={phone ? "flex flex-col gap-3" : "flex flex-col gap-2"}>
        <div className="px-1.5 text-[13px] font-semibold text-faint">Who takes it?</div>
        {phone ? (
          <GroupCard>
            {choice(to === "auto", () => setTo("auto"), <AgentAvatar agent={lead} size={28} interactive={false} />, `Let ${lead.name} plan it`, <Sparkles size={15} className="text-muted shrink-0" />)}
            {agents
              .filter((a) => a.id !== lead.id)
              .map((a) => (
                <div key={a.id}>
                  <Rule />
                  {choice(to === a.id, () => setTo(a.id), <AgentAvatar agent={a} size={28} interactive={false} />, <>{a.name}{a.settings.role && <span className="text-faint"> · {a.settings.role}</span>}</>)}
                </div>
              ))}
            {teams
              .filter((t) => t.leadId)
              .map((t) => (
                <div key={t.id}>
                  <Rule />
                  {choice(to === `team:${t.name}`, () => setTo(`team:${t.name}`), <Users size={24} strokeWidth={1.8} className="text-muted shrink-0" />, t.name, <span className="text-[13px] text-faint shrink-0">Lead takes it</span>)}
                </div>
              ))}
          </GroupCard>
        ) : (
          <div className="flex flex-wrap gap-2">
            {choice(to === "auto", () => setTo("auto"), <AgentAvatar agent={lead} size={22} interactive={false} />, `Let ${lead.name} plan it`, <Sparkles size={14} className="text-muted" />)}
            {agents
              .filter((a) => a.id !== lead.id)
              .map((a) => choice(to === a.id, () => setTo(a.id), <AgentAvatar agent={a} size={22} interactive={false} key={a.id} />, <span key={a.id + "n"}>{a.name}</span>))}
            {teams
              .filter((t) => t.leadId)
              .map((t) => choice(to === `team:${t.name}`, () => setTo(`team:${t.name}`), <Users size={16} key={t.id} />, `Team ${t.name}`))}
          </div>
        )}
        {hint && <p className="px-1.5 text-xs text-muted">{hint}</p>}
      </div>
    </>
  );

  const footerNote = waitNote && (
    <p className="text-xs text-warn flex gap-1.5 items-center">
      <WifiOff size={13} className="shrink-0" /> {waitNote}
    </p>
  );

  if (!lead) {
    return (
      <Modal title="New task" onClose={onClose} wide>
        <NoAgents />
      </Modal>
    );
  }

  if (phone) {
    return (
      <Modal title="New task" headerless onClose={onClose} className="!rounded-t-[38px]" contentClassName="!px-0 !pb-0">
        <form className="px-[18px] pt-4 pb-8 flex flex-col gap-3.5" onSubmit={submit}>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={onClose} className="circle" aria-label="Close">
              <X size={20} strokeWidth={2} />
            </button>
            <h2 className="text-lg font-bold">New task</h2>
            <CardButton tone="primary" type="submit" disabled={busy || !title.trim()} className="h-11">
              {busy ? <Loader2 size={16} className="animate-spin" /> : "Hand off"}
            </CardButton>
          </div>
          <GroupCard className="py-1">
            <input aria-label="What needs doing?" placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required maxLength={200} className="w-full h-[54px] bg-transparent px-[18px] text-[17px] font-semibold outline-none placeholder:text-faint" />
            <Rule />
            <textarea aria-label="Details" placeholder="Details" value={brief} onChange={(e) => setBrief(e.target.value)} className="w-full h-[110px] resize-none bg-transparent px-[18px] py-3.5 text-base outline-none placeholder:text-faint" />
          </GroupCard>
          {who}
          <GroupCard className="px-[18px] py-3.5">{attach}</GroupCard>
          {footerNote}
          {error && <p className="text-sm text-bad">{error}</p>}
        </form>
      </Modal>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form role="dialog" aria-modal="true" aria-label="New task" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())} className="w-[540px] max-w-full max-h-[92vh] overflow-y-auto rounded-[28px] bg-card border border-control-line shadow-panel p-6 flex flex-col gap-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">New task</h2>
          <button type="button" onClick={onClose} className="circle" aria-label="Close">
            <X size={20} strokeWidth={2} />
          </button>
        </div>
        <input aria-label="What needs doing?" placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required maxLength={200} className="h-12 rounded-2xl border border-control-line bg-panel px-4 text-base font-semibold outline-none placeholder:text-faint focus:border-ring" />
        <textarea aria-label="Details" placeholder="Details" value={brief} onChange={(e) => setBrief(e.target.value)} className="h-24 resize-none rounded-2xl border border-control-line bg-panel px-4 py-3 text-[15px] outline-none placeholder:text-faint focus:border-ring" />
        {who}
        {attach}
        <div className="flex items-center gap-2.5">
          {footerNote}
          <span className="flex-1" />
          <CardButton tone="ghost" onClick={onClose}>
            Cancel
          </CardButton>
          <CardButton tone="primary" type="submit" disabled={busy || !title.trim()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : "Hand off"}
          </CardButton>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
      </form>
    </div>
  );
}
