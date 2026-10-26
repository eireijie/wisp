import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { DEFAULT_ROUNDS, stepGraph, stepOrder, type ChannelTeam, type TeamStep } from "@wisp/core";
import { useStore } from "../store.ts";
import { AgentAvatar, cx } from "../components/ui.tsx";
import { ADD_KINDS, BOX_H, BOX_W, fromCanvas, numberOf, stepById, titleOf, toCanvas, type AddAt, type AddKind, KIND_MARK } from "./flow.ts";
import { KindIcon, MessageChip, StepNum, useHandoffName } from "./parts.tsx";

type Pt = { x: number; y: number };

const MIN_K = 0.3;
const MAX_K = 2;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
const CHIP_W = 176;

/** A smooth curve from the right side of one box to the left side of the next, with its midpoint (for the +). */
function across(a: Pt, b: Pt) {
  const reach = Math.max(48, Math.abs(b.x - a.x) / 2);
  const c1 = { x: a.x + reach, y: a.y };
  const c2 = { x: b.x - reach, y: b.y };
  return { d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`, mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 } };
}

/** A loop back: out of the bottom of a box, round underneath, into the bottom of an earlier one. */
function around(a: Pt, b: Pt) {
  const drop = 78 + Math.min(60, Math.abs(a.x - b.x) / 8);
  const c1 = { x: a.x, y: a.y + drop };
  const c2 = { x: b.x, y: b.y + drop };
  return { d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`, mid: { x: (a.x + b.x) / 2, y: a.y + drop * 0.75 } };
}

interface Edge {
  key: string;
  d: string;
  mid: Pt;
  tone: "go" | "back";
  /** a + goes here: the step it comes from (null = the start) and the step it goes to (null = the end) */
  from: string | null;
  to: string | null;
  label?: string;
}

/** The kinds a + offers, as the iPhone's sheet does: fewer when the chart is empty or the step goes first. */
export function kindsFor(empty: boolean, at: AddAt): AddKind[] {
  if (empty) return ["agent", "custom", "handOut"];
  if (at.between && !at.between.from.length) return ["agent", "ask", "handoff", "branch", "custom", "handOut"];
  return ADD_KINDS.map((k) => k.kind);
}

