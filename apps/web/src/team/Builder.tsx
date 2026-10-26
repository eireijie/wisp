import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronDown, ChevronLeft, Loader2, MoreHorizontal, Plus, Workflow, X } from "lucide-react";
import { stepOrder, type ChannelTeam, type TeamTemplate } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Button, Menu, Modal, cx } from "../components/ui.tsx";
import { StepCanvas, kindsFor } from "./Canvas.tsx";
import { HowPage } from "./How.tsx";
import { AddStepSheet, PhoneFlow, ReorderSheet } from "./Phone.tsx";
import { StepForm, stepHeading } from "./StepForm.tsx";
import { TemplateBrowser } from "./Templates.tsx";
import { KindIcon, TeamGhosts, useIsPhone } from "./parts.tsx";
import { CreateAgentContext, NewAgentForTeam } from "./NewAgent.tsx";
import { addStep, fillTemplate, relayout, removingStep, stepById, stepProblems, teamAgentIds, updating, withChart, type AddAt, type AddKind } from "./flow.ts";

type Tab = "canvas" | "how";

export interface BuilderProps {
  team: ChannelTeam;
  onChange: (team: ChannelTeam) => void;
  name: string;
  /** the team's channel once it exists (to save it as a template, and to leave it out of the hand-off list) */
  channelId?: string;
  saving?: boolean;
  /** what the hub said when saving didn't work */
  error?: string | null;
  doneLabel?: string;
  onBack: () => void;
  onDone: () => void;
}

/** The steps as a shape (who leads to whom), so the chart is laid out again only when that changes. */
const shape = (t: ChannelTeam) => JSON.stringify((t.steps ?? []).map((s) => [s.id, s.inputs, s.nexts, s.ifTrue, s.ifFalse]));

const TOOLBAR: { kind: AddKind; label: string }[] = [
  { kind: "agent", label: "Agent" },
  { kind: "beside", label: "Side by side" },
  { kind: "review", label: "Repeat" },
  { kind: "ask", label: "Ask me" },
  { kind: "handoff", label: "Hand off" },
  { kind: "branch", label: "If / else" },
  { kind: "custom", label: "Custom" },
  { kind: "handOut", label: "Split" },
];
const iconKind = (k: AddKind) => (k === "agent" ? "do" : k === "handOut" ? "hand_out" : k);

/**
 * The flowchart builder. On a desktop: a pan and zoom canvas with a box for every step, arrows
 * with a + on them, a toolbar of step types, and a panel to edit the picked step. At phone width:
 * a vertical flow with steps that run together side by side, and sheets to edit them.
 */
