import { Check, Minus, Plus, Trash2 } from "lucide-react";
import { DEFAULT_ROUNDS, MAX_ROUNDS_LIMIT, stepAgentId, stepGraph, stepOrder, stepsAfter, type ChannelTeam, type StepRule, type TeamRole, type TeamStep, type TeamStepKind } from "@wisp/core";
import { useStore } from "../store.ts";
import { useCreateAgent } from "./NewAgent.tsx";
import { AgentAvatar, cx } from "../components/ui.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { AgentField, FieldBox, InputsField, KindIcon, PickBox, TextBox } from "./parts.tsx";
import { freeStepId, handoffCanWait,insertingBefore, numberOf, possibleInputs, retype, roleById, settingInputs, stepById, titleOf, updating, disconnecting } from "./flow.ts";

const KIND_NAME: Record<TeamStepKind, string> = {
  do: "Agent",
  review: "Repeat until approved",
  hand_out: "Split the work",
  ask: "Ask me",
  handoff: "Hand off to a team",
  branch: "If / else",
  custom: "Custom",
};
export const kindName = (k: TeamStepKind) => KIND_NAME[k];

const OPS: { op: StepRule["op"]; label: string }[] = [
  { op: "contains", label: "contains" },
  { op: "not_contains", label: "doesn't contain" },
  { op: "starts_with", label: "starts with" },
  { op: "equals", label: "is" },
];

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 7)}`;

/** A step's header text: "Step 3", or the kind's name for the special ones. */
export function stepHeading(team: ChannelTeam, s: TeamStep): string {
  const n = numberOf(team, s.id);
  return s.kind === "do" || s.kind === "custom" ? `Step ${n}` : `Step ${n} · ${kindName(s.kind)}`;
}

function Rounds({ value, onChange, note }: { value: number; onChange: (n: number) => void; note?: string }) {
  return (
    <FieldBox note={note}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-muted">Most rounds</span>
          <span className="block text-body tabular-nums">
            {value} {value === 1 ? "round" : "rounds"}
          </span>
        </span>
        <button type="button" aria-label="Fewer rounds" disabled={value <= 1} onClick={() => onChange(value - 1)} className="circle circle-sm disabled:opacity-40">
          <Minus size={16} />
        </button>
        <button type="button" aria-label="More rounds" disabled={value >= MAX_ROUNDS_LIMIT} onClick={() => onChange(value + 1)} className="circle circle-sm disabled:opacity-40">
          <Plus size={16} />
        </button>
      </div>
    </FieldBox>
  );
}

/** Edit one step: the fields its kind has. Used in the desktop panel and the phone sheet. */
export function StepForm({ team, stepId, onChange, onDelete, channelId }: { team: ChannelTeam; stepId: string; onChange: (t: ChannelTeam) => void; onDelete: () => void; channelId?: string }) {
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const createAgent = useCreateAgent();
  const step = stepById(team, stepId);
  if (!step) return null;
  const steps = team.steps ?? [];
  const set = (patch: Partial<TeamStep>) => onChange(updating(team, stepId, patch));
  const order = stepOrder(steps);
  const others = order.filter((s) => s.id !== stepId);
  const after = stepsAfter(steps, stepId);
  /** steps before this one, where work can go back to */
  const earlier = others.filter((s) => stepsAfter(steps, s.id).has(stepId));
  const inputOptions = possibleInputs(team, stepId);
  const stepOption = (s: TeamStep) => ({ value: s.id, label: `Step ${numberOf(team, s.id)} · ${titleOf(s)}` });
  const stepText = (id: string | null | undefined, none: string) => {
    const s = stepById(team, id);
    return s ? `Step ${numberOf(team, s.id)} · ${titleOf(s)}` : none;
  };

  const agentValue = stepAgentId(team, step);
  const inputs = (title: string) => <InputsField team={team} stepId={stepId} options={inputOptions} title={title} onSet={(ids) => onChange(settingInputs(team, stepId, ids))} />;

  // when it runs: after the steps it uses, or with another step
  const together = others.filter((s) => !after.has(s.id));
  const ids = (step.inputs ?? []).map((i) => numberOf(team, i)).sort((a, b) => a - b);
  const whenText = ids.length === 0 ? "At the start, with the first steps" : ids.length === 1 ? `After step ${ids[0]} finishes` : `After steps ${ids.slice(0, -1).join(", ")} and ${ids.at(-1)} finish`;
  const addGate = (kind: "ask" | "branch") => {
    const id = freeStepId(team);
    const gate: TeamStep =
      kind === "ask"
        ? { id, roleId: "", kind: "ask", action: "Say go", next: null, notifyPhone: true, x: 0, y: 0 }
        : { id, roleId: "", kind: "branch", action: "Should it run?", next: null, maxRounds: DEFAULT_ROUNDS, agentId: agents[0]?.id ?? null, ifTrue: stepId, x: 0, y: 0 };
    onChange(insertingBefore(team, gate, stepId));
  };
  const when = (
    <PickBox
      label="When it runs"
      shown={whenText}
      onPick={(v) => {
        if (v === "ready") return onChange(settingInputs(team, stepId, [others.filter((s) => !after.has(s.id)).at(-1)?.id].filter((x): x is string => !!x)));
        if (v === "gate:ask") return addGate("ask");
        if (v === "gate:branch") return addGate("branch");
        const o = stepById(team, v.replace("with:", ""));
        if (o) onChange(settingInputs(team, stepId, o.inputs ?? []));
      }}
      options={[
        { value: "ready", label: "When its inputs are ready", disabled: !!step.inputs?.length || !together.length },
        ...together.map((s) => ({ value: `with:${s.id}`, label: `${numberOf(team, s.id)}. ${titleOf(s)}`, group: "At the same time as another step" })),
        { value: "gate:ask", label: "After I say go" },
        { value: "gate:branch", label: "Only if" },
      ]}
    />
  );

  const title = (placeholder: string) => <TextBox label="Title" value={step.action} onChange={(v) => set({ action: v })} placeholder={placeholder} maxLength={200} />;

  const g = stepGraph(steps);
  const loops = step.kind === "branch" && [step.ifTrue, step.ifFalse].some((t) => !!t && (g.back.get(stepId) ?? []).includes(t));

  const setBranch = (yes: boolean, target: string | null) => {
    const old = yes ? step.ifTrue : step.ifFalse;
    const other = yes ? step.ifFalse : step.ifTrue;
    // the arrow to the old step goes only when the other outcome doesn't use it too
    let next = old && old !== other && old !== target ? disconnecting(team, stepId, old) : team;
    next = updating(next, stepId, yes ? { ifTrue: target } : { ifFalse: target });
    onChange(next);
  };
  const setRule = (patch: Partial<StepRule>) => set({ rule: { op: step.rule?.op ?? "contains", value: step.rule?.value ?? "", ...patch } });

  const setRole = (id: string, patch: Partial<TeamRole>) => onChange({ ...team, roles: (team.roles ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const addRole = () => {
    const role: TeamRole = { id: uid("role"), name: "New role", description: "", agentId: agents[0]?.id ?? null };
    onChange(updating({ ...team, roles: [...(team.roles ?? []), role] }, stepId, (s) => ({ ...s, handTo: [...(s.handTo ?? []), role.id] })));
  };

  return (
    <div className="space-y-3">
      {(step.kind === "do" || step.kind === "custom") && (
        <>
          <AgentField value={agentValue} onChange={(agentId) => set({ agentId })} />
          {title("What is this step called?")}
          <TextBox label={step.kind === "custom" ? "What it does (its rules)" : "What it does"} value={step.prompt ?? ""} onChange={(v) => set({ prompt: v })} placeholder="Tell the agent what to do here." rows={5} maxLength={4000} />
          {inputs("Uses the result of")}
          {when}
        </>
      )}

      {step.kind === "review" && (
        <>
          {title("e.g. Check the plan")}
          <AgentField label="Checked by" value={agentValue} onChange={(agentId) => set({ agentId })} />
          <TextBox label="What it does" value={step.prompt ?? ""} onChange={(v) => set({ prompt: v })} placeholder="Read the work. Find what's wrong. Send it back with a short list, or approve it." rows={4} maxLength={4000} />
          <PickBox label="Sends it back to" shown={stepText(step.sendBackTo, "Pick a step")} invalid={!step.sendBackTo} options={earlier.length ? earlier.map(stepOption) : [{ value: "none", label: "Add a step before this one first", disabled: true }]} onPick={(v) => set({ sendBackTo: v })} />
          <Rounds value={step.maxRounds ?? DEFAULT_ROUNDS} onChange={(maxRounds) => set({ maxRounds })} note={`After ${step.maxRounds ?? DEFAULT_ROUNDS} rounds it asks you instead of going round again.`} />
          {inputs("Uses the result of")}
          {when}
        </>
      )}

      {step.kind === "ask" && (
        <>
          {title("e.g. Approve before it ships")}
          <TextBox label="What you see" value={step.show ?? ""} onChange={(v) => set({ show: v })} placeholder="What should you see with the question?" rows={3} maxLength={2000} />
          {inputs("Shows the result of")}
          <PickBox label="If you ask for changes" shown={stepText(step.sendBackTo, "Nowhere: it stops")} options={[{ value: "__none", label: "Nowhere: it stops" }, ...earlier.map(stepOption)]} onPick={(v) => set({ sendBackTo: v === "__none" ? null : v })} />
          <Toggle label="Tell me on my phone" on={step.notifyPhone ?? true} onChange={(notifyPhone) => set({ notifyPhone })} />
        </>
      )}

      {step.kind === "handoff" && (
        <>
          {title("e.g. Tell support")}
          <HandoffTeams value={step.handoffTo ?? null} onPick={(handoffTo) => set({ handoffTo })} except={channelId} channels={channels} />
          <TextBox label="What it does" value={step.prompt ?? ""} onChange={(v) => set({ prompt: v })} placeholder="Tell them what to do with it." rows={3} maxLength={4000} />
          {handoffCanWait(channels.find((c) => c.id === step.handoffTo)) ? (
            <Toggle label="Wait for their answer" on={step.waitForReply ?? true} onChange={(waitForReply) => set({ waitForReply })} note={step.waitForReply ?? true ? "The next step gets what they send back." : undefined} />
          ) : (
            <p className="px-2 text-xs text-muted">That team has no steps, so it can't send an answer back. The next step starts as soon as the work is handed over.</p>
          )}
          {inputs("Hands over the result of")}
          {when}
        </>
      )}

      {step.kind === "branch" && (
        <>
          {title("e.g. Did the tests pass?")}
          {inputs("Look at")}
          <FieldBox label="If">
            <div className="mt-1.5 flex rounded-full bg-chip p-0.5 text-[13px]" role="radiogroup" aria-label="How it decides">
              {[
                { key: "agent", label: "An agent decides", on: !step.rule },
                { key: "rule", label: "A simple rule", on: !!step.rule },
              ].map((o) => (
                <button key={o.key} type="button" role="radio" aria-checked={o.on} onClick={() => set({ rule: o.key === "agent" ? null : (step.rule ?? { op: "contains", value: "" }) })} className={cx("h-8 flex-1 rounded-full", o.on ? "bg-panel font-medium shadow-sm" : "text-muted")}>
                  {o.label}
                </button>
              ))}
            </div>
            {step.rule ? (
              <div className="mt-2 space-y-1.5">
                <label className="flex items-center gap-2 text-[14px] text-muted">
                  The result
                  <select aria-label="How to compare" value={step.rule.op} onChange={(e) => setRule({ op: e.target.value as StepRule["op"] })} className="rounded-lg bg-chip px-2 py-1 text-ink">
                    {OPS.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <input aria-label="The words to look for" value={step.rule.value} onChange={(e) => setRule({ value: e.target.value })} placeholder="the words to look for" className="block w-full bg-transparent text-body outline-none placeholder:text-faint" />
              </div>
            ) : (
              <input aria-label="What it checks" value={step.condition ?? ""} onChange={(e) => set({ condition: e.target.value })} placeholder="e.g. every test passed" maxLength={300} className="mt-2 block w-full bg-transparent text-body outline-none placeholder:text-faint" />
            )}
          </FieldBox>
          {!step.rule && <AgentField label="Decided by" value={agentValue} onChange={(agentId) => set({ agentId })} note="An agent reads the result and answers yes or no." />}
          <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
            {([true, false] as const).map((yes) => (
              <label key={String(yes)} className="relative flex items-center gap-3 px-4 py-2.5">
                <span className="w-9 text-body font-medium">{yes ? "Yes" : "No"}</span>
                <span className="min-w-0 flex-1 truncate text-body">{stepText(yes ? step.ifTrue : step.ifFalse, "The end")}</span>
                <select aria-label={yes ? "If yes, go to" : "If no, go to"} value={(yes ? step.ifTrue : step.ifFalse) ?? "__end"} onChange={(e) => setBranch(yes, e.target.value === "__end" ? null : e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
                  <option value="__end">The end</option>
                  {others.map((s) => (
                    <option key={s.id} value={s.id}>
                      Step {numberOf(team, s.id)} · {titleOf(s)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {loops && <Rounds value={step.maxRounds ?? DEFAULT_ROUNDS} onChange={(maxRounds) => set({ maxRounds })} note="Going back to an earlier step is a loop. After this many rounds it asks you." />}
        </>
      )}

      {step.kind === "hand_out" && (
        <>
          <AgentField label="Who hands it out" value={agentValue} onChange={(agentId) => set({ agentId })} />
          {title("e.g. Hand out the pieces")}
          <TextBox label="What it does" value={step.prompt ?? ""} onChange={(v) => set({ prompt: v })} placeholder="Split the work into pieces and say who gets each one." rows={4} maxLength={4000} />
          <div className="space-y-1.5">
            <span className="block px-2 text-xs text-muted">Pieces go to</span>
            <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
              {(team.roles ?? []).map((r) => {
                const on = (step.handTo ?? []).includes(r.id);
                const a = agents.find((x) => x.id === r.agentId);
                return (
                  <div key={r.id} className="space-y-1.5 px-3.5 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <button type="button" role="checkbox" aria-checked={on} aria-label={`${r.name}, ${on ? "on" : "off"}`} onClick={() => set({ handTo: on ? (step.handTo ?? []).filter((x) => x !== r.id) : [...(step.handTo ?? []), r.id] })} className={cx("grid size-[22px] shrink-0 place-items-center rounded-full", on ? "bg-info text-white" : "border border-input")}>
                        {on && <Check size={13} strokeWidth={3} />}
                      </button>
                      <input aria-label="Role name" value={r.name} onChange={(e) => setRole(r.id, { name: e.target.value })} maxLength={60} className="min-w-0 flex-1 bg-transparent text-body outline-none" />
                      <label className="relative inline-flex items-center gap-1.5 text-[13px] text-muted">
                        {a ? <AgentAvatar agent={a} size={22} interactive={false} /> : null}
                        <span className={cx(!a && "text-bad")}>{a?.name ?? "Pick an agent"}</span>
                        <select aria-label={`Who's the ${r.name}`} value={r.agentId ?? ""} onChange={(e) => (e.target.value === "__new" ? createAgent?.((id) => setRole(r.id, { agentId: id })) : setRole(r.id, { agentId: e.target.value || null }))} className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
                          <option value="">Pick an agent</option>
                          {createAgent && <option value="__new">+ Create an agent…</option>}
                          {agents.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <textarea aria-label={`What the ${r.name} does`} value={r.description} onChange={(e) => setRole(r.id, { description: e.target.value })} rows={2} maxLength={4000} placeholder="What this role does" className="ml-[34px] block w-[calc(100%-34px)] resize-none bg-transparent text-[13px] text-muted outline-none placeholder:text-faint" />
                  </div>
                );
              })}
              <button type="button" onClick={addRole} className="flex w-full items-center gap-2 px-3.5 py-3 text-left text-body hover:bg-hover">
                <Plus size={16} aria-hidden /> Add a role
              </button>
            </div>
            <p className="px-2 text-xs text-faint">Each role is one kind of worker. Pick who fills it.</p>
          </div>
          <PickBox label="Each piece is checked by" shown={roleById(team, step.reviewBy)?.name ?? "Nobody"} options={[{ value: "__none", label: "Nobody" }, ...(team.roles ?? []).map((r) => ({ value: r.id, label: r.name }))]} onPick={(v) => set({ reviewBy: v === "__none" ? null : v })} />
          <Rounds value={step.maxRounds ?? DEFAULT_ROUNDS} onChange={(maxRounds) => set({ maxRounds })} note="How many times a piece can go back before it asks you." />
          {inputs("Uses the result of")}
        </>
      )}

      <MoreOptions about="kind of step, delete" className="pt-1">
        <div className="space-y-3">
          <PickBox
            label="Kind of step"
            lead={<KindIcon kind={step.kind} size={18} />}
            shown={kindName(step.kind)}
            options={(Object.keys(KIND_NAME) as TeamStepKind[]).map((k) => ({ value: k, label: KIND_NAME[k] }))}
            onPick={(k) => onChange(retype(team, stepId, k as TeamStepKind, agents))}
          />
          <button type="button" onClick={onDelete} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-line bg-card text-body text-bad hover:bg-hover">
            <Trash2 size={16} aria-hidden /> Delete step
          </button>
          <p className="px-2 text-xs text-faint">What led to it will lead to what came after it.</p>
        </div>
      </MoreOptions>
    </div>
  );
}

