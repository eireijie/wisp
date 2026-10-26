import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Users, GitBranch, LayoutGrid, MessageSquare, Repeat2, SlidersHorizontal, UserCheck, Bot, Share2 } from "lucide-react";
import { stepAgentId, type Agent, type ChannelTeam, type TeamStep, type TeamStepKind } from "@wisp/core";
import { defaultAppearance } from "@wisp/core/src/appearance.ts";
import { Ghost } from "../components/Ghost.tsx";
import { useStore } from "../store.ts";
import { AgentAvatar, cx } from "../components/ui.tsx";
import { numberOf, titleOf } from "./flow.ts";
import { useCreateAgent } from "./NewAgent.tsx";

/** A step's number: its place in the order things happen in. */
export function StepNum({ n, size = 22 }: { n: number; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full bg-chip font-medium text-ink/85 tabular-nums" style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }} aria-hidden>
      {n}
    </span>
  );
}

export function KindIcon({ kind, size = 16 }: { kind: TeamStepKind | "beside" | "agent"; size?: number }) {
  const p = { size, strokeWidth: 1.8, "aria-hidden": true } as const;
  switch (kind) {
    case "review":
      return <Repeat2 {...p} />;
    case "ask":
      return <UserCheck {...p} />;
    case "handoff":
      return <Share2 {...p} />;
    case "branch":
      return <GitBranch {...p} />;
    case "hand_out":
      return <LayoutGrid {...p} />;
    case "custom":
      return <SlidersHorizontal {...p} />;
    case "beside":
      return <GitBranch {...p} className="rotate-90" />;
    default:
      return <Bot {...p} />;
  }
}

export function MessageChip({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-card px-3.5 text-[13px] text-muted", className)}>
      <MessageSquare size={14} aria-hidden /> A message comes in
    </span>
  );
}

/** A labelled box, like a field in the mockups. */
export function FieldBox({ label, note, children, className }: { label?: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="space-y-1.5">
      <div className={cx("rounded-xl border border-line bg-card px-4 py-2.5", className)}>
        {label && <span className="block text-xs text-muted">{label}</span>}
        {children}
      </div>
      {note && <p className="px-2 text-xs text-faint">{note}</p>}
    </div>
  );
}

export function TextBox({ label, value, onChange, placeholder, rows, maxLength, id }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; maxLength?: number; id?: string }) {
  return (
    <FieldBox label={label}>
      {rows ? (
        <textarea id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} maxLength={maxLength} className="mt-0.5 block w-full resize-none bg-transparent text-[15px] leading-snug outline-none placeholder:text-faint" />
      ) : (
        <input id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} className="mt-0.5 block w-full bg-transparent text-[15px] outline-none placeholder:text-faint" />
      )}
    </FieldBox>
  );
}

