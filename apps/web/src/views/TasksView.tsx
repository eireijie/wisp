import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, Crown, Hand, Loader2, Paperclip, Plus, Sparkles, Workflow, X } from "lucide-react";
import type { Actor, Agent, OrchestrationStatus } from "@warren/core";
import { api, uploadFile } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { AgentAvatar, Button, Field, Input, Loader, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { OrchestrationChecklist } from "../components/Orchestration.tsx";

export interface TaskRow {
  id: string;
  from: Actor;
  toAgentId: string;
  title: string;
  brief: string;
  status: "open" | "in_progress" | "done" | "failed";
  result: string | null;
  channelId: string | null;
  threadId: string | null;
  teamId: string | null;
  reviewOf: string | null;
  /** the task this is a piece of; null at the top */
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

type State = "todo" | "working" | "waiting" | "done" | "failed";
const STATE: Record<State, { label: string; tone: "neutral" | "ok" | "warn" | "bad" | "info" | "accent" }> = {
  todo: { label: "To do", tone: "neutral" },
  working: { label: "Working", tone: "info" },
  waiting: { label: "Needs you", tone: "accent" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
};

/**
 * Tasks is the Orchestration addon's home. Off: what it is and where to turn it on. On but not set
 * up: the checklist. Ready: the board, where a dispatcher's tasks show the subtasks it handed out.
 */
export function TasksView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const status = useStore((s) => s.orchestration);
  const agents = useStore((s) => s.agents);
  const dispatcher = agents.find((a) => a.id === status?.dispatcherId);
  useEffect(() => {
    useStore.getState().refreshOrchestration();
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">Tasks</h1>
        {status?.ready && dispatcher && (
          <a href="#/settings/addons" className="hidden sm:flex items-center gap-1.5 text-xs text-muted hover:text-ink mr-1" title="The dispatcher takes every task nobody assigned">
            <Crown size={13} /> Dispatcher <AgentAvatar agent={dispatcher} size={18} badge={false} /> <span className="text-ink">{dispatcher.name}</span>
          </a>
        )}
        {status?.ready && me.role !== "guest" && (
          <Button variant="primary" onClick={() => useStore.setState({ newTaskOpen: true })}>
            <Plus size={16} /> New task
          </Button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">{!status ? <Loader /> : !status.ready ? <SetUp status={status} /> : <Board dispatcherId={status.dispatcherId!} />}</div>
    </div>
  );
}

/** What Tasks needs before it works: the addon turned on and set up. Also shown in New task. */
function SetUp({ status, compact }: { status: OrchestrationStatus; compact?: boolean }) {
  const owner = useStore((s) => s.me)?.role === "owner";
  return (
    <div className={cx("mx-auto max-w-xl", compact ? "space-y-4" : "px-4 py-12 md:py-16 space-y-6")}>
      <div className={cx("space-y-2", !compact && "text-center")}>
        {!compact && (
          <span className="mx-auto grid place-items-center size-11 rounded-xl bg-accent-soft text-accent-text">
            <Workflow size={22} />
          </span>
        )}
        <h2 className={cx("font-semibold", compact ? "text-sm" : "text-lg")}>{status.enabled ? "Finish setting up Orchestration" : "Tasks is an addon"}</h2>
        <p className="text-sm text-muted">
          Tasks lets a lead agent, the dispatcher, take work and hand it out to agents with roles, so you can follow a job from the plan to the pieces to done.{" "}
          {status.enabled ? "A few steps are left:" : owner ? "Turn it on in Settings → Addons." : "An owner can turn it on in Settings → Addons."} Agents still hand each other work in chat either way.
        </p>
      </div>
      {status.enabled ? (
        <OrchestrationChecklist status={status} onNavigate={compact ? () => useStore.setState({ newTaskOpen: false }) : undefined} />
      ) : (
        owner && (
          <div className={cx("flex", !compact && "justify-center")}>
            <Button variant="primary" onClick={() => (useStore.setState({ newTaskOpen: false }), go({ view: "settings", page: "addons" }))}>
              Set it up in Addons <ChevronRight size={15} />
            </Button>
          </div>
        )
      )}
    </div>
  );
}

function Board({ dispatcherId }: { dispatcherId: string }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const members = useStore((s) => s.members);
  const approvals = useStore((s) => s.approvals);
  const computers = useStore((s) => s.computers);
  const version = useStore((s) => s.tasksVersion);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [who, setWho] = useState("");
  const [mine, setMine] = useState(false);

  useEffect(() => {
    api<TaskRow[]>("GET", "/api/tasks").then(setTasks, () => setTasks([]));
  }, [version]);

  const waitingOn = (t: TaskRow) => {
    if (t.status === "done" || t.status === "failed") return null;
    const inThread = (x: { channelId: string; threadId: string | null }) => x.channelId === t.channelId && (x.threadId === t.threadId || (!!t.threadId && x.threadId === null));
    const approval = Object.values(approvals).find((a) => a.status === "pending" && a.agentId === t.toAgentId && inThread(a));
    if (approval) return `Wants your OK: ${approval.summary}`;
    const help = computers.find((c) => c.help && c.help.agentId === t.toAgentId && inThread(c.help));
    return help ? `Needs you on ${help.name}: ${help.help!.request}` : null;
  };
  const stateOf = (t: TaskRow): State => {
    if (t.status === "done") return "done";
    if (t.status === "failed") return "failed";
    if (waitingOn(t)) return "waiting";
    const busy = agents.find((a) => a.id === t.toAgentId)?.status === "busy";
    return t.status === "in_progress" || (busy && t.status === "open") ? "working" : "todo";
  };

  // the tree: subtasks (and reviews) hang under the task they're a piece of
  const { roots, children } = useMemo(() => {
    const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
    const children = new Map<string, TaskRow[]>();
    const roots: TaskRow[] = [];
    for (const t of [...(tasks ?? [])].reverse()) {
      const up = t.parentId ?? t.reviewOf;
      if (up && byId.has(up)) children.set(up, [...(children.get(up) ?? []), t]);
      else roots.push(t);
    }
    return { roots: roots.reverse(), children };
  }, [tasks]);

  const all = (t: TaskRow): TaskRow[] => [t, ...(children.get(t.id) ?? []).flatMap(all)];
  const matches = (t: TaskRow) => {
    if (mine && !(t.from.kind === "user" && t.from.id === me.user.id)) return false;
    if (!who) return true;
    const tree = all(t);
    return who.startsWith("team:") ? tree.some((x) => x.teamId === who.slice(5)) : tree.some((x) => x.toAgentId === who);
  };
  const shown = roots.filter(matches);
  const open = shown.filter((t) => t.status !== "done" && t.status !== "failed");
  const closed = shown.filter((t) => t.status === "done" || t.status === "failed").slice(0, 20);
  const needsYou = shown.flatMap(all).map((t) => ({ t, note: waitingOn(t) })).filter((x) => x.note);

  const fromName = (a: Actor) => (a.kind === "agent" ? `@${agents.find((x) => x.id === a.id)?.handle ?? "agent"}` : a.id === me.user.id ? "you" : (members.find((m) => m.id === a.id)?.name ?? "someone"));
  const ctx: CardCtx = { agents, dispatcherId, children, stateOf, waitingOn, fromName };

  if (!tasks) return <Loader />;
  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Show tasks for" className="h-8 rounded-lg border border-line bg-panel px-2 text-sm">
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
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only what I asked for
        </label>
      </div>

      {needsYou.length > 0 && (
        <section>
          <SectionTitle title="Waiting on you" count={needsYou.length} />
          <div className="space-y-2">
            {needsYou.map(({ t, note }) => (
              <button key={t.id} onClick={() => openTask(t)} className="w-full text-left rounded-xl border border-accent/50 bg-panel px-3 py-2.5 hover:shadow-panel transition-shadow">
                <div className="text-sm font-medium">{t.title}</div>
                <p className="mt-1 text-xs text-accent-text flex gap-1.5">
                  <Hand size={13} className="shrink-0 mt-px" /> <span className="line-clamp-2">{note}</span>
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle title="In progress" count={open.length} />
        {open.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
            {roots.length === 0 ? (
              <>
                Nothing yet. Start a task and {agents.find((a) => a.id === dispatcherId)?.name ?? "the dispatcher"} plans it and hands the pieces out.{" "}
                {me.role !== "guest" && (
                  <button className="text-accent-text hover:underline" onClick={() => useStore.setState({ newTaskOpen: true })}>
                    New task
                  </button>
                )}
              </>
            ) : (
              "Nothing in progress here."
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {open.map((t) => (
              <TaskCard key={t.id} task={t} ctx={ctx} defaultOpen />
            ))}
          </div>
        )}
      </section>

      {closed.length > 0 && (
        <section>
          <SectionTitle title="Done" count={closed.length} />
          <div className="space-y-3">
            {closed.map((t) => (
              <TaskCard key={t.id} task={t} ctx={ctx} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface CardCtx {
  agents: Agent[];
  dispatcherId: string;
  children: Map<string, TaskRow[]>;
  stateOf: (t: TaskRow) => State;
  waitingOn: (t: TaskRow) => string | null;
  fromName: (a: Actor) => string;
}

const openTask = (t: TaskRow) => t.channelId && go({ view: "chat", channelId: t.channelId, threadId: t.threadId });

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
      {title} <span className="tabular-nums text-faint">{count}</span>
    </h2>
  );
}

function StateIcon({ state }: { state: State }) {
  if (state === "done") return <Check size={15} className="text-ok shrink-0" />;
  if (state === "working") return <Loader2 size={14} className="animate-spin text-muted shrink-0" />;
  if (state === "waiting") return <Hand size={14} className="text-accent-text shrink-0" />;
  if (state === "failed") return <X size={15} className="text-bad shrink-0" />;
  return <CircleDot size={14} className="text-faint shrink-0" />;
}

/** A top-level task: who has it, how far its subtasks are, and the subtasks themselves. */
function TaskCard({ task: t, ctx, defaultOpen }: { task: TaskRow; ctx: CardCtx; defaultOpen?: boolean }) {
  const subs = ctx.children.get(t.id) ?? [];
  const [open, setOpen] = useState(!!defaultOpen);
  const state = ctx.stateOf(t);
  const agent = ctx.agents.find((a) => a.id === t.toAgentId);
  const done = subs.filter((s) => s.status === "done").length;
  const note = ctx.waitingOn(t);
  return (
    <article className={cx("rounded-xl border bg-panel", state === "waiting" ? "border-accent/50" : "border-line")}>
      <div className="p-3.5 space-y-2.5">
        <div className="flex items-start gap-2">
          <button onClick={() => openTask(t)} className="min-w-0 flex-1 text-left text-sm font-medium leading-snug hover:underline">
            {t.title}
          </button>
          <Pill tone={STATE[state].tone}>{STATE[state].label}</Pill>
        </div>
        {note && (
          <p className="text-xs text-accent-text flex gap-1.5">
            <Hand size={13} className="shrink-0 mt-px" /> <span className="line-clamp-2">{note}</span>
          </p>
        )}
        {t.status === "done" && t.result && <p className="text-xs text-muted line-clamp-2">{t.result}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
          <span className="flex items-center gap-1.5 min-w-0">
            {agent && <AgentAvatar agent={agent} size={20} badge={false} />}
            <span className="truncate">
              {agent?.name ?? "an agent"}
              {t.toAgentId === ctx.dispatcherId ? " · dispatcher" : agent?.settings.role ? ` · ${agent.settings.role}` : ""}
            </span>
          </span>
          <span>from {ctx.fromName(t.from)}</span>
          <span>{timeAgo(t.updatedAt)}</span>
          {subs.length > 0 && (
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="ml-auto flex items-center gap-2 hover:text-ink">
              <span className="h-1.5 w-20 rounded-full bg-chip overflow-hidden" aria-hidden>
                <span className="block h-full bg-ok" style={{ width: `${(done / subs.length) * 100}%` }} />
              </span>
              <span className="tabular-nums">
                {done}/{subs.length} subtasks
              </span>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
        </div>
      </div>
      {open && subs.length > 0 && (
        <ul className="border-t border-line py-1">
          {subs.map((s) => (
            <SubtaskRow key={s.id} task={s} ctx={ctx} depth={0} />
          ))}
        </ul>
      )}
    </article>
  );
}

function SubtaskRow({ task: t, ctx, depth }: { task: TaskRow; ctx: CardCtx; depth: number }) {
  const agent = ctx.agents.find((a) => a.id === t.toAgentId);
  const state = ctx.stateOf(t);
  const subs = ctx.children.get(t.id) ?? [];
  return (
    <>
      <li>
        <button onClick={() => openTask(t)} className="w-full text-left flex items-center gap-2.5 px-3.5 py-2 hover:bg-hover" style={{ paddingLeft: `${14 + depth * 20}px` }}>
          <StateIcon state={state} />
          <span className="min-w-0 flex-1 truncate text-sm">
            {t.reviewOf ? <span className="text-muted">Review · </span> : null}
            {t.title}
          </span>
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-muted shrink-0 max-w-[40%]">
            {agent && <AgentAvatar agent={agent} size={18} badge={false} />}
            <span className="truncate">
              {agent?.name ?? "an agent"}
              {agent?.settings.role ? ` · ${agent.settings.role}` : ""}
            </span>
          </span>
          <span className="w-20 text-right text-xs text-muted shrink-0">{STATE[state].label}</span>
        </button>
      </li>
      {subs.map((s) => (
        <SubtaskRow key={s.id} task={s} ctx={ctx} depth={depth + 1} />
      ))}
    </>
  );
}

/**
 * Start a task. With Orchestration set up it goes to the dispatcher to plan by default, or straight
 * to an agent or a team's lead. Without it, explains the addon instead (the sidebar opens this).
 */
export function NewTask({ onClose, defaultTo }: { onClose: () => void; defaultTo?: string }) {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const status = useStore((s) => s.orchestration);
  const dispatcher = agents.find((a) => a.id === status?.dispatcherId);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [to, setTo] = useState(defaultTo ?? "auto");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = agents.find((a) => a.id === to);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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

  return (
    <Modal title="New task" onClose={onClose} wide>
      {!status ? (
        <Loader />
      ) : !status.ready || !dispatcher ? (
        <SetUp status={status} compact />
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label="What needs doing?">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Find three venues for the offsite under $5k" autoFocus required maxLength={200} />
          </Field>
          <Field label="Details (optional)" hint="Links, what done looks like, anything it shouldn't do.">
            <Textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} />
          </Field>
          <div>
            <div className="text-sm font-medium mb-1.5">Who takes it?</div>
            <Chip selected={to === "auto"} onClick={() => setTo("auto")}>
              <AgentAvatar agent={dispatcher} size={18} badge={false} /> Let {dispatcher.name} plan it <Sparkles size={13} className="text-muted" />
            </Chip>
            <div className="mt-3 mb-1.5 text-xs text-muted">or hand it straight to…</div>
            <div className="flex flex-wrap gap-1.5">
              {agents
                .filter((a) => a.id !== dispatcher.id)
                .map((a) => (
                  <Chip key={a.id} selected={to === a.id} onClick={() => setTo(a.id)}>
                    <AgentAvatar agent={a} size={18} badge={false} /> {a.name}
                    {a.settings.role && <span className="text-muted">· {a.settings.role}</span>}
                  </Chip>
                ))}
              {teams
                .filter((t) => t.leadId)
                .map((t) => (
                  <Chip key={t.id} selected={to === `team:${t.name}`} onClick={() => setTo(`team:${t.name}`)}>
                    {t.emoji || <CircleDot size={14} />} Team {t.name}
                  </Chip>
                ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {to === "auto"
                ? `${dispatcher.name} breaks it into pieces and hands each to the agent whose role fits. You'll see them as subtasks.`
                : to.startsWith("team:")
                  ? "The team's lead takes it and splits it up as needed."
                  : picked?.status === "offline"
                    ? `${picked.name} is offline; it starts when its device connects.`
                    : picked
                      ? `${picked.name} starts right away.`
                      : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink cursor-pointer">
              <Paperclip size={15} /> Attach files
              <input type="file" multiple className="hidden" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
            </label>
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-chip px-2 h-6 text-xs">
                {f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !title.trim()}>
              {busy && <Loader2 size={15} className="animate-spin" />} {to === "auto" ? `Send to ${dispatcher.name}` : "Hand it off"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 h-8 text-sm", selected ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}>
      {children}
    </button>
  );
}
