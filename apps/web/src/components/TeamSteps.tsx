import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Maximize2, Minus, Plus, Trash2, X } from "lucide-react";
import {
  DEFAULT_ROUNDS,
  STEP_H,
  STEP_ROW,
  STEP_W,
  TEAM_TEMPLATES,
  chartFromSteps,
  harnessLabel,
  layoutSteps,
  stepLabel,
  stepOrder,
  stepsProblem,
  teamFromTemplate,
  type Agent,
  type ChannelTeam,
  type TeamRole,
  type TeamStep,
  type TeamStepKind,
  type TeamFlow,
  type TeamTemplate,
} from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { AgentAvatar, Button, Input, Textarea, cx } from "./ui.tsx";

/** A stepped team with its plain chart kept in step, so the rest of the app (and older apps) see who's on it. */
export function withChart(team: ChannelTeam): ChannelTeam {
  return { ...team, ...chartFromSteps(team, team.nodes) };
}

/** A template filled in with your agents: each role gets an agent on the harness it suggests, a different one each where it can. */
export function fillTemplate(t: Pick<TeamTemplate, "roles" | "steps">, agents: Agent[], base: ChannelTeam | null = null): ChannelTeam {
  const { roles, steps } = teamFromTemplate(t);
  const used = new Set<string>();
  const filled = roles.map((r) => {
    const pick = agents.find((a) => a.harness === r.harness && !used.has(a.id)) ?? agents.find((a) => a.harness === r.harness) ?? agents.find((a) => !used.has(a.id)) ?? null;
    if (pick) used.add(pick.id);
    return { ...r, agentId: pick?.id ?? null };
  });
  return withChart({
    ...(base ?? { nodes: [], edges: [] }),
    nodes: [],
    edges: [],
    roles: filled,
    steps,
  });
}

const KIND_LABEL: Record<TeamStepKind, string> = {
  do: "Does it",
  review: "Reviews",
  hand_out: "Hands out",
};
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 7)}`;

// --- the template picker ------------------------------------------------------------------

/**
 * How a team works, picked from a template: the templates on the left, the picked one's roles on
 * the right with an agent for each, and its steps in a line. "Customize steps" opens the chart.
 */
export function TeamTemplatePicker({
  team,
  onChange,
  onCreateAgent,
  onDescribe,
  onDrawOwn,
}: {
  team: ChannelTeam | null;
  onChange: (team: ChannelTeam) => void;
  onCreateAgent?: (roleId: string) => void;
  /** a person describes the team in their words; an agent builds it */
  onDescribe?: (text: string) => void;
  /** a plain chart instead of roles and steps */
  onDrawOwn?: () => void;
}) {
  const agents = useStore((s) => s.agents);
  const [own, setOwn] = useState<TeamTemplate[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [describe, setDescribe] = useState("");
  useEffect(() => {
    api<TeamTemplate[]>("GET", "/api/team-templates")
      .then(setOwn)
      .catch(() => {});
  }, []);
  const templates = [...TEAM_TEMPLATES, ...own];
  const pick = (t: TeamTemplate) => {
    setPicked(t.id);
    onChange(fillTemplate(t, agents, team));
  };
  // start on the first template so there's always something to look at
  useEffect(() => {
    if (!team?.roles?.length && !picked) pick(TEAM_TEMPLATES[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = templates.find((t) => t.id === picked);

  return (
    <div className="space-y-4">
      {onDescribe && (
        <form
          className="flex items-center gap-2 h-11 px-3 rounded-xl border border-line bg-panel focus-within:border-ring"
          onSubmit={(e) => {
            e.preventDefault();
            if (describe.trim()) onDescribe(describe.trim());
          }}
        >
          <Input
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            placeholder="Or describe it: “Opus plans, GPT pokes holes until it approves, then Opus hands out the work”"
            className="border-0 focus:ring-0 px-0 h-9"
            aria-label="Describe how the team works"
          />
          <Button type="submit" variant="ghost" disabled={!describe.trim()} className="shrink-0">
            Have an agent build it
          </Button>
        </form>
      )}
      {custom && team ? (
        <TeamSteps team={team} onChange={onChange} onCreateAgent={onCreateAgent} height={460} />
      ) : (
        <div className="flex flex-col md:flex-row gap-4">
          <div className="md:w-72 shrink-0 space-y-2" role="listbox" aria-label="Templates">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={picked === t.id}
                onClick={() => pick(t)}
                className={cx("w-full text-left rounded-xl border px-3.5 py-3 bg-panel", picked === t.id ? "border-accent ring-1 ring-accent" : "border-line hover:bg-hover")}
              >
                <span className="flex justify-between gap-2 text-sm font-semibold">
                  {t.name}
                  <span className="text-xs font-normal text-muted">{t.roles.length} roles</span>
                </span>
                {t.blurb && <span className="block text-xs text-muted mt-0.5">{t.blurb}</span>}
              </button>
            ))}
            {onDrawOwn && (
              <button type="button" onClick={onDrawOwn} className="w-full text-left text-sm text-accent-text px-1 py-1.5 hover:underline">
                Draw who hands work to whom instead
              </button>
            )}
          </div>
          {team?.roles?.length ? (
            <div className="flex-1 min-w-0 rounded-2xl border border-line bg-panel p-4 space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-semibold">{current?.name ?? "Your team"}</div>
                <button type="button" onClick={() => setCustom(true)} className="text-sm text-accent-text hover:underline">
                  Customize steps
                </button>
              </div>
              <div className="space-y-1.5">
                {team.roles.map((r) => (
                  <div key={r.id} className="grid grid-cols-1 sm:grid-cols-[130px_minmax(0,1fr)_200px] gap-x-3 gap-y-1 items-center rounded-xl bg-bg px-3 py-2">
                    <div className="text-sm font-semibold">{r.name}</div>
                    <div className="text-xs text-muted line-clamp-2" title={r.description}>
                      {r.description}
                    </div>
                    <AgentSelect
                      value={r.agentId}
                      suggest={r.harness}
                      onChange={(agentId) =>
                        onChange(
                          withChart({
                            ...team,
                            roles: team.roles!.map((x) => (x.id === r.id ? { ...x, agentId } : x)),
                          }),
                        )
                      }
                      onCreate={onCreateAgent ? () => onCreateAgent(r.id) : undefined}
                      label={`Who's the ${r.name}`}
                    />
                  </div>
                ))}
              </div>
              <StepLine team={team} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The steps as a line of pills: "Lead plans → Challenger reviews ↺ → …". */
