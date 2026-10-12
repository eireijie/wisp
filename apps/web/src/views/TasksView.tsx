import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, CircleDot, Hand, ListTodo, Loader2, Paperclip, Plus, Sparkles, X } from "lucide-react";
import type { Actor } from "@warren/core";
import { api, uploadFile } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { AgentAvatar, Button, Empty, Field, Input, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";

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
  createdAt: string;
  updatedAt: string;
}

type Column = "todo" | "working" | "waiting" | "done";
const COLUMNS: { id: Column; title: string; empty: string }[] = [
  { id: "todo", title: "To do", empty: "Nothing waiting to start." },
  { id: "working", title: "Working", empty: "No agent is on anything right now." },
  { id: "waiting", title: "Waiting on you", empty: "Nothing needs you." },
  { id: "done", title: "Done", empty: "Finished work shows up here." },
];

/**
 * Work handed to agents, by where it stands. Anything an agent is waiting on you for (an OK, a
 * sign-in on its computer) is pulled out so it doesn't sit unseen.
 */
export function TasksView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const approvals = useStore((s) => s.approvals);
  const computers = useStore((s) => s.computers);
  const version = useStore((s) => s.tasksVersion);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [mine, setMine] = useState(false);

  useEffect(() => {
    api<TaskRow[]>("GET", "/api/tasks").then(setTasks, () => setTasks([]));
  }, [version]);

  const waitingOn = (t: TaskRow) => {
    const inThread = (x: { channelId: string; threadId: string | null }) => x.channelId === t.channelId && (x.threadId === t.threadId || (!!t.threadId && x.threadId === null));
    const approval = Object.values(approvals).find((a) => a.status === "pending" && a.agentId === t.toAgentId && inThread(a));
    if (approval) return `Wants your OK: ${approval.summary}`;
    const help = computers.find((c) => c.help && c.help.agentId === t.toAgentId && inThread(c.help));
    return help ? `Needs you on ${help.name}: ${help.help!.request}` : null;
  };

  const board = useMemo(() => {
    const cols: Record<Column, { task: TaskRow; note: string | null }[]> = { todo: [], working: [], waiting: [], done: [] };
    for (const t of tasks ?? []) {
      if (mine && !(t.from.kind === "user" && t.from.id === me.user.id)) continue;
      const note = t.status === "done" || t.status === "failed" ? null : waitingOn(t);
      const busy = agents.find((a) => a.id === t.toAgentId)?.status === "busy";
      const col: Column = t.status === "done" || t.status === "failed" ? "done" : note ? "waiting" : t.status === "in_progress" || (busy && t.status === "open") ? "working" : "todo";
      cols[col].push({ task: t, note });
    }
    cols.done = cols.done.slice(0, 30);
    return cols;
  }, [tasks, mine, approvals, computers, agents, me.user.id]);

  const fromName = (a: Actor) => (a.kind === "agent" ? `@${agents.find((x) => x.id === a.id)?.handle ?? "agent"}` : a.id === me.user.id ? "you" : (members.find((m) => m.id === a.id)?.name ?? "someone"));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">Tasks</h1>
        <label className="hidden sm:flex items-center gap-2 text-xs text-muted mr-2">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only what I asked for
        </label>
        {me.role !== "guest" && (
          <Button variant="primary" onClick={() => useStore.setState({ newTaskOpen: true })}>
            <Plus size={16} /> New task
          </Button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        {tasks && tasks.length === 0 ? (
          <Empty icon={<ListTodo />} title="Hand your agents some work">
            <p>Say what needs doing and pick who should do it, or let Warren pick. You'll see it move from To do to Working to Done, and anything an agent needs from you shows up under Waiting on you.</p>
            {me.role !== "guest" && (
              <Button variant="primary" onClick={() => useStore.setState({ newTaskOpen: true })}>
                <Plus size={16} /> New task
              </Button>
            )}
          </Empty>
        ) : (
          <div className="p-4 md:p-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4 max-w-7xl">
            {COLUMNS.map((col) => (
              <section key={col.id} className="min-w-0">
                <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
                  {col.title} <span className="tabular-nums text-faint">{board[col.id].length}</span>
                </h2>
                <div className="space-y-2">
                  {!tasks ? (
                    <p className="text-sm text-muted">Loading…</p>
                  ) : board[col.id].length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line px-3 py-4 text-xs text-muted">{col.empty}</p>
                  ) : (
                    board[col.id].map(({ task: t, note }) => {
                      const agent = agents.find((a) => a.id === t.toAgentId);
                      return (
                        <button
                          key={t.id}
                          onClick={() => t.channelId && go({ view: "chat", channelId: t.channelId, threadId: t.threadId })}
                          className={cx("w-full text-left rounded-xl border bg-panel p-3 hover:shadow-panel transition-shadow space-y-2", col.id === "waiting" ? "border-accent/50" : "border-line")}
                        >
                          <div className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{t.title}</span>
                            {t.status === "failed" ? <Pill tone="bad">Failed</Pill> : t.status === "done" ? <Check size={15} className="text-ok shrink-0 mt-0.5" /> : col.id === "working" ? <Loader2 size={14} className="animate-spin text-muted shrink-0 mt-0.5" /> : null}
                          </div>
                          {note && (
                            <p className="text-xs text-accent-text flex gap-1.5">
                              <Hand size={13} className="shrink-0 mt-px" /> <span className="line-clamp-2">{note}</span>
                            </p>
                          )}
                          {col.id === "done" && t.result && <p className="text-xs text-muted line-clamp-2">{t.result}</p>}
                          <div className="flex items-center gap-2 text-xs text-muted">
                            {agent && <AgentAvatar agent={agent} size={20} badge={false} />}
                            <span className="truncate">
                              {agent ? agent.name : "an agent"} · from {fromName(t.from)} · {timeAgo(t.updatedAt)}
                            </span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hand something to an agent: what, who (an agent, a team's lead, or let Warren pick), and any
 * files. It starts right away in the agent's DM (or its team's channel), as a task you can follow.
 */
export function NewTask({ onClose, defaultTo }: { onClose: () => void; defaultTo?: string }) {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [to, setTo] = useState(defaultTo ?? (agents.length > 1 ? "auto" : (agents[0]?.id ?? "auto")));
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
      {agents.length === 0 ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted">Add an agent first, then hand it work here.</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => (onClose(), go({ view: "agents", agentId: null }))}>
              Add an agent
            </Button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label="What needs doing?">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Find three venues for the offsite under $5k" autoFocus required maxLength={200} />
          </Field>
          <Field label="Details (optional)" hint="Links, what done looks like, anything it shouldn't do.">
            <Textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} />
          </Field>
          <div>
            <div className="text-sm font-medium mb-1.5">Who should do it?</div>
            <div className="flex flex-wrap gap-1.5">
              {agents.length > 1 && (
                <Chip selected={to === "auto"} onClick={() => setTo("auto")}>
                  <Sparkles size={14} /> Let Warren pick
                </Chip>
              )}
              {agents.map((a) => (
                <Chip key={a.id} selected={to === a.id} onClick={() => setTo(a.id)}>
                  <AgentAvatar agent={a} size={18} badge={false} /> {a.name}
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
            <p className="mt-1.5 text-xs text-muted">
              {to === "auto"
                ? "Your boss agent (or a team lead) takes it, and does it or hands it to whoever should."
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
              {busy && <Loader2 size={15} className="animate-spin" />} Hand it off
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