/** A value you pick from a list: the box shows it, a native select (so keyboards and screen readers work) sits over it. */
export function PickBox({
  label,
  shown,
  options,
  onPick,
  lead,
  invalid,
  disabledNote,
}: {
  label: string;
  shown: ReactNode;
  options: { value: string; label: string; disabled?: boolean; group?: string }[];
  onPick: (value: string) => void;
  lead?: ReactNode;
  invalid?: boolean;
  disabledNote?: string;
}) {
  const groups = useMemo(() => [...new Set(options.map((o) => o.group ?? ""))], [options]);
  return (
    <div className={cx("relative flex items-center gap-3 rounded-xl border bg-card px-4 py-2.5", invalid ? "border-bad/50" : "border-line")}>
      {lead}
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{label}</span>
        <span className={cx("block truncate text-[15px]", invalid && "text-bad")}>{shown}</span>
      </span>
      <ChevronDown size={15} className="shrink-0 text-faint" aria-hidden />
      <select aria-label={label} value="" onChange={(e) => e.target.value && onPick(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
        <option value="" disabled>
          {disabledNote ?? label}
        </option>
        {groups.map((g) =>
          g ? (
            <optgroup key={g} label={g}>
              {options.filter((o) => o.group === g).map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            options.filter((o) => !o.group).map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          ),
        )}
      </select>
    </div>
  );
}

/** Who does a step: the agent, or a prompt to pick one (with the agents to pick from right there). */
export function AgentField({ value, onChange, label = "Who does it", note }: { value: string | null; onChange: (id: string) => void; label?: string; note?: string }) {
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === value);
  const create = useCreateAgent();
  return (
    <div className="space-y-2">
      <PickBox
        label={label}
        invalid={!agent}
        lead={agent ? <AgentAvatar agent={agent} size={32} interactive={false} /> : <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-bad/60 text-bad">?</span>}
        shown={agent ? agent.name : "Pick an agent"}
        options={[...agents.map((a) => ({ value: a.id, label: a.name })), ...(create ? [{ value: "__new", label: "+ Create an agent…" }] : agents.length ? [] : [{ value: "none", label: "Add an agent first", disabled: true }])]}
        onPick={(v) => (v === "__new" ? create?.(onChange) : onChange(v))}
      />
      {!agent && agents.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Agents">
          {agents.slice(0, 6).map((a) => (
            <button key={a.id} type="button" onClick={() => onChange(a.id)} className="inline-flex h-[34px] items-center gap-1.5 rounded-full border border-line bg-card pl-1.5 pr-3 text-[13px] hover:bg-hover">
              <AgentAvatar agent={a} size={22} interactive={false} />
              {a.name}
            </button>
          ))}
        </div>
      )}
      {note && <p className="px-2 text-xs text-faint">{note}</p>}
    </div>
  );
}

/** Which steps' results a step uses (and waits for). */
export function InputsField({ team, stepId, options, title, onSet }: { team: ChannelTeam; stepId: string; options: TeamStep[]; title: string; onSet: (ids: string[]) => void }) {
  const step = team.steps?.find((s) => s.id === stepId);
  const current = step?.inputs ?? [];
  if (!options.length) return null;
  return (
    <div className="space-y-1.5">
      <span className="block px-2 text-xs text-muted">{title}</span>
      <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
        {options.map((s) => {
          const on = current.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Step ${numberOf(team, s.id)}, ${titleOf(s)}`}
              onClick={() => onSet(on ? current.filter((x) => x !== s.id) : [...current, s.id])}
              className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover"
            >
              <span className={cx("grid size-[22px] shrink-0 place-items-center rounded-full", on ? "bg-info text-white" : "border border-input")}>{on && <Check size={13} strokeWidth={3} />}</span>
              <StepNum n={numberOf(team, s.id)} size={20} />
              <span className="min-w-0 flex-1 truncate text-[14px]">{titleOf(s)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function agentOfStep(team: ChannelTeam, agents: Agent[], s: TeamStep): Agent | undefined {
  const id = stepAgentId(team, s);
  return id ? agents.find((a) => a.id === id) : undefined;
}

/** True below the width where the app turns into phone pages (the builder becomes a vertical flow). */
export function useIsPhone(): boolean {
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

/** A ghost nobody has picked a look for: the same seed always gives the same one. */
export function SeedGhost({ seed, size }: { seed: string; size: number }) {
  const look = useMemo(() => defaultAppearance(seed), [seed]);
  return <Ghost look={look} size={size} animate={false} label={seed} />;
}

/** The ghosts of a team's agents, two overlapped; a ghost of the team's own when nobody is on it yet. */
export function TeamGhosts({ agentIds, seed, size }: { agentIds: string[]; seed: string; size: number }) {
  const agents = useStore((s) => s.agents);
  const members = agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  if (!members.length) return seed ? <SeedGhost seed={seed} size={size} /> : <Users size={size * 0.5} className="text-muted" aria-hidden />;
  const small = Math.round(size * 0.72);
  return (
    <span className="relative inline-block shrink-0" style={{ width: members[1] ? size * 1.1 : size, height: size }} aria-hidden>
      <span className="absolute left-0 top-0">
        <AgentAvatar agent={members[0]} size={members[1] ? small : size} interactive={false} />
      </span>
      {members[1] && (
        <span className="absolute bottom-0 right-0 rounded-full" style={{ filter: "drop-shadow(1.5px 0 0 var(--panel)) drop-shadow(-1.5px 0 0 var(--panel)) drop-shadow(0 1.5px 0 var(--panel)) drop-shadow(0 -1.5px 0 var(--panel))" }}>
          <AgentAvatar agent={members[1]} size={small} interactive={false} />
        </span>
      )}
    </span>
  );
}

/** The name of the team a hand-off step gives work to: "demo-crew", or "Another team" until one is picked. */
export function useHandoffName(id: string | null | undefined): string {
  const name = useStore((s) => (id ? s.channels.find((c) => c.id === id)?.name : undefined));
  return name ?? "Another team";
}