function StepLine({ team }: { team: ChannelTeam }) {
  const roles = team.roles ?? [];
  const order = stepOrder(team.steps ?? []);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs pt-1">
      {order.map((s, i) => (
        <span key={s.id} className="contents">
          {i > 0 && <span className="text-faint">→</span>}
          <span className="px-2.5 py-1 rounded-full bg-accent-soft text-accent-text font-medium">{stepLabel(s, roles)}</span>
          {s.kind === "review" && <span className="text-muted">↺ until approved, max {s.maxRounds ?? DEFAULT_ROUNDS}</span>}
        </span>
      ))}
    </div>
  );
}

/** Pick the agent for a role, or make one. */
function AgentSelect({ value, onChange, onCreate, suggest, label }: { value: string | null; onChange: (id: string | null) => void; onCreate?: () => void; suggest?: string; label: string }) {
  const agents = useStore((s) => s.agents);
  return (
    <select
      value={value ?? ""}
      aria-label={label}
      onChange={(e) => {
        if (e.target.value === "__new") return onCreate?.();
        onChange(e.target.value || null);
      }}
      className={cx("h-9 w-full rounded-lg border bg-panel px-2 text-sm", value ? "border-line" : "border-dashed border-warn text-muted")}
    >
      <option value="">{suggest ? `Pick an agent (${harnessLabel(suggest)} fits)` : "Pick an agent"}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {harnessLabel(a.harness)}
        </option>
      ))}
      {onCreate && <option value="__new">+ Create an agent…</option>}
    </select>
  );
}

// --- the chart --------------------------------------------------------------------------

interface Box {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where every box on the chart goes: the steps, and under each hand-out its pieces and who checks them. */
function boxes(team: ChannelTeam) {
  const steps = team.steps ?? [];
  const out: (Box & {
    step?: TeamStep;
    piece?: { roleId: string; of: string };
    checker?: { roleId: string; of: string };
  })[] = [];
  for (const s of steps) {
    out.push({ key: s.id, x: s.x, y: s.y, w: STEP_W, h: STEP_H, step: s });
    if (s.kind !== "hand_out") continue;
    const to = s.handTo ?? [];
    const gap = 32;
    const width = to.length * STEP_W + (to.length - 1) * gap;
    to.forEach((roleId, i) =>
      out.push({
        key: `${s.id}:piece:${roleId}`,
        x: s.x + STEP_W / 2 - width / 2 + i * (STEP_W + gap),
        y: s.y + STEP_ROW,
        w: STEP_W,
        h: STEP_H,
        piece: { roleId, of: s.id },
      }),
    );
    if (s.reviewBy)
      out.push({
        key: `${s.id}:check`,
        x: s.x,
        y: s.y + STEP_ROW * (to.length ? 2 : 1),
        w: STEP_W,
        h: STEP_H,
        checker: { roleId: s.reviewBy, of: s.id },
      });
  }
  return out;
}

type Pt = { x: number; y: number };
type Dir = "down" | "up" | "left" | "right";
/** A smooth curve between two points that leaves `a` and enters `b` heading the given ways. */
function curve(a: Pt, b: Pt, out: Dir, into: Dir, minReach = 40) {
  const reach = Math.max(minReach, Math.hypot(b.x - a.x, b.y - a.y) / 3);
  const d = (dir: Dir, p: Pt, s: 1 | -1) => (dir === "down" || dir === "up" ? { x: p.x, y: p.y + (dir === "down" ? s : -s) * reach } : { x: p.x + (dir === "right" ? s : -s) * reach, y: p.y });
  const c1 = d(out, a, 1);
  const c2 = d(into, b, -1);
  return {
    d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
    mid: {
      x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
      y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
    },
  };
}
const bottom = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h });
const top = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y });

