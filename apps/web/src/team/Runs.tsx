import { useEffect, useState } from "react";
import { Check, Hand } from "lucide-react";
import { workSteps, type FlowLane, type TeamFlow, type TeamStep } from "@wisp/core";
import { TeamEditSession } from "./Session.tsx";
import { api } from "../api.ts";
import { href } from "../router.ts";
import { useStore } from "../store.ts";
import { Button, cx } from "../components/ui.tsx";
import { lanesOf } from "./flow.ts";

type Decision = "approve" | "retry" | "stop" | "changes" | "allow";

/**
 * Where a request in a stepped team is, at the top of its thread: a pill for each step (done, on
 * now, waiting, skipped, still to come) and, for every step waiting on a person, what they can do.
 * Steps that run together each have their own lane, so each shows its own buttons.
 */
export function FlowStrip({ channelId, threadId }: { channelId: string; threadId: string }) {
  const version = useStore((s) => s.flowsVersion);
  const team = useStore((s) => s.channels.find((c) => c.id === channelId)?.settings.team ?? null);
  const approvals = useStore((s) => s.approvals);
  const [flow, setFlow] = useState<TeamFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    api<TeamFlow[]>("GET", `/api/channels/${channelId}/flows`)
      .then((all) => live && setFlow(all.find((f) => f.threadId === threadId) ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [channelId, threadId, version]);
  if (!flow || !team?.steps?.length) return null;
  const order = workSteps(team.steps);
  const lanes = lanesOf(flow);
  const number = (id: string) => order.findIndex((s) => s.id === id) + 1;

  const decide = async (action: Decision, stepId?: string, text?: string) => {
    setBusy(true);
    setError(null);
    try {
      setFlow(await api<TeamFlow>("POST", `/api/flows/${flow.id}/decide`, { action, ...(stepId ? { stepId } : {}), ...(text?.trim() ? { note: text.trim() } : {}) }));
      setAsking(null);
      setNote("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pill = (s: TeamStep) => {
    const lane = lanes[s.id];
    const done = lane?.status === "done" || flow.status === "done";
    const now = lane?.status === "running" || lane?.status === "waiting";
    const waiting = lane?.status === "waiting";
    const skipped = lane?.status === "skipped";
    const rounds = flow.rounds[s.id] ?? 0;
    const status = waiting ? "waiting on you" : now ? "on now" : skipped ? "skipped" : done ? "done" : "to come";
    return (
      <span
        key={s.id}
        title={`${s.action || `Step ${number(s.id)}`}, ${status}`}
        className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium", now ? (waiting ? "bg-st-needs/16 text-st-needs" : "bg-st-working/16 text-st-working") : done && !skipped ? "bg-st-online/16 text-st-online" : "bg-chip text-muted", skipped && "line-through opacity-60")}
      >
        {s.action || `Step ${number(s.id)}`}
        {done && !now && !skipped && <Check size={11} strokeWidth={3} aria-label="done" />}
        {rounds > 1 && ` · round ${rounds}`}
      </span>
    );
  };

  const waiting = order.filter((s) => lanes[s.id]?.status === "waiting" && lanes[s.id]?.waitingFor);
  return (
    <div className="space-y-2.5 border-b border-line px-4 py-2.5" aria-label="Team steps">
      <div className="flex flex-wrap items-center gap-1.5">
        {order.map(pill)}
        {flow.status === "failed" && <span className="ml-1 text-[11px] font-medium text-bad">Stopped</span>}
        {/* a running request can be stopped too: the hub cancels the work still open */}
        {flow.status === "running" && (
          <button type="button" disabled={busy} onClick={() => void decide("stop")} className="ml-auto text-[12px] text-faint hover:text-ink">
            Stop
          </button>
        )}
      </div>
      {waiting.map((s) => (
        <WaitingStep key={s.id} flow={flow} step={s} lane={lanes[s.id]!} approvalId={lanes[s.id]!.approvalId ?? Object.values(approvals).find((x) => x.flow?.flowId === flow.id && x.flow?.stepId === s.id && x.status === "pending")?.id} busy={busy} decide={decide} />
      ))}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

/** One step waiting on a person: why, and plain buttons for what they can do. Used in the thread and in the Inbox. */
export function WaitingStep({ flow, step: s, lane, approvalId: inbox, busy, decide, inInbox = false }: { flow: TeamFlow; step: TeamStep; lane: FlowLane; approvalId?: string; busy: boolean; decide: (action: Decision, stepId?: string, text?: string) => Promise<void> | void; inInbox?: boolean }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(false);
  const channel = useStore((st) => st.channels.find((c) => c.id === flow.channelId));
  const w = lane.waitingFor!;
  const ask = w.options === "ask";
  return (
    <div className="space-y-1.5 rounded-2xl bg-warn/10 px-3 py-2.5" aria-label={`${s.action || "A step"}, waiting`}>
      <div className="text-[12px] font-medium">
        {s.action || "A step"}
        {w.failed && <span className="ml-1.5 text-bad">Failed</span>}
      </div>
      {ask ? (
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-warn">
          <Hand size={14} aria-hidden /> Waiting for you
        </div>
      ) : null}
      <div className={cx("text-xs", ask ? "text-muted" : "text-warn")}>{w.why}</div>
      {asking === s.id ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("changes", s.id, note);
            setAsking(null);
            setNote("");
          }}
        >
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" aria-label="What should change" maxLength={4000} className="h-8 min-w-48 flex-1 rounded-full border border-input bg-transparent px-3 text-xs outline-none focus:border-ring" />
          <Button type="submit" variant="primary" disabled={busy} className="h-8 text-xs">
            Send back
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAsking(null)} className="h-8 text-xs">
            Cancel
          </Button>
        </form>
      ) : w.selfReview ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="primary" disabled={busy || !channel} onClick={() => setPicking(true)} className="h-8 text-xs">
            Pick an agent
          </Button>
          <Button type="button" disabled={busy} onClick={() => void decide("allow", s.id)} className="h-8 text-xs">
            Let {w.selfReview.agent} review its own work
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide("stop", s.id)} className="h-8 text-xs">
            Stop
          </Button>
          {picking && channel && <TeamEditSession channel={channel} onClose={() => setPicking(false)} />}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {!w.failed && !ask && (
            <Button type="button" variant="primary" disabled={busy} onClick={() => void decide("approve", s.id)} className="h-8 text-xs">
              Approve anyway
            </Button>
          )}
          {ask ? (
            <>
              <Button type="button" variant="primary" disabled={busy} onClick={() => void decide("approve", s.id)} className="h-8 text-xs">
                Approve
              </Button>
              {s.sendBackTo && (
                <Button type="button" disabled={busy} onClick={() => setAsking(s.id)} className="h-8 text-xs">
                  Ask for changes
                </Button>
              )}
              {!inInbox && (
                <a href={href({ view: "dashboard" })} className="text-xs font-medium text-accent-text hover:underline">
                  {inbox ? "Open it in your Inbox" : "Answer it in your Inbox"}
                </a>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant={w.failed ? "primary" : undefined} disabled={busy} onClick={() => void decide("retry", s.id)} className="h-8 text-xs">
                {w.options === "rounds" ? "Another round" : "Try again"}
              </Button>
              {w.failed && (
                <Button type="button" disabled={busy} onClick={() => void decide("approve", s.id)} className="h-8 text-xs">
                  Skip this step
                </Button>
              )}
            </>
          )}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide("stop", s.id)} className="h-8 text-xs">
            Stop
          </Button>
        </div>
      )}
    </div>
  );
}

