import { useState } from "react";
import { ArrowDown, ArrowUp, Flag, Plus } from "lucide-react";
import { stepOrder, type ChannelTeam, type TeamStep } from "@wisp/core";
import { useStore } from "../store.ts";
import { AgentAvatar, Button, Modal, cx } from "../components/ui.tsx";
import { ADD_KINDS, movingAfter, numberOf, rowInputs, stepRows, titleOf, type AddAt, type AddKind, KIND_MARK } from "./flow.ts";
import { kindsFor } from "./Canvas.tsx";
import { KindIcon, MessageChip, StepNum, agentOfStep, useHandoffName } from "./parts.tsx";

/** The lines between two rows of steps, with a + to put a step there (and "At the same time" where they split). */
function Connector({ from, to, plus, onAdd }: { from: number; to: number; plus: boolean; onAdd: () => void }) {
  const tall = from > 1 || to > 1;
  const h = tall ? 64 : 44;
  const xs = (n: number) => Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 100);
  const a = xs(Math.max(from, 1));
  const b = xs(Math.max(to, 1));
  return (
    <div className="relative mx-auto w-full" style={{ height: h }}>
      <svg className="absolute inset-0 h-full w-full overflow-visible text-faint" viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" aria-hidden>
        {a.flatMap((x1) => b.map((x2) => <path key={`${x1}-${x2}`} d={x1 === x2 ? `M ${x1} 0 L ${x2} ${h}` : `M ${x1} 0 C ${x1} ${h / 2}, ${x2} ${h / 2}, ${x2} ${h}`} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />))}
      </svg>
      {to > 1 && <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-line bg-panel px-2.5 py-0.5 text-[12px] text-muted">At the same time</span>}
      {plus && (
        <button type="button" onClick={onAdd} aria-label="Add a step here" className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-control-line bg-control shadow-panel">
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}

function StepCard({ team, step, wide, problem, onOpen }: { team: ChannelTeam; step: TeamStep; wide: boolean; problem?: string; onOpen: () => void }) {
  const agents = useStore((s) => s.agents);
  const agent = agentOfStep(team, agents, step);
  const mark = KIND_MARK[step.kind];
  const handoff = useHandoffName(step.handoffTo);
  const uses = (step.inputs ?? []).length > 1 ? `Uses ${(step.inputs ?? []).map((i) => numberOf(team, i)).sort((a, b) => a - b).join(" and ")}` : null;
  return (
    <button type="button" onClick={onOpen} aria-label={`Step ${numberOf(team, step.id)}, ${titleOf(step)}`} className={cx("min-w-0 rounded-[22px] border p-3.5 text-left", wide ? "w-full" : "flex-1", problem ? "border-bad/40 bg-bad/10" : "border-line bg-card")}>
      <div className="flex items-start gap-2.5">
        <StepNum n={numberOf(team, step.id)} />
        <div className="min-w-0 flex-1">
          {mark && (
            <div className="mb-0.5 flex items-center gap-1 text-[12px] font-medium text-muted">
              <KindIcon kind={step.kind} size={13} />
              <span className="truncate">{mark}</span>
            </div>
          )}
          <div className="line-clamp-2 text-[16px] font-semibold leading-tight">{titleOf(step)}</div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {step.kind === "ask" ? (
          <span className="text-[14px] text-muted">You</span>
        ) : step.kind === "handoff" ? (
          <span className="text-[14px] text-muted">{handoff}</span>
        ) : agent ? (
          <>
            <AgentAvatar agent={agent} size={22} interactive={false} />
            <span className="min-w-0 truncate text-[14px] text-muted">{agent.name}</span>
          </>
        ) : (
          <>
            <span className="size-[22px] shrink-0 rounded-full border border-dashed border-bad/60" />
            <span className="text-[14px] text-bad">Pick an agent</span>
          </>
        )}
        {uses && <span className="ml-auto inline-flex h-[22px] items-center rounded-full border border-line bg-panel px-2 text-[11px] text-muted">{uses}</span>}
      </div>
    </button>
  );
}

/** The flow at phone width: top to bottom, steps that run together side by side. */
export function PhoneFlow({ team, problems, banner, onOpen, onAdd }: { team: ChannelTeam; problems: Map<string, string>; banner: React.ReactNode; onOpen: (id: string) => void; onAdd: (at: AddAt) => void }) {
  const rows = stepRows(team.steps ?? []);
  const last = rows.at(-1) ?? [];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 pb-10 pt-2">
      {banner}
      <MessageChip />
      {rows.map((row, i) => {
        const before = i === 0 ? 0 : rows[i - 1].length;
        return (
          <div key={i} className="flex w-full flex-col items-center">
            <Connector from={before} to={row.length} plus={row.length === 1} onAdd={() => onAdd({ between: { from: rowInputs(row), to: row.map((s) => s.id) } })} />
            <div className="flex w-full items-start gap-2.5">
              {row.map((s) => (
                <StepCard key={s.id} team={team} step={s} wide={row.length === 1} problem={problems.get(s.id)} onOpen={() => onOpen(s.id)} />
              ))}
            </div>
          </div>
        );
      })}
      <Connector from={last.length} to={0} plus onAdd={() => onAdd({ between: { from: last.map((s) => s.id), to: [] } })} />
      <span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-card px-3.5 text-[14px] text-muted">
        <Flag size={14} aria-hidden /> Done
      </span>
      <Button type="button" variant="primary" onClick={() => onAdd({ after: stepOrder(team.steps ?? []).at(-1)?.id ?? null })} className="mt-7 h-12 w-56 text-[16px]">
        <Plus size={16} /> Add a step
      </Button>
    </div>
  );
}

/** Pick the kind of step to add; "After" says where when it isn't between two steps. */
export function AddStepSheet({ team, at, onPick, onClose }: { team: ChannelTeam; at: AddAt; onPick: (kind: AddKind, anchor: string | null) => void; onClose: () => void }) {
  const order = stepOrder(team.steps ?? []);
  const [anchor, setAnchor] = useState<string | null>(at.after ?? order.at(-1)?.id ?? null);
  const kinds = kindsFor(order.length === 0, at);
  return (
    <Modal title="Add a step" onClose={onClose}>
      <div className="space-y-3">
        {!at.between && order.length > 0 && (
          <label className="flex items-center gap-3 text-[15px] text-muted">
            After
            <select aria-label="After" value={anchor ?? ""} onChange={(e) => setAnchor(e.target.value)} className="h-10 min-w-0 flex-1 rounded-full border border-control-line bg-control px-3 text-ink">
              {order.map((s) => (
                <option key={s.id} value={s.id}>
                  {numberOf(team, s.id)}. {titleOf(s)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="overflow-hidden rounded-3xl border border-line bg-card divide-y divide-line">
          {ADD_KINDS.filter((k) => kinds.includes(k.kind)).map((k) => (
            <button key={k.kind} type="button" onClick={() => onPick(k.kind, at.between ? null : anchor)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-chip text-ink/85">
                <KindIcon kind={k.kind === "agent" ? "do" : k.kind === "handOut" ? "hand_out" : k.kind === "beside" ? "beside" : k.kind} size={17} />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium">{k.title}</span>
                <span className="block text-[13px] text-muted">{k.kind === "beside" ? "Runs at the same time as the step above." : k.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Change the order steps happen in: a step moves up or down one place. */
export function ReorderSheet({ team, onChange, onClose }: { team: ChannelTeam; onChange: (t: ChannelTeam) => void; onClose: () => void }) {
  const order = stepOrder(team.steps ?? []);
  return (
    <Modal title="Reorder steps" onClose={onClose}>
      <ol className="overflow-hidden rounded-3xl border border-line bg-card divide-y divide-line">
        {order.map((s, i) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <StepNum n={i + 1} />
            <span className="min-w-0 flex-1 truncate text-[15px]">{titleOf(s)}</span>
            <button type="button" disabled={i === 0} aria-label={`Move ${titleOf(s)} up`} onClick={() => onChange(movingAfter(team, s.id, i >= 2 ? order[i - 2].id : null))} className="circle circle-sm disabled:opacity-30">
              <ArrowUp size={16} />
            </button>
            <button type="button" disabled={i === order.length - 1} aria-label={`Move ${titleOf(s)} down`} onClick={() => onChange(movingAfter(team, s.id, order[i + 1].id))} className="circle circle-sm disabled:opacity-30">
              <ArrowDown size={16} />
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex justify-end">
        <Button type="button" variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