interface Line {
  key: string;
  d: string;
  mid: Pt;
  tone: "go" | "ok" | "back";
  label?: string;
}

function lines(team: ChannelTeam, all: ReturnType<typeof boxes>): Line[] {
  const by = new Map(all.map((b) => [b.key, b]));
  const out: Line[] = [];
  for (const s of team.steps ?? []) {
    const me = by.get(s.id)!;
    const pieces = all.filter((b) => b.piece?.of === s.id);
    const check = all.find((b) => b.checker?.of === s.id);
    // a hand-out: to each piece, each piece to whoever checks it
    for (const p of pieces)
      out.push({
        key: `${s.id}>${p.key}`,
        ...curve(bottom(me), top(p), "down", "down"),
        tone: "go",
      });
    if (check) {
      const from = pieces.length ? pieces : [me];
      for (const p of from)
        out.push({
          key: `${p.key}>check`,
          ...curve(bottom(p), top(check), "down", "down"),
          tone: "go",
        });
      out.push({
        key: `${s.id}:back`,
        ...curve({ x: check.x + check.w, y: check.y + check.h / 2 }, { x: check.x + check.w + 60, y: check.y - 20 }, "right", "down"),
        tone: "back",
        label: "changes go back to the builder",
      });
    }
    if (s.next && by.get(s.next)) {
      const to = by.get(s.next)!;
      const froms = check ? [check] : pieces.length ? pieces : [me];
      for (const f of froms) {
        const c =
          to.y > f.y + f.h + 12
            ? curve(bottom(f), top(to), "down", "down")
            : // side by side: in the upper part, so a review's "sent back" line can run under it
              to.x > f.x
              ? curve({ x: f.x + f.w, y: f.y + f.h * 0.35 }, { x: to.x, y: to.y + to.h * 0.35 }, "right", "right")
              : curve({ x: f.x, y: f.y + f.h * 0.35 }, { x: to.x + to.w, y: to.y + to.h * 0.35 }, "left", "left");
        out.push({
          key: `${f.key}>${s.next}`,
          ...c,
          tone: s.kind === "review" || check ? "ok" : "go",
          label: s.kind === "review" ? "approved" : check ? "all approved" : undefined,
        });
      }
    }
    if (s.kind === "review" && s.sendBackTo && by.get(s.sendBackTo)) {
      const to = by.get(s.sendBackTo)!;
      const c =
        Math.abs(to.y - me.y) < 10
          ? // side by side: a straight line back, under the one that came in
            curve({ x: me.x + (to.x < me.x ? 0 : me.w), y: me.y + me.h * 0.7 }, { x: to.x + (to.x < me.x ? to.w : 0), y: to.y + to.h * 0.7 }, to.x < me.x ? "left" : "right", to.x < me.x ? "left" : "right")
          : curve({ x: me.x, y: me.y + me.h / 2 }, { x: to.x, y: to.y + to.h / 2 }, "left", "right");
      out.push({
        key: `${s.id}~back`,
        ...c,
        tone: "back",
        label: `changes, max ${s.maxRounds ?? DEFAULT_ROUNDS}`,
      });
    }
  }
  return out;
}

const MIN_K = 0.3;
const MAX_K = 2;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

/**
 * A team's roles and steps, editable: roles on the left, the steps as a chart you can zoom (wheel,
 * pinch, the buttons) and move around (drag empty space), and whatever you click on the right.
 */