/** Steps of a team's newest request that wait on a person (ask-me steps have their own approval card). */
export function waitingOnYou(flows: TeamFlow[]): { flow: TeamFlow; lane: FlowLane }[] {
  const f = flows[0];
  if (!f || (f.status !== "waiting" && f.status !== "running")) return [];
  return Object.values(f.lanes ?? {})
    .filter((l) => l.status === "waiting" && l.waitingFor && l.waitingFor.options !== "ask")
    .map((lane) => ({ flow: f, lane }));
}

/** A stalled team in the Inbox's Needs you: the reason and the buttons, right there. */
export function TeamNeedCard({ flow, lane }: { flow: TeamFlow; lane: FlowLane }) {
  const team = useStore((s) => s.channels.find((c) => c.id === flow.channelId));
  const steps = team?.settings.team?.steps ?? [];
  const step = steps.find((s) => s.id === lane.stepId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (action: Decision, stepId?: string) => {
    setBusy(true);
    setError(null);
    try {
      await api<TeamFlow>("POST", `/api/flows/${flow.id}/decide`, { action, ...(stepId ? { stepId } : {}) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!step) return null;
  return (
    <div className="rounded-3xl bg-card border border-line p-4 md:px-5 md:py-[18px] flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium leading-snug">{team?.name ?? "A team"} needs you</div>
          <a href={href({ view: "chat", channelId: flow.channelId, threadId: flow.threadId })} className="text-[13px] text-faint hover:underline truncate block">
            {flow.request.slice(0, 80)}
          </a>
        </div>
        <span role="img" aria-label="Needs you" className="shrink-0 size-2.5 rounded-full bg-st-needs" />
      </div>
      <WaitingStep flow={flow} step={step} lane={lane} busy={busy} decide={decide} inInbox />
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
