import { toolKey } from "./agentActivity.ts";
import { useEffect, useState } from "react";
import { CalendarClock, Check, ListChecks, LockKeyhole, Monitor, Pencil, RotateCcw, X } from "lucide-react";
import { LOGIN_SOURCE_LABEL, describeCron, type Agent, type Approval, type Routine } from "@wisp/core";
import { api } from "../api.ts";
import { usePrefs, useStore } from "../store.ts";
import { undoChange, useChanges } from "../changes.ts";
import { href } from "../router.ts";
import { ComputerMini } from "../views/ComputersView.tsx";
import { StorageLogo } from "../views/settings/storage.tsx";
import { Pill, cx, clockTime } from "./ui.tsx";

/** An agent's request on its computer ("Sign in to Zendesk…"): a card that takes you there; with no request, the screen live. */
export function ComputerPart({ computerId, request, agentName }: { computerId: string; request?: string; agentName?: string }) {
  const computer = useStore((s) => s.computers.find((c) => c.id === computerId));
  if (!computer) return request ? <p className="mt-1 text-sm text-muted">(asked for help on a computer that's gone)</p> : null;
  if (!request)
    return (
      <div className="mt-1.5">
        <ComputerMini computer={computer} quiet />
      </div>
    );
  const waiting = !!computer.help;
  return (
    <ChatCard icon={<Monitor size={13} />} label={waiting ? "Needs you on a computer" : "Helped on a computer"} tone={waiting ? "warn" : "muted"}>
      <div className="mt-2 text-body font-medium leading-snug">
        {agentName ?? "It"} asked for help on {computer.name}
      </div>
      <p className="mt-1 text-sm text-muted">{request}</p>
      <a href={href({ view: "computers", computerId: computer.id })} className="mt-2.5 h-11 w-full rounded-full bg-accent px-5 text-body font-medium text-accent-ink inline-flex items-center justify-center gap-2">
        <Monitor size={16} /> Open {computer.name}
      </a>
    </ChatCard>
  );
}

/** A chat card: a small label with an icon, then the card's own content. Shared by every card an agent posts. */
export function ChatCard({ icon, label, tone = "muted", children, className, ariaLabel }: { icon: React.ReactNode; label: string; tone?: "muted" | "warn"; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  return (
    <section aria-label={ariaLabel ?? label} className={cx("mt-1 w-full max-w-md rounded-3xl bg-card px-4 py-3.5", className)}>
      <div className={cx("flex items-center gap-1.5 text-[13px] font-medium", tone === "warn" ? "text-warn" : "text-muted")}>
        <span className="shrink-0 grid place-items-center">{icon}</span>
        {label}
      </div>
      {children}
    </section>
  );
}

/** "You approved this · 9:41 PM" under a decided card. */
function Decided({ ok, text, at }: { ok: boolean; text: string; at?: string | null }) {
  const { clock } = usePrefs();
  return (
    <div className={cx("mt-2 flex items-center gap-1.5 text-[13px]", ok ? "text-ok" : "text-muted")}>
      {ok ? <Check size={14} /> : <X size={14} />}
      {text}
      {at && <span className="ml-auto text-faint">{clockTime(at, clock)}</span>}
    </div>
  );
}

const CARD_BUTTON = "h-11 rounded-full px-5 text-body font-medium disabled:opacity-50";

/** "Can I go ahead?" with Approve / Not now, and the outcome once someone decides. */
export function ApprovalCard({ id }: { id: string }) {
  const approval = useStore((s) => s.approvals[id]);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.me);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!approval) useStore.getState().loadApproval(id);
  }, [id, approval]);
  if (!approval) return null;
  if (approval.login) return <LoginApprovalCard approval={approval} />;
  if (approval.storage) return <StorageApprovalCard approval={approval} />;
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api("POST", `/api/approvals/${id}/decide`, { approve, note });
      useStore.setState((s) => ({ approvals: { ...s.approvals, [id]: a } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decider = approval.decidedBy === me?.user.id ? "You" : (members.find((m) => m.id === approval.decidedBy)?.name ?? "Someone");
  const pending = approval.status === "pending";
  return (
    <ChatCard icon={<LockKeyhole size={13} />} label="Asking for your OK" ariaLabel="Approval request">
      <div className="mt-2 text-body font-medium leading-snug">{approval.summary}</div>
      {approval.details && <pre className="mt-2 whitespace-pre-wrap break-all rounded-xl bg-code px-3 py-2 font-mono text-[13px] max-h-40 overflow-y-auto">{approval.details}</pre>}
      {pending ? (
        me?.role !== "guest" && (
          <div className="mt-2.5 space-y-2.5">
            <div className="text-sm text-muted">Can I go ahead?</div>
            <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Add a note" placeholder="Add a note (optional)" className="h-11 w-full rounded-2xl border border-control-line bg-control px-3.5 text-sm outline-none placeholder:text-faint focus:border-ring" />
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => decide(true)} className={cx(CARD_BUTTON, "flex-1 bg-accent text-accent-ink")}>
                Approve
              </button>
              <button disabled={busy} onClick={() => decide(false)} className={cx(CARD_BUTTON, "flex-1 border border-control-line bg-control")}>
                Not now
              </button>
            </div>
            {error && <p className="text-xs text-bad">{error}</p>}
          </div>
        )
      ) : (
        <>
          <Decided ok={approval.status === "approved"} text={approval.status === "approved" ? `${decider} approved this` : `${decider} said not now`} at={approval.decidedAt} />
          {approval.note && <p className="mt-1 text-[13px] text-muted">“{approval.note}”</p>}
        </>
      )}
    </ChatCard>
  );
}

/**
 * "Nova wants to use your Zendesk login": only whoever connected the password manager answers,
 * once, always for this agent, or no. Wisp fills it on the agent's computer; nobody sees the password.
 */
function LoginApprovalCard({ approval }: { approval: Approval }) {
  const login = approval.login!;
  const me = useStore((s) => s.me);
  const agent = useStore((s) => s.agents.find((a) => a.id === approval.agentId));
  const owner = useStore((s) => s.members.find((m) => m.id === login.ownerId)?.name ?? "whoever connected it");
  const decider = useStore((s) => (approval.decidedBy === s.me?.user.id ? "You" : (s.members.find((m) => m.id === approval.decidedBy)?.name ?? "Someone")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = agent?.name ?? "An agent";
  const pending = approval.status === "pending";
  const decide = async (approve: boolean, always = false) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api("POST", `/api/approvals/${approval.id}/decide`, { approve, always });
      useStore.setState((s) => ({ approvals: { ...s.approvals, [approval.id]: a } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ChatCard icon={<LockKeyhole size={13} />} label="Login request" ariaLabel="Login request">
      <div className="mt-2 text-body font-medium leading-snug">{pending ? `${name} wants to use your ${login.title} login` : `${name} used your ${login.title} login`}</div>
      {pending && (
        <>
          <p className="mt-1 text-sm text-muted">Your password manager signs in for it. Wisp never sees the password.</p>
          <div className="mt-2 flex items-center gap-2 rounded-xl bg-code px-3 py-2 text-[13px]">
            <LockKeyhole size={14} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate">{login.site}</span>
            <span className="min-w-0 truncate text-muted">{login.username}</span>
          </div>
          <div className="mt-1 text-xs text-faint">From {LOGIN_SOURCE_LABEL[login.source]}</div>
        </>
      )}
      {pending ? (
        me?.user.id !== login.ownerId ? (
          <p className="mt-2.5 text-xs text-muted">Waiting for {owner}: only they can let agents use their logins.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => decide(true)} className={cx(CARD_BUTTON, "flex-1 bg-accent text-accent-ink")}>
              Approve
            </button>
            <button disabled={busy} onClick={() => decide(false)} className={cx(CARD_BUTTON, "flex-1 border border-control-line bg-control")}>
              Not now
            </button>
            <button disabled={busy} onClick={() => decide(true, true)} className="w-full text-center text-[13px] text-muted hover:text-ink">
              Always allow for {name}
            </button>
          </div>
        )
      ) : (
        <Decided ok={approval.status === "approved"} text={approval.status === "approved" ? `${decider} approved this` : `${decider} said not now`} at={approval.decidedAt} />
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </ChatCard>
  );
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * "Can I upload this?" for a file on the person's storage (the Storage mod): the file, where it
 * goes, and Allow / Always in this folder / No. Replacing says Replace; deleting says Delete and
 * never offers Always. Only owners answer.
 */
function StorageApprovalCard({ approval }: { approval: Approval }) {
  const req = approval.storage!;
  const me = useStore((s) => s.me);
  const decider = useStore((s) => (approval.decidedBy === s.me?.user.id ? "You" : (s.members.find((m) => m.id === approval.decidedBy)?.name ?? "Someone")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = approval.status === "pending";
  const name = req.path.slice(req.path.lastIndexOf("/") + 1);
  const folder = req.path.slice(1, req.path.lastIndexOf("/")) || "top folder";
  const verb = { upload: "Upload", replace: "Replace", delete: "Delete", mkdir: "Make folder" }[req.action];
  const decide = async (approve: boolean, always = false) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api("POST", `/api/approvals/${approval.id}/decide`, { approve, always });
      useStore.setState((s) => ({ approvals: { ...s.approvals, [approval.id]: a } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ChatCard icon={<LockKeyhole size={13} />} label="Asking for your OK" ariaLabel="Storage request">
      <div className="mt-2.5 flex items-center gap-3">
        <StorageLogo service={req.service} size={36} />
        <span className="min-w-0">
          <span className="block truncate text-body font-medium">
            {verb} {name}
          </span>
          <span className="block truncate text-[13px] text-muted">
            {req.connectionName} › {folder}
            {req.size !== null ? ` · ${size(req.size)}` : ""}
          </span>
        </span>
      </div>
      {pending ? (
        me?.role !== "owner" ? (
          <p className="mt-2.5 text-xs text-muted">Waiting for an owner to answer.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => decide(true)} className={cx("h-10 rounded-full px-4 text-sm font-medium disabled:opacity-50", req.action === "delete" ? "bg-bad text-white" : "bg-accent text-accent-ink")}>
              {req.action === "delete" ? "Delete" : req.action === "replace" ? "Replace" : "Allow"}
            </button>
            {req.action !== "delete" && (
              <button disabled={busy} onClick={() => decide(true, true)} className="h-10 rounded-full border border-control-line bg-control px-4 text-sm font-medium disabled:opacity-50">
                Always in this folder
              </button>
            )}
            <button disabled={busy} onClick={() => decide(false)} className="h-10 rounded-full border border-control-line bg-control px-4 text-sm font-medium disabled:opacity-50">
              No
            </button>
          </div>
        )
      ) : (
        <Decided ok={approval.status === "approved"} text={approval.status === "approved" ? `${decider} allowed this` : `${decider} said no`} at={approval.decidedAt} />
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </ChatCard>
  );
}

const routineCache = new Map<string, Promise<Routine[]>>();

/** A routine mentioned in chat: its name, schedule and state, as a card that opens it. */
export function RoutineChip({ id }: { id: string }) {
  const version = useStore((s) => s.routinesVersion);
  const [routine, setRoutine] = useState<Routine | null>(null);
  useEffect(() => {
    const key = String(version);
    let p = routineCache.get(key);
    if (!p) routineCache.set(key, (p = api<Routine[]>("GET", "/api/routines").catch(() => [])));
    p.then((list) => setRoutine(list.find((r) => r.id === id) ?? null));
  }, [id, version]);
  if (!routine) return null;
  return (
    <a href={href({ view: "agents", agentId: routine.agentId, tab: "routines" })} className="block">
      <ChatCard icon={<ListChecks size={13} />} label="Routine" className="hover:bg-hover">
        <div className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-medium">{routine.name}</span>
          {routine.status === "learning" && <Pill tone="info">Learning</Pill>}
        </div>
        {routine.schedule && (
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
            <CalendarClock size={13} /> {describeCron(routine.schedule)}
          </div>
        )}
      </ChatCard>
    </a>
  );
}

/**
 * What an agent is doing, the way a teammate would say it: "Sending to Chief…", "Asking
 * Research…", "Using the computer…", with whoever it's talking to.
 */
export function describeTool(name: string, input: unknown, agents: Agent[]): { text: string; with: Agent[] } {
  const tool = toolKey(name);
  const inp = (input ?? {}) as Record<string, unknown>;
  const byHandle = (h: unknown) => agents.find((a) => a.handle === String(h ?? "").replace(/^@/, "").toLowerCase());
  const mentioned = (t: unknown) => [...new Set(String(t ?? "").match(/@([a-z][a-z0-9-]*)/g) ?? [])].map(byHandle).filter((a): a is Agent => !!a);
  const names = (list: Agent[]) => list.map((a) => a.name).join(" and ");
  if (tool === "task_delegate") {
    const to = byHandle(inp.to);
    return to ? { text: `Sending to ${to.name}…`, with: [to] } : { text: "Handing off a task…", with: [] };
  }
  if (tool === "chat_send") {
    const who = mentioned(inp.message);
    return who.length ? { text: `${who.length > 1 ? "Looping in" : "Asking"} ${names(who)}…`, with: who } : { text: "Posting an update…", with: [] };
  }
  if (tool === "discussion_start") {
    const who = (Array.isArray(inp.participants) ? inp.participants : []).map(byHandle).filter((a): a is Agent => !!a);
    return { text: who.length ? `Talking it through with ${names(who)}…` : "Starting a discussion…", with: who };
  }
  if (tool === "computer_ask_human") return { text: "Asking for your help on the computer…", with: [] };
  if (tool.startsWith("computer_")) return { text: { computer_open: "Opening something on the computer…", computer_type: "Typing on the computer…", computer_run: "Running a command on the computer…" }[tool] ?? "Using the computer…", with: [] };
  if (tool === "approval_request") return { text: "Asking for your OK…", with: [] };
  if (tool === "memory_remember" || tool === "memory_write" || tool === "memory_append") return { text: "Updating memory…", with: [] };
  if (tool.startsWith("memory_")) return { text: "Checking memory…", with: [] };
  if (tool === "routine_save") return { text: "Saving the routine…", with: [] };
  if (tool === "file_view") return { text: "Looking at a file…", with: [] };
  return { text: `using ${tool}`, with: [] };
}

/** What an agent changed for you (a setting, a mod, a note), one line each, with Undo. */
export function ChangeCard({ id, fallback }: { id: string; fallback: string }) {
  const changes = useChanges();
  const { clock } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!changes) return null;
  // too old to be in the list: show what changed, without Undo
  const found = changes.find((c) => c.id === id);
  const change = found ?? { id, lines: fallback.split("\n").filter(Boolean), undoneAt: null, createdAt: null as string | null };
  const old = !found;
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await undoChange(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const at = change.createdAt;
  return (
    <ChatCard icon={<Pencil size={13} />} label="Changed">
      {change.lines.map((l) => (
        <div key={l} className={cx("mt-2 text-body font-medium leading-snug", change.undoneAt && "text-muted line-through")}>
          {l}
        </div>
      ))}
      <div className="mt-2.5 flex items-center gap-2">
        {old ? null : change.undoneAt ? (
          <span className="flex items-center gap-1.5 text-[13px] text-muted">
            <RotateCcw size={13} /> Undone
          </span>
        ) : (
          <button className="h-10 rounded-full border border-control-line bg-control px-4 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50" onClick={undo} disabled={busy}>
            <RotateCcw size={14} /> Undo
          </button>
        )}
        {at && !change.undoneAt && <span className="text-[13px] text-faint">{clockTime(at, clock)}</span>}
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
    </ChatCard>
  );
}