export function TeamSteps({
  team,
  onChange,
  readOnly = false,
  onCreateAgent,
  channelId,
  height = 520,
  active,
}: {
  team: ChannelTeam;
  onChange?: (team: ChannelTeam) => void;
  readOnly?: boolean;
  onCreateAgent?: (roleId: string) => void;
  /** a saved channel, so its team can be saved as a template */
  channelId?: string;
  height?: number;
  /** steps someone is on right now */
  active?: Set<string>;
}) {
  const agents = useStore((s) => s.agents);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const roles = team.roles ?? [];
  const steps = team.steps ?? [];
  const [sel, setSel] = useState<{ kind: "role" | "step"; id: string } | null>(null);
  const set = (next: ChannelTeam) => onChange?.(withChart(next));
  const setRole = (id: string, patch: Partial<TeamRole>) =>
    set({
      ...team,
      roles: roles.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const setStep = (id: string, patch: Partial<TeamStep>) =>
    set({
      ...team,
      steps: steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });

  const addRole = () => {
    const r: TeamRole = {
      id: uid("role"),
      name: "New role",
      description: "",
      agentId: null,
    };
    set({ ...team, roles: [...roles, r] });
    setSel({ kind: "role", id: r.id });
  };
  const removeRole = (id: string) => {
    set({
      ...team,
      roles: roles.filter((r) => r.id !== id),
      steps: steps.map((s) => ({
        ...s,
        handTo: s.handTo?.filter((x) => x !== id),
        reviewBy: s.reviewBy === id ? null : s.reviewBy,
      })),
    });
    setSel(null);
  };
  const addStep = () => {
    const after = sel?.kind === "step" ? steps.find((s) => s.id === sel.id) : stepOrder(steps).at(-1);
    const all = boxes(team);
    const below = after ? Math.max(...all.filter((b) => b.key === after.id || b.key.startsWith(`${after.id}:`)).map((b) => b.y)) + STEP_ROW : 0;
    const s: TeamStep = {
      id: uid("step"),
      roleId: roles[0]?.id ?? "",
      kind: "do",
      action: "",
      next: after?.next ?? null,
      x: after?.x ?? 0,
      y: below,
    };
    // everything under the new step moves down a row to make room
    const shifted = steps.map((x) => (after && x.y >= below ? { ...x, y: x.y + STEP_ROW } : x)).map((x) => (after && x.id === after.id ? { ...x, next: s.id } : x));
    set({ ...team, steps: [...shifted, s] });
    setSel({ kind: "step", id: s.id });
  };
  const removeStep = (id: string) => {
    const gone = steps.find((s) => s.id === id);
    set({
      ...team,
      steps: steps
        .filter((s) => s.id !== id)
        .map((s) => ({
          ...s,
          next: s.next === id ? (gone?.next ?? null) : s.next,
          sendBackTo: s.sendBackTo === id ? null : s.sendBackTo,
        })),
    });
    setSel(null);
  };

  const problem = steps.length || roles.length ? stepsProblem(team) : null;
  const selRole = sel?.kind === "role" ? roles.find((r) => r.id === sel.id) : undefined;
  const selStep = sel?.kind === "step" ? steps.find((s) => s.id === sel.id) : undefined;

  return (
    <div className="space-y-2">
      <div className="flex flex-col lg:flex-row rounded-2xl border border-line overflow-hidden bg-panel" style={{ minHeight: height }}>
        <aside className="lg:w-56 shrink-0 border-b lg:border-b-0 lg:border-r border-line p-2.5 flex flex-col gap-1" aria-label="Roles">
          <div className="px-1.5 pt-1 pb-2 text-sm font-semibold">Roles</div>
          {roles.map((r) => {
            const a = r.agentId ? byId.get(r.agentId) : undefined;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSel({ kind: "role", id: r.id })}
                className={cx("text-left rounded-xl px-2.5 py-2 flex items-center gap-2", sel?.id === r.id ? "bg-accent-soft" : "hover:bg-hover")}
              >
                {a ? <AgentAvatar agent={a} size={24} interactive={false} /> : <span className="size-6 rounded-full border border-dashed border-warn shrink-0" />}
                <span className="min-w-0">
                  <span className={cx("block text-sm font-medium truncate", sel?.id === r.id && "text-accent-text")}>{r.name || "Untitled role"}</span>
                  <span className={cx("block text-[11px] truncate", a ? "text-muted" : "text-warn")}>{a ? `${a.name} · ${harnessLabel(a.harness)}` : "Nobody yet"}</span>
                </span>
              </button>
            );
          })}
          {!readOnly && (
            <button type="button" onClick={addRole} className="mt-1 h-9 rounded-xl border border-dashed border-line text-sm text-accent-text text-left px-2.5 hover:bg-hover">
              + Add role
            </button>
          )}
          <div className="flex-1" />
          {channelId && !readOnly && <SaveTemplate channelId={channelId} />}
        </aside>

        <StepCanvas
          team={team}
          height={height}
          readOnly={readOnly}
          selected={sel?.kind === "step" ? sel.id : null}
          onSelect={(id) => setSel(id ? { kind: "step", id } : null)}
          onMove={(id, x, y) => setStep(id, { x, y })}
          onAdd={readOnly ? undefined : addStep}
          onTidy={readOnly ? undefined : () => set({ ...team, steps: layoutSteps(steps) })}
          active={active}
        />

        {(selRole || selStep) && (
          <aside className="lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-line p-4 space-y-3" aria-label={selRole ? "Role" : "Step"}>
            <div className="flex items-center justify-between">
              <div className="font-semibold">{selRole ? selRole.name || "Role" : "Step"}</div>
              <button type="button" onClick={() => setSel(null)} className="size-8 grid place-items-center rounded-lg text-muted hover:bg-hover" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            {selRole && (
              <RoleForm
                role={selRole}
                readOnly={readOnly}
                onChange={(p) => setRole(selRole.id, p)}
                onRemove={() => removeRole(selRole.id)}
                inUse={steps.some((s) => s.roleId === selRole.id)}
                onCreateAgent={onCreateAgent ? () => onCreateAgent(selRole.id) : undefined}
              />
            )}
            {selStep && <StepForm step={selStep} team={team} readOnly={readOnly} onChange={(p) => setStep(selStep.id, p)} onRemove={() => removeStep(selStep.id)} />}
          </aside>
        )}
      </div>
      {problem && <p className="text-xs text-warn">{problem}</p>}
    </div>
  );
}