export function StepCanvas({
  team,
  selected,
  problems,
  onSelect,
  onMove,
  onAdd,
  fitKey,
  empty,
}: {
  team: ChannelTeam;
  selected: string | null;
  problems: Map<string, string>;
  onSelect: (id: string | null) => void;
  /** a box was dragged to a new place (stored coordinates) */
  onMove: (id: string, pos: Pt) => void;
  onAdd: (kind: AddKind, at: AddAt) => void;
  /** change to fit the whole chart again (a template was used, steps were tidied) */
  fitKey: number;
  empty: ReactNode;
}) {
  const agents = useStore((s) => s.agents);
  const steps = team.steps ?? [];
  const el = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 60, y: 60, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [drag, setDrag] = useState<{ id: string; pos: Pt } | null>(null);
  const [menu, setMenu] = useState<{ at: AddAt; title: string; pos: Pt } | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ kind: "pan"; start: Pt; view: typeof view } | { kind: "move"; id: string; start: Pt; from: Pt; moved: boolean } | { kind: "pinch"; dist: number; mid: Pt; view: typeof view } | null>(null);

  const pos = useMemo(() => {
    const m = new Map<string, Pt>();
    for (const s of steps) m.set(s.id, drag?.id === s.id ? drag.pos : toCanvas(s));
    return m;
  }, [steps, drag]);

  const g = useMemo(() => stepGraph(steps), [steps]);
  const order = useMemo(() => stepOrder(steps), [steps]);
  const starts = order.filter((s) => !(g.ins.get(s.id) ?? []).length);
  const ends = order.filter((s) => !(g.outs.get(s.id) ?? []).length);

  // the "A message comes in" chip sits left of the first steps, level with them
  const chip = useMemo<Pt>(() => {
    if (!starts.length) return { x: 0, y: 0 };
    const xs = starts.map((s) => pos.get(s.id)!.x);
    const ys = starts.map((s) => pos.get(s.id)!.y + BOX_H / 2);
    return { x: Math.min(...xs) - CHIP_W - 56, y: (Math.min(...ys) + Math.max(...ys)) / 2 - 20 };
  }, [starts, pos]);

  const edges = useMemo(() => {
    const out: Edge[] = [];
    const right = (id: string): Pt => ({ x: pos.get(id)!.x + BOX_W, y: pos.get(id)!.y + BOX_H / 2 });
    const left = (id: string): Pt => ({ x: pos.get(id)!.x, y: pos.get(id)!.y + BOX_H / 2 });
    for (const s of starts) out.push({ key: `start>${s.id}`, ...across({ x: chip.x + CHIP_W, y: chip.y + 20 }, left(s.id)), tone: "go", from: null, to: s.id });
    for (const s of steps) {
      for (const t of g.outs.get(s.id) ?? []) {
        const label = s.kind === "branch" ? (s.ifTrue === t && s.ifFalse === t ? "Yes or no" : s.ifTrue === t ? "Yes" : s.ifFalse === t ? "No" : undefined) : undefined;
        out.push({ key: `${s.id}>${t}`, ...across(right(s.id), left(t)), tone: "go", from: s.id, to: t, label });
      }
      for (const t of g.back.get(s.id) ?? []) {
        const a = { x: pos.get(s.id)!.x + BOX_W / 2, y: pos.get(s.id)!.y + BOX_H };
        const b = { x: pos.get(t)!.x + BOX_W / 2, y: pos.get(t)!.y + BOX_H };
        const n = numberOf(team, t);
        const label =
          s.kind === "review"
            ? `Back to step ${n} until approved · up to ${s.maxRounds ?? DEFAULT_ROUNDS} times`
            : s.kind === "ask"
              ? `If you ask for changes: back to step ${n}`
              : `${s.ifTrue === t ? "Yes" : "No"}: back to step ${n} · up to ${s.maxRounds ?? DEFAULT_ROUNDS} times`;
        out.push({ key: `${s.id}~${t}`, ...around(a, b), tone: "back", from: null, to: null, label });
      }
    }
    return out;
  }, [steps, g, pos, starts, chip, team]);

  const bounds = useCallback(() => {
    if (!steps.length) return { x: 0, y: 0, w: 400, h: 200 };
    const xs = [...steps.map((s) => pos.get(s.id)!.x), chip.x];
    const x1 = Math.max(...steps.map((s) => pos.get(s.id)!.x + BOX_W)) + 70;
    const y0 = Math.min(...steps.map((s) => pos.get(s.id)!.y)) - 30;
    const y1 = Math.max(...steps.map((s) => pos.get(s.id)!.y + BOX_H)) + (edges.some((e) => e.tone === "back") ? 130 : 40);
    const x0 = Math.min(...xs) - 20;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [steps, pos, chip, edges]);

  const fit = useCallback(() => {
    const b = bounds();
    const r = el.current?.getBoundingClientRect();
    const w = r?.width || size.w;
    const h = r?.height || size.h;
    // leave room for the zoom pill (top) and the toolbar (bottom)
    const k = clampK(Math.min((w - 80) / b.w, (h - 190) / b.h, 1));
    setView({ k, x: (w - b.w * k) / 2 - b.x * k, y: (h - 40 - b.h * k) / 2 - b.y * k + 20 });
  }, [bounds, size]);

  useLayoutEffect(() => {
    const r = el.current?.getBoundingClientRect();
    if (r) setSize({ w: r.width, h: r.height });
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (el.current) ro.observe(el.current);
    return () => ro.disconnect();
  }, []);
  // fit when it first shows and when asked to (a template, tidy up)
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const zoomAt = (p: Pt, factor: number) =>
    setView((v) => {
      const k = clampK(v.k * factor);
      return { k, x: p.x - ((p.x - v.x) * k) / v.k, y: p.y - ((p.y - v.y) * k) / v.k };
    });

  // the wheel zooms around the pointer (React's wheel listener can't stop the page scrolling)
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("[data-scroll]")) return;
      e.preventDefault();
      const r = node.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.ctrlKey || e.metaKey) zoomAt(p, Math.exp(-e.deltaY * 0.01));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = el.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-ui]")) return;
    if (e.isPrimary) pointers.current.clear();
    el.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    setMenu(null);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
      return;
    }
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-step]")?.dataset.step;
    if (id) gesture.current = { kind: "move", id, start: local(e), from: pos.get(id)!, moved: false };
    else gesture.current = { kind: "pan", start: local(e), view };
  };
  const moveP = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const gst = gesture.current;
    if (!gst) return;
    if (gst.kind === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const k = clampK((gst.view.k * Math.hypot(a.x - b.x, a.y - b.y)) / gst.dist);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setView({ k, x: mid.x - ((gst.mid.x - gst.view.x) * k) / gst.view.k, y: mid.y - ((gst.mid.y - gst.view.y) * k) / gst.view.k });
    } else if (gst.kind === "pan") setView({ ...gst.view, x: gst.view.x + p.x - gst.start.x, y: gst.view.y + p.y - gst.start.y });
    else if (gst.kind === "move") {
      const dx = (p.x - gst.start.x) / view.k;
      const dy = (p.y - gst.start.y) / view.k;
      if (!gst.moved && Math.hypot(dx, dy) < 4) return;
      gst.moved = true;
      setDrag({ id: gst.id, pos: { x: Math.round((gst.from.x + dx) / 8) * 8, y: Math.round((gst.from.y + dy) / 8) * 8 } });
    }
  };
  const up = (e: ReactPointerEvent) => {
    const gst = gesture.current;
    pointers.current.delete(e.pointerId);
    if (gst?.kind === "move") {
      if (!gst.moved) onSelect(gst.id);
      else if (drag) onMove(drag.id, fromCanvas(drag.pos));
      setDrag(null);
    }
    if (gst?.kind === "pan" && Math.hypot(local(e).x - gst.start.x, local(e).y - gst.start.y) < 4) onSelect(null);
    gesture.current = null;
  };

  // a step that was just picked or added comes into view
  useEffect(() => {
    if (!selected) return;
    const at = pos.get(selected);
    if (!at) return;
    setView((v) => {
      const m = 24;
      const left = at.x * v.k + v.x;
      const right = (at.x + BOX_W) * v.k + v.x;
      const top = at.y * v.k + v.y;
      const bottom = (at.y + BOX_H) * v.k + v.y;
      let dx = 0;
      let dy = 0;
      if (right > size.w - m) dx = size.w - m - right;
      if (left + dx < m) dx = m - left;
      if (bottom > size.h - 120) dy = size.h - 120 - bottom;
      if (top + dy < 70) dy = 70 - top;
      return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
    });
    // only when the pick changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const toScreen = (p: Pt): Pt => ({ x: p.x * view.k + view.x, y: p.y * view.k + view.y });
  const openMenu = (at: AddAt, title: string, world: Pt) => setMenu({ at, title, pos: toScreen(world) });
  const nameOf = (id: string | null) => (id ? titleOf(stepById(team, id) ?? { action: "" }) : "");
  const menuKinds = menu ? kindsFor(steps.length === 0, menu.at) : [];
  const unscale = Math.min(2, 1 / view.k);

  return (
    <div ref={el} className="absolute inset-0 touch-none select-none overflow-hidden" style={{ backgroundColor: "var(--app)", backgroundImage: "radial-gradient(color-mix(in oklab, var(--ink) 12%, transparent) 1.2px, transparent 1.3px)", backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }} onPointerDown={down} onPointerMove={moveP} onPointerUp={up} onPointerCancel={up} aria-label="Steps chart" role="application">
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }} aria-hidden>
          <defs>
            {(["go", "back"] as const).map((t) => (
              <marker key={t} id={`flow-arrow-${t}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={t === "back" ? "fill-warn" : "fill-faint"} />
              </marker>
            ))}
          </defs>
          {edges.map((l) => (
            <path key={l.key} d={l.d} fill="none" strokeWidth={2} markerEnd={`url(#flow-arrow-${l.tone})`} strokeDasharray={l.tone === "back" ? "6 5" : undefined} className={l.tone === "back" ? "stroke-warn" : "stroke-faint"} />
          ))}
        </svg>

        {steps.length > 0 && (
          <div className="absolute" style={{ left: chip.x, top: chip.y }}>
            <MessageChip />
          </div>
        )}

        {edges
          .filter((l) => l.label)
          .map((l) => (
            <span key={`${l.key}:label`} className={cx("pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-3 py-1 text-[12px]", l.tone === "back" ? "border-line bg-card text-muted" : "border-line bg-panel text-muted")} style={{ left: l.mid.x, top: l.mid.y + (l.tone === "go" ? -16 : 0) }}>
              {l.label}
            </span>
          ))}

        {steps.map((s) => (
          <Box key={s.id} step={s} team={team} at={pos.get(s.id)!} selected={selected === s.id} problem={problems.get(s.id)} dragging={drag?.id === s.id} agents={agents} onKey={() => onSelect(s.id)} />
        ))}

        {/* a + on every arrow, and after the last steps */}
        {edges
          .filter((l) => l.tone === "go")
          .map((l) => (
            <button
              key={`${l.key}:plus`}
              type="button"
              data-ui
              aria-label={l.from ? `Add a step between ${nameOf(l.from)} and ${nameOf(l.to)}` : `Add a step before ${nameOf(l.to)}`}
              onClick={() => openMenu({ between: { from: l.from ? [l.from] : [], to: l.to ? [l.to] : [] } }, l.from ? `Add between ${nameOf(l.from)} and ${nameOf(l.to)}` : `Add before ${nameOf(l.to)}`, l.mid)}
              className="absolute grid size-8 place-items-center rounded-full border border-control-line bg-control text-ink shadow-panel hover:bg-hover"
              style={{ left: l.mid.x - 16, top: l.mid.y - 16, transform: `scale(${unscale})` }}
            >
              <Plus size={15} />
            </button>
          ))}
        {ends.map((s) => {
          const p = pos.get(s.id)!;
          return (
            <button key={`${s.id}:tail`} type="button" data-ui aria-label={`Add a step after ${titleOf(s)}`} onClick={() => openMenu({ after: s.id }, `Add after ${titleOf(s)}`, { x: p.x + BOX_W + 28, y: p.y + BOX_H / 2 })} className="absolute grid size-8 place-items-center rounded-full border border-control-line bg-control text-ink shadow-panel hover:bg-hover" style={{ left: p.x + BOX_W + 12, top: p.y + BOX_H / 2 - 16, transform: `scale(${unscale})`, transformOrigin: "left center" }}>
              <Plus size={15} />
            </button>
          );
        })}
      </div>

      {menu && (
        <div data-ui data-scroll role="menu" aria-label={menu.title} className="absolute z-20 w-[300px] overflow-y-auto rounded-3xl border border-line bg-card p-2 shadow-panel" style={{ left: Math.max(8, Math.min(size.w - 308, menu.pos.x + 12)), top: Math.max(8, Math.min(size.h - (menuKinds.length * 54 + 44) - 8, menu.pos.y - 24)), maxHeight: size.h - 16 }}>
          <div className="px-3 pb-1.5 pt-1 text-xs text-muted">{menu.title}</div>
          {ADD_KINDS.filter((k) => menuKinds.includes(k.kind)).map((k) => (
            <button
              key={k.kind}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onAdd(k.kind, menu.at);
              }}
              className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-hover"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-chip text-ink/85">
                <KindIcon kind={k.kind === "agent" ? "do" : k.kind === "handOut" ? "hand_out" : k.kind === "beside" ? "beside" : k.kind} size={17} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium">{k.title}</span>
                <span className="block text-xs text-muted">{k.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* zoom, top left */}
      <div data-ui className="glass absolute left-4 top-4 flex h-[42px] items-center gap-0.5 rounded-full px-1">
        <button type="button" onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, 1 / 1.2)} className="grid size-[34px] place-items-center rounded-full text-muted hover:text-ink" aria-label="Zoom out">
          <Minus size={16} />
        </button>
        <span className="w-11 text-center text-[13px] tabular-nums text-muted">{Math.round(view.k * 100)}%</span>
        <button type="button" onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, 1.2)} className="grid size-[34px] place-items-center rounded-full text-muted hover:text-ink" aria-label="Zoom in">
          <Plus size={16} />
        </button>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <button type="button" onClick={fit} className="grid size-[34px] place-items-center rounded-full text-muted hover:text-ink" aria-label="Fit the whole chart" title="Fit the whole chart">
          <Maximize2 size={15} />
        </button>
      </div>

      {empty}
    </div>
  );
}

