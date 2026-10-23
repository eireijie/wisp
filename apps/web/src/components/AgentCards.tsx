import { useEffect, useState } from "react";
import { CalendarClock, Check, ListChecks, RotateCcw, ShieldQuestion, X } from "lucide-react";
import { describeCron, type Agent, type Routine } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { undoChange, useChanges } from "../changes.ts";
import { href } from "../router.ts";
import { ComputerMini } from "../views/ComputersView.tsx";
import { AgentAvatar, Button, Pill, Textarea, agentVar, cx, timeAgo } from "./ui.tsx";
import { CodeInput, codeLabel, codeReady } from "./ScreenCode.tsx";

/** An agent's request on its computer ("Sign in to Zendesk…"), with the screen live. */
export function ComputerPart({ computerId, request }: { computerId: string; request?: string }) {
  const computer = useStore((s) => s.computers.find((c) => c.id === computerId));
  if (!computer) return request ? <p className="mt-1 text-sm text-muted">(asked for help on a computer that's gone)</p> : null;
  return (
    <div className="mt-1.5">
      {/* the message itself says what the agent asked for */}
      <ComputerMini computer={computer} request={request} quiet />
    </div>
  );
}

const LOAN_FOR = [
  { label: "15 minutes", minutes: 15 as number | null },
  { label: "1 hour", minutes: 60 as number | null },
  { label: "Until it hands it back", minutes: null as number | null },
];

/** "Can I go ahead?" with Approve / Deny, and the outcome once someone decides. */
export function ApprovalCard({ id }: { id: string }) {
  const approval = useStore((s) => s.approvals[id]);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.me);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(60);
  const [code, setCode] = useState("");
  // a screen with a code: its owner types it to say yes, and the device checks it
  const codeKind = useStore((s) => (approval?.loan ? (s.computers.find((c) => c.kind === "device" && c.nodeId === approval.loan!.nodeId)?.code ?? null) : null));
  useEffect(() => {
    if (!approval) useStore.getState().loadApproval(id);
  }, [id, approval]);
  if (!approval) return null;
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api("POST", `/api/approvals/${id}/decide`, { approve, note, ...(approval?.loan && approve ? { minutes, ...(codeKind ? { code } : {}) } : {}) });
      useStore.setState((s) => ({ approvals: { ...s.approvals, [id]: a } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decider = members.find((m) => m.id === approval.decidedBy)?.name ?? "Someone";
  const pending = approval.status === "pending";
  // borrowing a device: only its owner can say yes, and picks how long
  const loan = approval.loan;
  const canDecide = !loan || loan.ownerId === me?.user.id;
  const ownerName = loan ? (members.find((m) => m.id === loan.ownerId)?.name ?? "its owner") : "";
  return (
    <div className={cx("mt-1.5 max-w-lg rounded-2xl border p-3", pending ? "border-accent/40 bg-accent-soft/40" : "border-line bg-panel")}>
      <div className="flex items-start gap-2">
        <ShieldQuestion size={16} className={cx("mt-0.5 shrink-0", pending ? "text-accent-text" : "text-muted")} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{approval.summary}</div>
          {approval.details && (
            <button onClick={() => setOpen(!open)} className="text-xs text-muted hover:text-ink">
              {open ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
        {!pending && <Pill tone={approval.status === "approved" ? "ok" : "bad"}>{approval.status === "approved" ? "Approved" : "Denied"}</Pill>}
      </div>
      {open && approval.details && <pre className="mt-2 whitespace-pre-wrap text-xs bg-bg rounded-lg p-2 max-h-72 overflow-y-auto">{approval.details}</pre>}
      {pending ? (
        !canDecide ? (
          <p className="mt-1.5 text-xs text-muted">Waiting for {ownerName}: only they can lend {loan!.deviceName}.</p>
        ) : (
        me?.role !== "guest" && (
          <div className="mt-2.5 space-y-2">
            {loan && (
              <div className="space-y-1">
                <div className="text-xs text-muted">How long can it use it?</div>
                <div className="flex flex-wrap gap-1.5">
                  {LOAN_FOR.map((o) => (
                    <button
                      key={o.label}
                      onClick={() => setMinutes(o.minutes)}
                      className={cx("h-8 px-3 rounded-lg border text-xs", minutes === o.minutes ? "border-accent bg-accent-soft text-accent-text font-medium" : "border-line hover:bg-hover")}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted">It only gets the screen, never a shell, and never for more than 12 hours. You can take it back any time.</p>
                {codeKind && <CodeInput kind={codeKind} value={code} onChange={setCode} className="max-w-48" />}
              </div>
            )}
            <Textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" className="text-sm" />
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy || !codeReady(codeKind, code)} title={codeReady(codeKind, code) ? undefined : `Enter its ${codeLabel(codeKind)} first`} onClick={() => decide(true)}>
                <Check size={15} /> Approve
              </Button>
              <Button disabled={busy} onClick={() => decide(false)}>
                <X size={15} /> Deny
              </Button>
            </div>
            {error && <p className="text-xs text-bad">{error}</p>}
          </div>
        )
        )
      ) : (
        <p className="mt-1 text-xs text-muted">
          {decider} {approval.status} this {approval.decidedAt ? timeAgo(approval.decidedAt) : ""}
          {approval.note ? `: "${approval.note}"` : "."}
        </p>
      )}
    </div>
  );
}

const routineCache = new Map<string, Promise<Routine[]>>();

/** A routine mentioned in chat: its name, schedule and steps. */
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
    <a href={href({ view: "agents", agentId: routine.agentId, tab: "routines" })} className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-panel px-3 h-8 text-xs hover:bg-hover">
      <ListChecks size={14} className="text-accent-text shrink-0" />
      <span className="font-medium truncate">{routine.name}</span>
      {routine.status === "learning" ? (
        <Pill tone="info">learning</Pill>
      ) : routine.schedule ? (
        <span className="text-muted inline-flex items-center gap-1 shrink-0">
          <CalendarClock size={12} /> {describeCron(routine.schedule)}
        </span>
      ) : null}
    </a>
  );
}

const pretty = (n: string) => n.replace(/^mcp__warren__/, "").replace(/^mcp__/, "").replace(/^warren\./, "");

/**
 * What an agent is doing, the way a teammate would say it: "Sending to Chief…", "Asking
 * Research…", "Using the computer…", with whoever it's talking to.
 */
export function describeTool(name: string, input: unknown, agents: Agent[]): { text: string; with: Agent[] } {
  const tool = pretty(name);
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

/** Agent avatars and a status, like "◉◉ ••• Sending to Chief… ◉". */
export function HandoffPill({ agent, text, with: targets }: { agent?: Agent; text: string; with: Agent[] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {agent && <AgentAvatar agent={agent} size={18} badge={false} live />}
      {/* "Sending to Chief…" wears Chief's color, like Grok Bot's handoffs */}
      <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 h-6 text-xs", targets.length ? "agent-tint agent-ink font-medium" : "text-muted")} style={targets.length ? agentVar(targets[0]) : undefined}>
        {targets.length > 0 && (
          <span className="inline-flex gap-0.5" aria-hidden>
            <span className="size-1 rounded-full bg-current animate-pulse" />
            <span className="size-1 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
            <span className="size-1 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
          </span>
        )}
        {text}
      </span>
      {targets.map((t) => (
        <AgentAvatar key={t.id} agent={t} size={18} badge={false} />
      ))}
    </span>
  );
}

/** What an agent changed for you (a setting, a mod), one line each, with Undo. */
export function ChangeCard({ id, fallback }: { id: string; fallback: string }) {
  const changes = useChanges();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!changes) return null;
  // too old to be in the list: show what changed, without Undo
  const change = changes.find((c) => c.id === id) ?? { id, lines: fallback.split("\n").filter(Boolean), undoneAt: null, old: true };
  const old = "old" in change;
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
  return (
    <div className="mt-1.5 max-w-md rounded-2xl border border-line bg-panel px-3.5 py-3 space-y-1.5">
      {change.lines.map((l) => (
        <div key={l} className={cx("flex items-start gap-2 text-sm", change.undoneAt && "text-muted line-through")}>
          <Check size={15} className="mt-0.5 shrink-0 text-ok" />
          <span>{l}</span>
        </div>
      ))}
      <div className="pt-1 flex items-center gap-2">
        {old ? null : change.undoneAt ? (
          <span className="text-xs text-muted">Undone</span>
        ) : (
          <Button className="h-8 px-3 text-xs" onClick={undo} disabled={busy}>
            <RotateCcw size={13} /> Undo
          </Button>
        )}
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
    </div>
  );
}