function Label({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-muted">{text}</span>
      {children}
    </label>
  );
}

function RoleForm({
  role,
  onChange,
  onRemove,
  readOnly,
  inUse,
  onCreateAgent,
}: {
  role: TeamRole;
  onChange: (p: Partial<TeamRole>) => void;
  onRemove: () => void;
  readOnly: boolean;
  inUse: boolean;
  onCreateAgent?: () => void;
}) {
  return (
    <fieldset disabled={readOnly} className="space-y-3">
      <Label text="Name">
        <Input value={role.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={60} />
      </Label>
      <Label text="What this role does">
        <Textarea value={role.description} onChange={(e) => onChange({ description: e.target.value })} rows={7} maxLength={4000} placeholder="Every agent on the team reads this, so they know what this role does." />
      </Label>
      <Label text="Filled by">
        <AgentSelect value={role.agentId} suggest={role.harness} onChange={(agentId) => onChange({ agentId })} onCreate={onCreateAgent} label={`Who's the ${role.name}`} />
      </Label>
      {!readOnly && (
        <button type="button" onClick={onRemove} disabled={inUse} title={inUse ? "A step still belongs to this role" : undefined} className="text-sm text-bad disabled:text-faint inline-flex items-center gap-1.5">
          <Trash2 size={14} /> Remove role
        </button>
      )}
    </fieldset>
  );
}

function StepForm({ step, team, onChange, onRemove, readOnly }: { step: TeamStep; team: ChannelTeam; onChange: (p: Partial<TeamStep>) => void; onRemove: () => void; readOnly: boolean }) {
  const roles = team.roles ?? [];
  const others = stepOrder(team.steps ?? []).filter((s) => s.id !== step.id);
  const sel = "h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm";
  return (
    <fieldset disabled={readOnly} className="space-y-3">
      <Label text="Who">
        <select value={step.roleId} onChange={(e) => onChange({ roleId: e.target.value })} className={sel}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Label>
      <Label text="Does what">
        <Input value={step.action} onChange={(e) => onChange({ action: e.target.value })} maxLength={200} placeholder="e.g. Draft a thorough plan" />
      </Label>
      <div className="flex rounded-lg border border-line p-0.5 text-sm" role="radiogroup" aria-label="Kind of step">
        {(Object.keys(KIND_LABEL) as TeamStepKind[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={step.kind === k}
            onClick={() =>
              onChange({
                kind: k,
                ...(k === "review" && !step.sendBackTo
                  ? {
                      sendBackTo: others[0]?.id ?? null,
                      maxRounds: step.maxRounds ?? DEFAULT_ROUNDS,
                    }
                  : {}),
                ...(k === "hand_out" && !step.handTo?.length
                  ? {
                      handTo: roles
                        .filter((r) => r.id !== step.roleId)
                        .slice(0, 2)
                        .map((r) => r.id),
                    }
                  : {}),
              })
            }
            className={cx("flex-1 h-8 rounded-md", step.kind === k ? "bg-ink text-panel font-medium" : "text-muted hover:text-ink")}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {step.kind === "review" && (
        <>
          <Label text="Changes go back to">
            <select value={step.sendBackTo ?? ""} onChange={(e) => onChange({ sendBackTo: e.target.value || null })} className={sel}>
              <option value="">Pick a step</option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {stepLabel(s, roles)}
                </option>
              ))}
            </select>
          </Label>
        </>
      )}
      {step.kind === "hand_out" && (
        <>
          <div className="space-y-1">
            <span className="block text-xs font-medium text-muted">Pieces go to</span>
            {roles
              .filter((r) => r.id !== step.roleId)
              .map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!step.handTo?.includes(r.id)}
                    onChange={(e) =>
                      onChange({
                        handTo: e.target.checked ? [...(step.handTo ?? []), r.id] : (step.handTo ?? []).filter((x) => x !== r.id),
                      })
                    }
                  />
                  {r.name}
                </label>
              ))}
          </div>
          <Label text="Each piece is checked by">
            <select value={step.reviewBy ?? ""} onChange={(e) => onChange({ reviewBy: e.target.value || null })} className={sel}>
              <option value="">Nobody</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Label>
        </>
      )}
      {(step.kind === "review" || (step.kind === "hand_out" && step.reviewBy)) && (
        <Label text="Rounds of changes before it asks you">
          <Input
            type="number"
            min={1}
            max={10}
            value={step.maxRounds ?? DEFAULT_ROUNDS}
            onChange={(e) =>
              onChange({
                maxRounds: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
              })
            }
          />
        </Label>
      )}
      <Label text={step.kind === "review" ? "When approved, next" : "Next"}>
        <select value={step.next ?? ""} onChange={(e) => onChange({ next: e.target.value || null })} className={sel}>
          <option value="">Done: the flow ends here</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {stepLabel(s, roles)}
            </option>
          ))}
        </select>
      </Label>
      {!readOnly && (
        <button type="button" onClick={onRemove} className="text-sm text-bad inline-flex items-center gap-1.5">
          <Trash2 size={14} /> Remove step
        </button>
      )}
    </fieldset>
  );
}