export function TeamBuilder({ team, onChange, name, channelId, saving = false, error = null, doneLabel = "Save", onBack, onDone }: BuilderProps) {
  const phone = useIsPhone();
  const agents = useStore((s) => s.agents);
  const [tab, setTab] = useState<Tab>("canvas");
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddAt | null>(null);
  const [reordering, setReordering] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [naming, setNaming] = useState(false);
  const [newAgent, setNewAgent] = useState<((id: string) => void) | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const manual = useRef(new Set<string>());

  const steps = team.steps ?? [];
  const problems = useMemo(() => stepProblems(team), [team]);
  const ready = steps.length > 0 && problems.lines.length === 0;

  // steps that were never laid out (an agent drew them, or an older chart) get a place on the chart
  useEffect(() => {
    if (steps.length > 1 && steps.every((s) => s.x === steps[0].x && s.y === steps[0].y)) {
      onChange(relayout(team));
      setFitKey((k) => k + 1);
    }
    // once, when the builder opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Every change comes through here: the chart is laid out again when the arrows changed, and kept in step with the plain chart. */
  const commit = (next: ChannelTeam) => {
    const laid = shape(next) !== shape(team) ? relayout(next, manual.current) : next;
    onChange(withChart(laid));
  };

  const open = (id: string | null) => (phone ? setEditing(id) : setSel(id));

  const add = (kind: AddKind, at: AddAt) => {
    const made = addStep(team, kind, at, agents);
    commit(made.team);
    setAdding(null);
    // straight to the new step, to say what it does
    setTimeout(() => open(made.id), phone ? 150 : 0);
  };

  const remove = (id: string) => {
    commit(removingStep(team, id));
    setSel(null);
    setEditing(null);
  };

  const useTemplate = (t: TeamTemplate) => {
    manual.current.clear();
    onChange(fillTemplate(t, agents, team));
    setTemplates(false);
    setSel(null);
    setFitKey((k) => k + 1);
  };

  const tidy = () => {
    manual.current.clear();
    onChange(relayout(team));
    setFitKey((k) => k + 1);
  };

  const last = stepOrder(steps).at(-1)?.id ?? null;
  const anchor = sel && stepById(team, sel) ? sel : last;
  const banner = (problems.lines.length > 0 || error) && steps.length > 0 && (
    <div role="alert" aria-label="Problems" className="w-full rounded-[20px] bg-bad/15 p-4 text-left">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-bad">
        <AlertCircle size={17} aria-hidden />
        {error ? "Couldn't save" : `${problems.lines.length} ${problems.lines.length === 1 ? "thing" : "things"} to fix`}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[14px]">
        {(error ? [error] : problems.lines).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );

  const menu = (
    <Menu
      align="right"
      trigger={(isOpen, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={isOpen} aria-haspopup="menu" aria-label="More" className="circle circle-sm">
          <MoreHorizontal size={18} />
        </button>
      )}
      items={[
        { label: "Start from a template", onSelect: () => setTemplates(true) },
        ...(phone ? [{ label: "Reorder steps", onSelect: () => setReordering(true) }] : [{ label: "Tidy up", onSelect: tidy }]),
        ...(channelId ? [{ label: "Save as template", onSelect: () => setNaming(true) }] : []),
      ]}
    />
  );

  const tabs = (
    <div role="tablist" aria-label="View" className="glass flex h-[42px] items-center rounded-full p-[3px] text-[14px]">
      {(["canvas", "how"] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("h-9 rounded-full px-4 font-semibold", tab === t ? "bg-chip text-ink" : "text-muted hover:text-ink")}>
          {t === "canvas" ? (phone ? "Steps" : "Canvas") : "How it works"}
        </button>
      ))}
    </div>
  );

  const saveButton = (
    <Button type="button" variant="primary" onClick={onDone} disabled={!ready || saving} title={!ready ? (problems.lines[0] ?? "Add a step first") : undefined} className="h-[42px] px-5 text-[15px]">
      {saving ? "Saving" : doneLabel}
    </Button>
  );

  const selected = sel ? stepById(team, sel) : undefined;
  const form = (id: string) => <StepForm team={team} stepId={id} onChange={commit} onDelete={() => remove(id)} channelId={channelId} />;

  return createPortal(
    <CreateAgentContext.Provider value={(done) => setNewAgent(() => done)}>
    <div role="dialog" aria-label={`How ${name} works`} className="fixed inset-0 z-50 flex flex-col bg-panel text-ink md:left-[84px]">
      <header className="flex h-[72px] shrink-0 items-center gap-3 px-4 md:px-6">
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-3">
          <button type="button" onClick={onBack} aria-label="Back" className="circle circle-sm shrink-0">
            <ChevronLeft size={19} />
          </button>
          {!phone && (
            <>
              <TeamGhosts agentIds={teamAgentIds(team)} seed={name} size={34} />
              <div className="min-w-0">
                <div className="truncate text-[17px] font-semibold leading-tight">{name}</div>
                <div className="text-[13px] text-muted">How the team works</div>
              </div>
            </>
          )}
        </div>
        {tabs}
        <div className="flex flex-1 basis-0 items-center justify-end gap-2.5">
          {!phone && menu}
          {phone ? (
            <button type="button" onClick={onDone} disabled={!ready || saving} aria-label={doneLabel} title={!ready ? (problems.lines[0] ?? "Add a step first") : undefined} className="circle circle-sm shrink-0 disabled:opacity-40">
              {saving ? <Loader2 size={17} className="animate-spin" /> : <CheckIcon />}
            </button>
          ) : (
            saveButton
          )}
        </div>
      </header>

      {phone && (
        <div className="flex shrink-0 items-center justify-between px-7 pb-1">
          <span className="truncate text-[15px] text-muted">{name}</span>
          {steps.length > 0 && (
            <Menu
              align="right"
              trigger={(isOpen, toggle) => (
                <button type="button" onClick={toggle} aria-expanded={isOpen} aria-haspopup="menu" className="inline-flex min-h-11 items-center gap-1 text-[15px] text-muted">
                  {steps.length} {steps.length === 1 ? "step" : "steps"} <ChevronDown size={13} />
                </button>
              )}
              items={[
                { label: "Reorder steps", onSelect: () => setReordering(true) },
                { label: "Start from a template", onSelect: () => setTemplates(true) },
                ...(channelId ? [{ label: "Save as template", onSelect: () => setNaming(true) }] : []),
              ]}
            />
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {tab === "how" ? (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <HowPage team={team} name={name} wide={!phone} onEdit={() => setTab("canvas")} />
          </div>
        ) : phone ? (
          <div className="min-w-0 flex-1 overflow-y-auto">
            {steps.length === 0 ? (
              <EmptyState onAdd={() => setAdding({})} onTemplates={() => setTemplates(true)} />
            ) : (
              <PhoneFlow team={team} problems={problems.byStep} banner={banner ? <div className="mb-4 w-full">{banner}</div> : null} onOpen={open} onAdd={setAdding} />
            )}
          </div>
        ) : (
          <>
            <div className="relative min-w-0 flex-1">
              <StepCanvas
                team={team}
                selected={sel}
                problems={problems.byStep}
                fitKey={fitKey}
                onSelect={setSel}
                onMove={(id, pos) => {
                  manual.current.add(id);
                  onChange(updating(team, id, pos));
                }}
                onAdd={add}
                empty={steps.length === 0 ? <EmptyState onAdd={() => add("agent", {})} onTemplates={() => setTemplates(true)} /> : null}
              />
              {banner && <div className="absolute left-1/2 top-4 z-10 w-[560px] max-w-[calc(100%-22rem)] -translate-x-1/2">{banner}</div>}
              <div data-ui role="toolbar" aria-label="Add a step" className="glass absolute bottom-6 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 gap-0.5 overflow-x-auto rounded-3xl p-2">
                {TOOLBAR.map((b) => {
                  const ok = kindsFor(steps.length === 0, { after: anchor }).includes(b.kind);
                  return (
                    <button key={b.kind} type="button" disabled={!ok} title={ok ? undefined : "Add a first step before this one"} onClick={() => add(b.kind, { after: anchor })} className="flex h-14 w-[88px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl text-[12px] font-medium text-ink/85 hover:bg-hover disabled:opacity-35 disabled:hover:bg-transparent">
                      <KindIcon kind={iconKind(b.kind)} size={19} />
                      {b.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <aside aria-label={selected ? "Step" : "Step panel"} className="flex w-[360px] shrink-0 flex-col border-l border-line bg-panel">
              <div className="flex h-[60px] shrink-0 items-center justify-between px-5">
                <h2 className="text-[17px] font-semibold">{selected ? stepHeading(team, selected) : steps.length ? "No step picked" : "No steps yet"}</h2>
                {selected && (
                  <button type="button" onClick={() => setSel(null)} aria-label="Close" className="circle circle-sm">
                    <X size={16} />
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" data-scroll>
                {selected ? form(selected.id) : <p className="text-sm text-muted">{steps.length ? "Pick a step to edit it." : "Steps you add show up here to edit."}</p>}
              </div>
            </aside>
          </>
        )}
        {saving && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-panel/55" role="status">
            <div className="flex w-[300px] items-center gap-3 rounded-3xl border border-line bg-card p-5 shadow-panel">
              <Loader2 size={22} className="animate-spin text-muted" />
              <div>
                <div className="text-[16px] font-semibold">Saving</div>
                <div className="text-sm text-muted">Telling the team how it works</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {phone && editing && stepById(team, editing) && (
        <Modal title={stepHeading(team, stepById(team, editing)!)} onClose={() => setEditing(null)} label="Step">
          {form(editing)}
        </Modal>
      )}
      {adding && <AddStepSheet team={team} at={adding} onPick={(kind, a) => add(kind, adding.between ? adding : { after: a })} onClose={() => setAdding(null)} />}
      {reordering && <ReorderSheet team={team} onChange={commit} onClose={() => setReordering(false)} />}
      {templates && <TemplateBrowser title="Start from a template" onClose={() => setTemplates(false)} onUse={useTemplate} />}
      {naming && channelId && <SaveTemplate channelId={channelId} onClose={() => setNaming(false)} />}
      {newAgent && (
        <NewAgentForTeam
          onClose={() => setNewAgent(null)}
          onCreated={(a) => {
            newAgent(a.id);
            setNewAgent(null);
          }}
        />
      )}
    </div>
    </CreateAgentContext.Provider>,
    document.body,
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function EmptyState({ onAdd, onTemplates }: { onAdd: () => void; onTemplates: () => void }) {
  return (
    <div className="absolute inset-0 z-[5] grid place-items-center p-6 text-center" data-ui>
      <div className="flex max-w-[420px] flex-col items-center gap-3">
        <span className="grid size-[104px] place-items-center rounded-full border border-dashed border-input text-faint">
          <Workflow size={40} strokeWidth={1.5} />
        </span>
        <h2 className="text-[22px] font-semibold">Add your first step</h2>
        <p className="text-[15px] text-muted">A step is an agent doing one thing. Add more and join them up.</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2.5">
          <Button type="button" variant="primary" onClick={onAdd} className="h-[42px] px-5">
            <Plus size={16} /> Add a step
          </Button>
          <Button type="button" onClick={onTemplates} className="h-[42px] px-5">
            Browse templates
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Save the team's steps as a template anyone here can start from (who does each step is left out). */
function SaveTemplate({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "saving" | string>("idle");
  return (
    <Modal title="Save as template" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("saving");
          try {
            await api("POST", "/api/team-templates", { channelId, name: name.trim() });
            onClose();
          } catch (err) {
            setState((err as Error).message);
          }
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" maxLength={60} aria-label="Template name" autoFocus className="h-11 w-full rounded-2xl border border-input bg-transparent px-3.5 text-[15px] outline-none focus:border-ring" />
        <p className="text-xs text-muted">Anyone here can start a team from it. Who does each step is left out. It saves the steps as they are in the team now, not changes you haven't saved yet.</p>
        {state !== "idle" && state !== "saving" && <p className="text-sm text-bad">{state}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || state === "saving"}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