function Box({ step, team, at, selected, problem, dragging, agents, onKey }: { step: TeamStep; team: ChannelTeam; at: Pt; selected: boolean; problem?: string; dragging: boolean; agents: ReturnType<typeof useStore.getState>["agents"]; onKey: () => void }) {
  const agentId = step.agentId || team.roles?.find((r) => r.id === step.roleId)?.agentId || null;
  const agent = agents.find((a) => a.id === agentId);
  const mark = KIND_MARK[step.kind];
  const handoff = useHandoffName(step.handoffTo);
  const n = numberOf(team, step.id);
  const uses = (step.inputs ?? []).length > 1 ? `Uses ${(step.inputs ?? []).map((i) => numberOf(team, i)).sort((a, b) => a - b).join(" and ")}` : null;
  return (
    <div
      data-step={step.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Step ${n}, ${titleOf(step)}${problem ? `. ${problem}` : ""}`}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onKey())}
      className={cx("absolute cursor-grab rounded-[22px] border text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring", dragging && "cursor-grabbing shadow-panel", problem ? "border-bad/40 bg-bad/10" : "border-line bg-card", selected && "border-ink/60 ring-2 ring-ink/25")}
      style={{ left: at.x, top: at.y, width: BOX_W, height: BOX_H }}
    >
      <div className="flex items-start gap-2 px-3.5 pt-3">
        <StepNum n={n} />
        <div className="min-w-0 flex-1">
          {mark && (
            <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-muted">
              <KindIcon kind={step.kind} size={12} />
              <span className="truncate">{mark}</span>
            </div>
          )}
          <div className={cx("line-clamp-2 text-[15px] font-semibold leading-tight", !step.action.trim() && "text-faint")}>{step.action.trim() || "Untitled step"}</div>
        </div>
      </div>
      <div className="absolute inset-x-3.5 bottom-3 flex items-center gap-1.5">
        {step.kind === "ask" ? (
          <>
            <span className="grid size-[22px] place-items-center rounded-full bg-chip text-[10px] font-semibold">YOU</span>
            <span className="text-[13px] text-muted">You</span>
          </>
        ) : step.kind === "handoff" ? (
          <span className="truncate text-[13px] text-muted">{handoff}</span>
        ) : agent ? (
          <>
            <AgentAvatar agent={agent} size={22} interactive={false} />
            <span className="min-w-0 truncate text-[13px] text-muted">{agent.name}</span>
          </>
        ) : (
          <>
            <span className="size-[22px] shrink-0 rounded-full border border-dashed border-bad/60" />
            <span className="text-[13px] text-bad">Pick an agent</span>
          </>
        )}
        {uses && <span className="ml-auto inline-flex h-[22px] shrink-0 items-center rounded-full border border-line bg-panel px-1.5 text-[10.5px] text-muted">{uses}</span>}
      </div>
    </div>
  );
}