function SaveTemplate({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  if (!open)
    return (
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="justify-start">
        {state === "saved" ? "Saved as a template" : "Save as template"}
      </Button>
    );
  return (
    <form
      className="space-y-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        setState("saving");
        try {
          await api("POST", "/api/team-templates", { channelId, name });
          setState("saved");
          setOpen(false);
        } catch (err) {
          setState((err as Error).message);
        }
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" autoFocus maxLength={60} aria-label="Template name" />
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" disabled={!name.trim() || state === "saving"} className="flex-1">
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {state !== "idle" && state !== "saving" && state !== "saved" && <p className="text-xs text-bad">{state}</p>}
      <p className="text-[11px] text-muted">Saved templates show up when anyone here sets up a team. Saved from the steps as they are now.</p>
    </form>
  );
}

/** The steps chart: zoom with the wheel, a pinch or the buttons; drag empty space to move around; drag a step to move it. */
function StepCanvas({
  team,
  height,
  readOnly,
  selected,
  onSelect,
  onMove,
  onAdd,
  onTidy,
  active,
}: {
  team: ChannelTeam;
  height: number;
  readOnly: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onAdd?: () => void;
  onTidy?: () => void;
  active?: Set<string>;
}) {
  const agents = useStore((s) => s.agents);
  const roles = team.roles ?? [];
  const el = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 30, k: 1 });
  const [size, setSize] = useState({ w: 600, h: height });
  const all = useMemo(() => boxes(team), [team]);
  const drawn = useMemo(() => lines(team, all), [team, all]);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ kind: "pan"; start: Pt; view: typeof view } | { kind: "move"; id: string; start: Pt; from: Pt; moved: boolean } | { kind: "pinch"; dist: number; mid: Pt; view: typeof view } | null>(null);

  const bounds = useCallback(() => {
    if (!all.length) return { x: 0, y: 0, w: STEP_W, h: STEP_H };
    const x0 = Math.min(...all.map((b) => b.x)) - 40;
    const y0 = Math.min(...all.map((b) => b.y)) - 40;
    const x1 = Math.max(...all.map((b) => b.x + b.w)) + 120;
    const y1 = Math.max(...all.map((b) => b.y + b.h)) + 40;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [all]);
  const fit = useCallback(() => {
    const b = bounds();
    const r = el.current?.getBoundingClientRect();
    const w = r?.width || size.w;
    const h = r?.height || size.h;
    const k = clampK(Math.min(w / b.w, h / b.h, 1));
    setView({
      k,
      x: (w - b.w * k) / 2 - b.x * k,
      y: (h - b.h * k) / 2 - b.y * k,
    });
  }, [bounds, size]);

  useLayoutEffect(() => {
    const r = el.current?.getBoundingClientRect();
    if (r) setSize({ w: r.width, h: r.height });
    fit();
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (el.current) ro.observe(el.current);
    return () => ro.disconnect();
    // fit once, when the chart first shows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomAt = (p: Pt, factor: number) =>
    setView((v) => {
      const k = clampK(v.k * factor);
      return {
        k,
        x: p.x - ((p.x - v.x) * k) / v.k,
        y: p.y - ((p.y - v.y) * k) / v.k,
      };
    });

  // the wheel zooms around the pointer (React's wheel listener can't stop the page scrolling)
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = el.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: ReactPointerEvent) => {
    // a first finger (or the mouse) starts fresh, even if an earlier release never arrived
    if (e.isPrimary) pointers.current.clear();
    el.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        kind: "pinch",
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view,
      };
      return;
    }
    const stepId = (e.target as HTMLElement).closest<HTMLElement>("[data-step]")?.dataset.step;
    const step = stepId ? team.steps?.find((s) => s.id === stepId) : undefined;
    if (step && !readOnly)
      gesture.current = {
        kind: "move",
        id: step.id,
        start: local(e),
        from: { x: step.x, y: step.y },
        moved: false,
      };
    else if (step) onSelect(step.id);
    else gesture.current = { kind: "pan", start: local(e), view };
  };
  const moveP = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const k = clampK((g.view.k * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setView({
        k,
        x: mid.x - ((g.mid.x - g.view.x) * k) / g.view.k,
        y: mid.y - ((g.mid.y - g.view.y) * k) / g.view.k,
      });
    } else if (g.kind === "pan")
      setView({
        ...g.view,
        x: g.view.x + p.x - g.start.x,
        y: g.view.y + p.y - g.start.y,
      });
    else if (g.kind === "move") {
      const dx = (p.x - g.start.x) / view.k;
      const dy = (p.y - g.start.y) / view.k;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      onMove(g.id, Math.round((g.from.x + dx) / 8) * 8, Math.round((g.from.y + dy) / 8) * 8);
    }
  };
  const up = (e: ReactPointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g?.kind === "move" && !g.moved) onSelect(g.id);
    if (g?.kind === "pan" && Math.hypot(local(e).x - g.start.x, local(e).y - g.start.y) < 4) onSelect(null);
    gesture.current = null;
  };

  const roleOf = (id: string) => roles.find((r) => r.id === id);
  const agentOf = (roleId: string) => {
    const r = roleOf(roleId);
    return r?.agentId ? agents.find((a) => a.id === r.agentId) : undefined;
  };
  const b = bounds();
  const mini = { w: 140, h: 96 };
  const mk = Math.min(mini.w / b.w, mini.h / b.h);

  return (
    <div className="relative flex-1 min-w-0" style={{ height }}>
      <div
        ref={el}
        className="absolute inset-0 overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing bg-bg"
        style={{
          backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)",
          backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={down}
        onPointerMove={moveP}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={(e) => pointers.current.has(e.pointerId) && up(e)}
        aria-label="Steps chart"
        role="application"
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          }}
        >
          <svg className="absolute overflow-visible pointer-events-none" style={{ left: 0, top: 0, width: 1, height: 1 }} aria-hidden>
            <defs>
              {(["go", "ok", "back"] as const).map((t) => (
                <marker key={t} id={`step-arrow-${t}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className={t === "ok" ? "fill-ok" : t === "back" ? "fill-warn" : "fill-faint"} />
                </marker>
              ))}
            </defs>
            {drawn.map((l) => (
              <g key={l.key}>
                <path
                  d={l.d}
                  fill="none"
                  strokeWidth={2}
                  markerEnd={`url(#step-arrow-${l.tone})`}
                  strokeDasharray={l.tone === "back" ? "6 5" : undefined}
                  className={l.tone === "ok" ? "stroke-ok" : l.tone === "back" ? "stroke-warn" : "stroke-faint"}
                />
              </g>
            ))}
          </svg>
          {drawn
            .filter((l) => l.label)
            .map((l) => (
              <span
                key={`${l.key}:label`}
                className={cx("absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-bg px-1.5 text-[11px] font-medium pointer-events-none", l.tone === "ok" ? "text-ok" : "text-warn")}
                style={{ left: l.mid.x, top: l.mid.y }}
              >
                {l.label}
              </span>
            ))}
          {all.map((box) => {
            const roleId = box.step?.roleId ?? box.piece?.roleId ?? box.checker?.roleId ?? "";
            const a = agentOf(roleId);
            const name = roleOf(roleId)?.name ?? "?";
            const isStep = !!box.step;
            const on = isStep && active?.has(box.step!.id);
            return (
              <div
                key={box.key}
                data-step={isStep ? box.step!.id : undefined}
                className={cx(
                  "absolute rounded-xl border bg-panel px-3 flex items-center gap-2.5",
                  isStep ? (readOnly ? "cursor-pointer" : "cursor-grab") : "border-dashed",
                  selected === box.step?.id ? "border-accent ring-2 ring-accent/40" : isStep ? "border-line shadow-panel" : "border-line",
                  on && "ring-2 ring-ok/60",
                )}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold tracking-wide uppercase text-muted truncate">
                    {name}
                    {isStep && box.step!.kind !== "do" && <span className="normal-case font-medium"> · {KIND_LABEL[box.step!.kind].toLowerCase()}</span>}
                  </div>
                  <div className="text-sm font-semibold truncate">{isStep ? box.step!.action || <span className="text-faint">Say what it does</span> : box.piece ? "Builds its piece" : "Checks each piece"}</div>
                </div>
                {a ? <AgentAvatar agent={a} size={26} interactive={false} live={on} /> : <span className="size-6 rounded-full border border-dashed border-warn shrink-0" title="Nobody fills this role yet" />}
              </div>
            );
          })}
          {!all.length && <p className="absolute left-0 top-0 w-64 text-sm text-muted">No steps yet.</p>}
        </div>
      </div>

      {/* add and tidy, top left */}
      {(onAdd || onTidy) && (
        <div className="absolute left-3 top-3 flex gap-1.5">
          {onAdd && (
            <Button type="button" onClick={onAdd} className="h-8 px-2.5 text-sm bg-panel">
              <Plus size={14} /> Step
            </Button>
          )}
          {onTidy && (
            <Button type="button" variant="ghost" onClick={onTidy} className="h-8 px-2.5 text-sm bg-panel">
              Tidy up
            </Button>
          )}
        </div>
      )}

      {/* where you are, top right: click to jump */}
      {all.length > 0 && size.w >= 520 && (
        <button
          type="button"
          aria-label="Map of the chart: click to move there"
          className="hidden sm:block absolute right-3 top-3 rounded-lg border border-line bg-panel/90"
          style={{ width: mini.w + 8, height: mini.h + 8 }}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const wx = b.x + (e.clientX - r.left - 4) / mk;
            const wy = b.y + (e.clientY - r.top - 4) / mk;
            setView((v) => ({
              ...v,
              x: size.w / 2 - wx * v.k,
              y: size.h / 2 - wy * v.k,
            }));
          }}
        >
          {all.map((box) => (
            <span
              key={box.key}
              className={cx("absolute rounded-[2px]", selected === box.step?.id ? "bg-accent" : "bg-faint/60")}
              style={{
                left: 4 + (box.x - b.x) * mk,
                top: 4 + (box.y - b.y) * mk,
                width: Math.max(3, box.w * mk),
                height: Math.max(2, box.h * mk),
              }}
            />
          ))}
          <span
            className="absolute border-[1.5px] border-accent rounded-sm bg-accent/5"
            style={{
              left: 4 + (-view.x / view.k - b.x) * mk,
              top: 4 + (-view.y / view.k - b.y) * mk,
              width: (size.w / view.k) * mk,
              height: (size.h / view.k) * mk,
              maxWidth: mini.w,
              maxHeight: mini.h,
            }}
          />
        </button>
      )}

      {/* zoom, bottom right */}
      <div className="absolute right-3 bottom-3 flex items-center rounded-xl border border-line bg-panel shadow-panel">
        <button type="button" onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, 1 / 1.2)} className="size-9 grid place-items-center text-muted hover:text-ink" aria-label="Zoom out">
          <Minus size={16} />
        </button>
        <span className="w-12 text-center text-xs tabular-nums text-muted">{Math.round(view.k * 100)}%</span>
        <button type="button" onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, 1.2)} className="size-9 grid place-items-center text-muted hover:text-ink" aria-label="Zoom in">
          <Plus size={16} />
        </button>
        <span className="w-px h-5 bg-line" />
        <button type="button" onClick={fit} className="h-9 px-2.5 text-xs text-muted hover:text-ink inline-flex items-center gap-1" aria-label="Fit the whole chart">
          <Maximize2 size={13} /> Fit
        </button>
      </div>
    </div>
  );
}