export function Toggle({ label, on, onChange, note }: { label: string; on: boolean; onChange: (on: boolean) => void; note?: string }) {
  return (
    <FieldBox note={note}>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className="flex w-full items-center justify-between gap-3 py-1 text-left text-body">
        {label}
        <span className={cx("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", on ? "bg-ok" : "bg-input")}>
          <span className={cx("m-knob absolute top-[3px] left-[3px] size-5 rounded-full bg-white shadow", on && "translate-x-[18px]")} />
        </span>
      </button>
    </FieldBox>
  );
}

function HandoffTeams({ value, onPick, except, channels }: { value: string | null; onPick: (id: string) => void; except?: string; channels: ReturnType<typeof useStore.getState>["channels"] }) {
  const teams = channels.filter((c) => c.kind === "channel" && !c.archivedAt && c.id !== except);
  return (
    <div className="space-y-1.5">
      <span className="block px-2 text-xs text-muted">Hand off to</span>
      <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
        {teams.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={value === t.id} onClick={() => onPick(t.id)} className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-body hover:bg-hover">
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {value === t.id && <Check size={16} className="text-info" aria-hidden />}
          </button>
        ))}
        {!teams.length && <p className="px-4 py-3 text-sm text-muted">There are no other teams yet.</p>}
      </div>
    </div>
  );
}