// --- a request going through the steps ---------------------------------------------------

/**
 * Where a request in a stepped channel is: each step as a pill (done, on now, still to come), and
 * when it's waiting on a person, what they can do about it.
 */
export function FlowStrip({ channelId, threadId }: { channelId: string; threadId: string }) {
  const version = useStore((s) => s.flowsVersion);
  const team = useStore((s) => s.channels.find((c) => c.id === channelId)?.settings.team ?? null);
  const [flow, setFlow] = useState<TeamFlow | null>(null);
  const [busy, setBusy] = useState(false);
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
  const roles = team.roles ?? [];
  const order = stepOrder(team.steps);
  const decide = async (action: "approve" | "retry" | "stop") => {
    setBusy(true);
    try {
      setFlow(await api<TeamFlow>("POST", `/api/flows/${flow.id}/decide`, { action }));
    } finally {
      setBusy(false);
    }
  };
  const doneSteps = new Set(flow.history.filter((h) => h.verdict === "done" || h.verdict === "approved").map((h) => h.stepId));
  return (
    <div className="px-4 py-2.5 border-b border-line space-y-2" aria-label="Team steps">
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {order.map((s, i) => {
          const now = flow.stepId === s.id && (flow.status === "running" || flow.status === "waiting");
          const done = flow.status === "done" || (doneSteps.has(s.id) && !now);
          const rounds = flow.rounds[s.id] ?? 0;
          return (
            <span key={s.id} className="contents">
              {i > 0 && <span className="text-faint">→</span>}
              <span
                title={stepLabel(s, roles)}
                className={cx("px-2 py-0.5 rounded-full font-medium", now ? (flow.status === "waiting" ? "bg-warn/15 text-warn" : "bg-ink text-panel") : done ? "bg-ok/15 text-ok" : "bg-chip text-muted")}
              >
                {s.action || stepLabel(s, roles)}
                {done && " ✓"}
                {rounds > 1 && ` · round ${rounds}`}
              </span>
            </span>
          );
        })}
        {flow.status === "failed" && <span className="ml-1 text-bad">Stopped</span>}
      </div>
      {flow.status === "waiting" && flow.waitingFor && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-warn flex-1 min-w-48">{flow.waitingFor.why}</span>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void decide("approve")} className="h-8 text-xs">
            Approve anyway
          </Button>
          <Button type="button" disabled={busy} onClick={() => void decide("retry")} className="h-8 text-xs">
            {flow.waitingFor.options === "rounds" ? "Another round" : "Try again"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide("stop")} className="h-8 text-xs">
            Stop
          </Button>
        </div>
      )}
    </div>
  );
}
