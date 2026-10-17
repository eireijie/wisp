import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, Crown, GripVertical, LayoutGrid, Plus, UserMinus, X } from "lucide-react";
import type { Agent, TeamMember } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type TeamInfo } from "../store.ts";
import { AgentAvatar, Button, Field, Input, Pill, Textarea, cx } from "./ui.tsx";

const W = 212; // card size on the chart
const H = 64;
const GAP_X = 36;
const GAP_Y = 80;
const PAD = 48;
const TOP = 72; // room for the toolbar above the first row
const ROLE_IDEAS = ["lead", "reviewer", "frontend", "backend", "researcher", "writer", "tester", "designer", "planner"];

type Pos = { x: number; y: number };
type Drag =
  | { kind: "move"; id: string; dx: number; dy: number; from: Pos; moved: boolean }
  | { kind: "link"; from: string; at: Pos }
  | { kind: "add"; agentId: string; client: Pos; start: Pos; moved: boolean };

/** A tidy tree: each subtree is as wide as its leaves, and managers sit centered over their reports. */
export function autoLayout(members: Pick<TeamMember, "agentId" | "managerId">[]): Record<string, Pos> {
  const ids = new Set(members.map((m) => m.agentId));
  const reportsTo = (id: string | null) => members.filter((m) => (id === null ? !m.managerId || !ids.has(m.managerId) : m.managerId === id));
  const out: Record<string, Pos> = {};
  let next = PAD;
  const place = (m: Pick<TeamMember, "agentId">, depth: number): number => {
    out[m.agentId] = { x: 0, y: TOP + depth * (H + GAP_Y) };
    const kids = reportsTo(m.agentId).filter((k) => !out[k.agentId]);
    let x: number;
    if (!kids.length) {
      x = next;
      next += W + GAP_X;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    out[m.agentId].x = x;
    return x;
  };
  for (const r of reportsTo(null)) place(r, 0);
  // anything caught in a loop still gets a spot
  for (const m of members) if (!out[m.agentId]) place(m, 0);
  return out;
}

/** Below everything else, at the next free spot in that row. */
function freeSpot(pos: Record<string, Pos>): Pos {
  const all = Object.values(pos);
  if (!all.length) return { x: PAD, y: TOP };
  const y = Math.max(...all.map((p) => p.y)) + H + GAP_Y;
  return { x: PAD, y };
}

/**
 * The team as a chart you build by hand: drag agents in from the list, drag cards around, draw a
 * line from a card's handle to another card to say who reports to whom, and click a card to give
 * it a role. The card alone at the top is the team's lead.
 */
export function TeamChart({ team, canEdit }: { team: TeamInfo; canEdit: boolean }) {
  const agents = useStore((s) => s.agents);
  const refreshTeams = useStore((s) => s.refreshTeams);
  const board = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState<Record<string, Pos>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<{ node: string } | { edge: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = team.members;
  const auto = useMemo(() => autoLayout(members), [members]);
  const pos = useMemo(() => {
    const out: Record<string, Pos> = {};
    for (const m of members) out[m.agentId] = local[m.agentId] ?? (m.x != null && m.y != null ? { x: m.x, y: m.y } : auto[m.agentId]);
    return out;
  }, [members, local, auto]);
  // saved positions replace what we were showing while a request was in flight
  useEffect(() => setLocal({}), [members]);
  // cards that were never placed get a fixed spot the first time the chart is shown, so they
  // don't shift around whenever someone joins: a tidy tree if nobody's placed, else below the rest
  useEffect(() => {
    if (!canEdit) return;
    const unplaced = members.filter((m) => m.x == null || m.y == null);
    if (!unplaced.length) return;
    const placed: Record<string, Pos> = Object.fromEntries(members.filter((m) => m.x != null && m.y != null).map((m) => [m.agentId, { x: m.x!, y: m.y! }]));
    const spots = Object.keys(placed).length ? (() => {
      const row = freeSpot(placed);
      return Object.fromEntries(unplaced.map((m, i) => [m.agentId, { x: row.x + i * (W + GAP_X), y: row.y }]));
    })() : autoLayout(members);
    void api("PUT", `/api/teams/${team.id}/layout`, { positions: unplaced.map((m) => ({ agentId: m.agentId, ...spots[m.agentId] })) }).then(refreshTeams, () => {});
  }, [members, canEdit, team.id, refreshTeams]);

  const agent = (id: string) => agents.find((a) => a.id === id);
  const onTeam = new Set(members.map((m) => m.agentId));
  const width = Math.max(...Object.values(pos).map((p) => p.x + W + PAD), 0);
  const height = Math.max(...Object.values(pos).map((p) => p.y + H + PAD), 0);

  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refreshTeams();
    } catch (e) {
      setError((e as Error).message);
      setLocal({});
    }
  };
  const putMember = (agentId: string, body: object) => call(() => api("PUT", `/api/teams/${team.id}/members/${agentId}`, body));

  /** Board coordinates of a point on screen. */
  const toBoard = (clientX: number, clientY: number): Pos => {
    const r = board.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  const overBoard = (clientX: number, clientY: number) => {
    const r = scroller.current?.getBoundingClientRect();
    return !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  };
  const nodeAt = (clientX: number, clientY: number) => (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-chart-node]")?.dataset.chartNode ?? null;
  const clamp = (p: Pos): Pos => ({ x: Math.max(0, Math.round(p.x)), y: Math.max(0, Math.round(p.y)) });

  // what's being dragged lives in a ref too, so the window listeners (added the moment the
  // pointer goes down, before React re-renders) always see the latest state
  const dragRef = useRef<Drag | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const setDragNow = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "move") {
      const p = toBoard(e.clientX, e.clientY);
      const next = clamp({ x: p.x - d.dx, y: p.y - d.dy });
      setLocal((l) => ({ ...l, [d.id]: next }));
      setDragNow({ ...d, moved: d.moved || Math.abs(next.x - d.from.x) + Math.abs(next.y - d.from.y) > 4 });
    } else if (d.kind === "link") setDragNow({ ...d, at: toBoard(e.clientX, e.clientY) });
    else setDragNow({ ...d, client: { x: e.clientX, y: e.clientY }, moved: d.moved || Math.abs(e.clientX - d.start.x) + Math.abs(e.clientY - d.start.y) > 4 });
  };
  const onUp = (e: PointerEvent) => {
    onMove(e);
    const d = dragRef.current;
    setDragNow(null);
    if (!d) return;
    if (d.kind === "move") {
      if (!d.moved) return setSelected({ node: d.id });
      const p = toBoard(e.clientX, e.clientY);
      void putMember(d.id, clamp({ x: p.x - d.dx, y: p.y - d.dy }));
    } else if (d.kind === "link") {
      const target = nodeAt(e.clientX, e.clientY);
      if (target && target !== d.from) void putMember(target, { managerId: d.from });
    } else if (d.moved && overBoard(e.clientX, e.clientY)) {
      // dropped on a card: reports to that agent and goes under it; dropped on empty space: right there
      const target = nodeAt(e.clientX, e.clientY);
      const under = target ? posRef.current[target] : undefined;
      const p = toBoard(e.clientX, e.clientY);
      const at = under ? { x: under.x, y: under.y + H + GAP_Y } : { x: p.x - W / 2, y: p.y - H / 2 };
      void putMember(d.agentId, { ...clamp(at), ...(target && target !== d.agentId ? { managerId: target } : {}) });
    }
  };
  const begin = (d: Drag) => {
    setDragNow(d);
    const move = (e: PointerEvent) => onMove(e);
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onUp(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Delete removes a selected line; Escape lets go of whatever is selected
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement).tagName);
      if (e.key === "Escape") setSelected(null);
      if (!typing && canEdit && selected && "edge" in selected && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        void putMember(selected.edge, { managerId: null });
        setSelected(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const startMove = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!canEdit) return setSelected({ node: id });
    const p = toBoard(e.clientX, e.clientY);
    begin({ kind: "move", id, dx: p.x - pos[id].x, dy: p.y - pos[id].y, from: pos[id], moved: false });
  };
  const startLink = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    begin({ kind: "link", from: id, at: toBoard(e.clientX, e.clientY) });
  };
  const startAdd = (e: ReactPointerEvent, agentId: string) => {
    if (!canEdit || e.button !== 0) return;
    e.preventDefault();
    begin({ kind: "add", agentId, client: { x: e.clientX, y: e.clientY }, start: { x: e.clientX, y: e.clientY }, moved: false });
  };
  const addAtFreeSpot = (agentId: string) => {
    void putMember(agentId, { ...freeSpot(pos), ...(team.leadId ? { managerId: team.leadId } : {}) });
  };
  const tidy = () =>
    call(() => api("PUT", `/api/teams/${team.id}/layout`, { positions: Object.entries(autoLayout(members)).map(([agentId, p]) => ({ agentId, ...p })) }));

  const edges = members.filter((m) => m.managerId && pos[m.managerId] && pos[m.agentId]);
  /** A line from manager `a` to report `b`, leaving and entering on the sides that face each other. */
  const curve = (a: Pos, b: Pos) => {
    const below = b.y >= a.y + H + 16;
    const above = b.y + H + 16 <= a.y;
    // [start, end, direction the line travels at each end]
    const [x1, y1, x2, y2, dx, dy] = below
      ? [a.x + W / 2, a.y + H, b.x + W / 2, b.y, 0, 1]
      : above
        ? [a.x + W / 2, a.y, b.x + W / 2, b.y + H, 0, -1]
        : b.x > a.x
          ? [a.x + W, a.y + H / 2, b.x, b.y + H / 2, 1, 0]
          : [a.x, a.y + H / 2, b.x + W, b.y + H / 2, -1, 0];
    const k = Math.max(36, (dy ? Math.abs(y2 - y1) : Math.abs(x2 - x1)) / 2);
    const d = `M ${x1} ${y1} C ${x1 + dx * k} ${y1 + dy * k}, ${x2 - dx * k} ${y2 - dy * k}, ${x2} ${y2}`;
    // the arrowhead points the way the line arrives
    const tip = { x: x2 - dx, y: y2 - dy };
    const head = dy ? `M ${x2 - 6} ${y2 - dy * 9} L ${tip.x} ${tip.y} L ${x2 + 6} ${y2 - dy * 9}` : `M ${x2 - dx * 9} ${y2 - 6} L ${tip.x} ${tip.y} L ${x2 - dx * 9} ${y2 + 6}`;
    return { d, head, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
  };
  const selectedNode = selected && "node" in selected ? members.find((m) => m.agentId === selected.node) : undefined;
  const selectedEdge = selected && "edge" in selected ? members.find((m) => m.agentId === selected.edge) : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col md:flex-row select-none">
      <div className="relative flex-1 min-h-[22rem] min-w-0">
        <div
          ref={scroller}
          className="absolute inset-0 overflow-auto"
          style={{ backgroundImage: "radial-gradient(circle, var(--color-line) 1.2px, transparent 1.2px)", backgroundSize: "22px 22px" }}
          onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}
        >
          <div ref={board} className={cx("relative min-w-full min-h-full", drag && "select-none")} style={{ width, height }} onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
            <svg className="absolute inset-0 pointer-events-none overflow-visible" width={width} height={height}>
              {edges.map((m) => {
                const c = curve(pos[m.managerId!], pos[m.agentId]);
                const on = selectedEdge?.agentId === m.agentId;
                return (
                  <g key={m.agentId} className={on ? "text-accent-text" : "text-muted"}>
                    <path d={c.d} fill="none" stroke="currentColor" strokeWidth={on ? 2.5 : 2} strokeLinecap="round" />
                    <path d={c.head} fill="none" stroke="currentColor" strokeWidth={on ? 2.5 : 2} strokeLinecap="round" strokeLinejoin="round" />
                    {/* a wider invisible line that's easy to click */}
                    <path d={c.d} fill="none" stroke="transparent" strokeWidth={14} className="pointer-events-auto cursor-pointer" onPointerDown={(e) => (e.stopPropagation(), setSelected({ edge: m.agentId }))} />
                  </g>
                );
              })}
              {drag?.kind === "link" && pos[drag.from] && (
                <path d={curve(pos[drag.from], { x: drag.at.x - W / 2, y: drag.at.y }).d} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="6 5" />
              )}
            </svg>

            {selectedEdge && canEdit && pos[selectedEdge.managerId!] && (
              <button
                className="absolute z-20 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-line bg-panel px-2.5 h-7 text-xs shadow-panel hover:text-bad"
                style={{ left: curve(pos[selectedEdge.managerId!], pos[selectedEdge.agentId]).mid.x, top: curve(pos[selectedEdge.managerId!], pos[selectedEdge.agentId]).mid.y }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => (putMember(selectedEdge.agentId, { managerId: null }), setSelected(null))}
              >
                <X size={12} /> Remove line
              </button>
            )}

            {members.map((m) => {
              const a = agent(m.agentId);
              const p = pos[m.agentId];
              if (!p) return null;
              const isSel = selectedNode?.agentId === m.agentId;
              const isTarget = drag?.kind === "link" && drag.from !== m.agentId;
              return (
                <div
                  key={m.agentId}
                  data-chart-node={m.agentId}
                  className={cx(
                    "group absolute rounded-xl border bg-panel shadow-sm flex items-center gap-2.5 px-3 touch-none",
                    canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    isSel ? "border-accent ring-2 ring-accent-soft" : isTarget ? "border-accent/60" : "border-line hover:border-muted",
                    drag?.kind === "move" && drag.id === m.agentId && "shadow-panel z-10",
                  )}
                  style={{ left: p.x, top: p.y, width: W, height: H }}
                  onPointerDown={(e) => startMove(e, m.agentId)}
                >
                  <AgentAvatar agent={a} size={36} badge={false} live />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 font-medium truncate">
                      {team.leadId === m.agentId && <Crown size={13} className="text-accent-text shrink-0" aria-label="Lead" />}
                      <span className="truncate">{a?.name ?? "Agent"}</span>
                    </div>
                    <div className="text-xs text-muted truncate">{m.role ? m.role : canEdit ? <span className="text-faint">Click to add a role</span> : `@${a?.handle}`}</div>
                  </div>
                  {canEdit && (
                    <button
                      className="absolute left-1/2 -bottom-2.5 -translate-x-1/2 size-5 rounded-full border-2 border-accent bg-panel opacity-0 group-hover:opacity-100 focus:opacity-100 hover:scale-110 transition cursor-crosshair touch-none max-md:opacity-100"
                      title="Drag to a card: that agent reports to this one"
                      aria-label={`Draw a line from ${a?.name}`}
                      onPointerDown={(e) => startLink(e, m.agentId)}
                    />
                  )}
                </div>
              );
            })}

            {members.length === 0 && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center pointer-events-none">
                <div className="max-w-sm space-y-2 text-sm text-muted">
                  <div className="text-base font-medium text-ink">Drag agents here</div>
                  <p>Drop agents from the list onto the chart. The first one leads the team. Draw a line from a card's bottom handle to another card to say who reports to whom, and click a card to give it a role.</p>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="absolute right-3 top-3 flex gap-2">
          {canEdit && members.length > 1 && (
            <Button className="h-8 shadow-sm" onClick={tidy} title="Arrange the cards as a tree">
              <LayoutGrid size={14} /> Tidy up
            </Button>
          )}
        </div>
        {error && (
          <div className="absolute left-3 bottom-3 right-3 sm:right-auto max-w-md rounded-lg border border-bad/30 bg-panel px-3 py-2 text-sm text-bad shadow-panel flex items-start gap-2">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      <aside className="w-full md:w-72 shrink-0 border-t md:border-t-0 md:border-l border-line flex flex-col max-h-[45vh] md:max-h-none">
        {selectedNode ? (
          <Inspector key={selectedNode.agentId} team={team} member={selectedNode} agent={agent(selectedNode.agentId)} canEdit={canEdit} onClose={() => setSelected(null)} onSave={(body) => putMember(selectedNode.agentId, body)} onCall={call} />
        ) : (
          <>
            <div className="px-4 pt-3 pb-2">
              <div className="text-sm font-semibold">Agents</div>
              <p className="text-xs text-muted">{canEdit ? "Drag one onto the chart, or tap + to add it." : "Who's on this team."}</p>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
              {agents.map((a) => (
                <AgentCard key={a.id} agent={a} on={onTeam.has(a.id)} canEdit={canEdit} onPointerDown={(e) => !onTeam.has(a.id) && startAdd(e, a.id)} onAdd={() => addAtFreeSpot(a.id)} onSelect={() => setSelected({ node: a.id })} />
              ))}
              {agents.length === 0 && (
                <p className="text-sm text-muted px-1">
                  No agents yet.{" "}
                  <a className="text-accent-text hover:underline" href="#/agents">
                    Add one
                  </a>
                </p>
              )}
            </div>
          </>
        )}
      </aside>

      {drag?.kind === "add" && drag.moved && (
        <div className="fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-1/2 rounded-xl border border-accent bg-panel shadow-panel px-3 flex items-center gap-2.5 opacity-90" style={{ left: drag.client.x, top: drag.client.y, width: W, height: H }}>
          <AgentAvatar agent={agent(drag.agentId)} size={36} badge={false} live />
          <span className="font-medium truncate">{agent(drag.agentId)?.name}</span>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, on, canEdit, onPointerDown, onAdd, onSelect }: { agent: Agent; on: boolean; canEdit: boolean; onPointerDown: (e: ReactPointerEvent) => void; onAdd: () => void; onSelect: () => void }) {
  return (
    <div
      className={cx("flex items-center gap-2 rounded-xl border px-2 h-12 touch-none", on ? "border-line bg-hover/60" : "border-line bg-panel", !on && canEdit && "cursor-grab hover:border-muted")}
      onPointerDown={onPointerDown}
      onClick={on ? onSelect : undefined}
    >
      {!on && canEdit && <GripVertical size={14} className="text-faint shrink-0" />}
      <AgentAvatar agent={agent} size={30} badge={false} live />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{agent.name}</div>
        <div className="text-xs text-muted truncate">@{agent.handle}</div>
      </div>
      {on ? (
        <Pill tone="ok">on team</Pill>
      ) : (
        canEdit && (
          <button onPointerDown={(e) => e.stopPropagation()} onClick={onAdd} className="p-1.5 rounded-md text-muted hover:text-ink hover:bg-hover" aria-label={`Add @${agent.handle} to the team`} title="Add to the team">
            <Plus size={15} />
          </button>
        )
      )}
    </div>
  );
}

/** Role, role notes and who it reports to, for the card you clicked. */
function Inspector({
  team,
  member,
  agent,
  canEdit,
  onClose,
  onSave,
  onCall,
}: {
  team: TeamInfo;
  member: TeamMember;
  agent: Agent | undefined;
  canEdit: boolean;
  onClose: () => void;
  onSave: (body: object) => Promise<void>;
  onCall: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const agents = useStore((s) => s.agents);
  const [role, setRole] = useState(member.role);
  const [notes, setNotes] = useState(member.roleNotes);
  useEffect(() => {
    setRole(member.role);
    setNotes(member.roleNotes);
  }, [member.role, member.roleNotes]);
  const dirty = role !== member.role || notes !== member.roleNotes;
  // anyone on the team except itself and the agents under it
  const below = new Set<string>([member.agentId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of team.members) if (m.managerId && below.has(m.managerId) && !below.has(m.agentId)) (below.add(m.agentId), (grew = true));
  }
  const managers = team.members.filter((m) => !below.has(m.agentId));
  const handle = (id: string) => agents.find((a) => a.id === id)?.handle ?? "agent";
  const lead = team.leadId === member.agentId;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <button onClick={onClose} className="text-xs text-muted hover:text-ink inline-flex items-center gap-1">
        <ArrowLeft size={13} /> All agents
      </button>
      <div className="flex items-center gap-3">
        <AgentAvatar agent={agent} size={44} live />
        <div className="min-w-0">
          <div className="font-semibold truncate flex items-center gap-1.5">
            {agent?.name}
            {lead && (
              <Pill tone="accent">
                <Crown size={11} /> lead
              </Pill>
            )}
          </div>
          <a href={`#/agents/${member.agentId}/overview`} className="text-xs text-accent-text hover:underline">
            @{agent?.handle}
          </a>
        </div>
      </div>
      <Field label="Role">
        <Input value={role} disabled={!canEdit} onChange={(e) => setRole(e.target.value)} placeholder="e.g. reviewer" list="role-ideas" />
        <datalist id="role-ideas">
          {ROLE_IDEAS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </Field>
      {canEdit && (
        <div className="flex flex-wrap gap-1 -mt-2">
          {ROLE_IDEAS.filter((r) => r !== role && r !== "lead").slice(0, 6).map((r) => (
            <button key={r} onClick={() => setRole(r)} className="rounded-full bg-hover px-2 h-6 text-xs text-muted hover:text-ink">
              {r}
            </button>
          ))}
        </div>
      )}
      <Field label="What the role means" hint="Goes into this agent's prompt on this team.">
        <Textarea rows={3} value={notes} disabled={!canEdit} onChange={(e) => setNotes(e.target.value)} placeholder="Review every change before it merges; don't write features." />
      </Field>
      {canEdit && dirty && (
        <div className="flex gap-2">
          <Button variant="primary" className="h-8" onClick={() => onSave({ role: role.trim(), roleNotes: notes })}>
            Save role
          </Button>
          <Button variant="ghost" className="h-8" onClick={() => (setRole(member.role), setNotes(member.roleNotes))}>
            Discard
          </Button>
        </div>
      )}
      <Field label="Reports to" hint="Same as drawing a line to this card.">
        <select
          value={member.managerId ?? ""}
          disabled={!canEdit}
          onChange={(e) => onSave({ managerId: e.target.value || null })}
          className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm"
        >
          <option value="">No one (top of the chart)</option>
          {managers.map((m) => (
            <option key={m.agentId} value={m.agentId}>
              @{handle(m.agentId)}
            </option>
          ))}
        </select>
      </Field>
      {canEdit && (
        <div className="space-y-2 pt-1">
          {!lead && (
            <Button className="w-full" onClick={() => onCall(() => api("PATCH", `/api/teams/${team.id}`, { leadId: member.agentId }))}>
              <Crown size={14} /> Make lead
            </Button>
          )}
          <Button
            variant="danger"
            className="w-full"
            onClick={() => confirm(`Take @${agent?.handle} off ${team.name}? Anyone who reports to it moves up a level.`) && onCall(() => api("DELETE", `/api/teams/${team.id}/members/${member.agentId}`)).then(onClose)}
          >
            <UserMinus size={14} /> Remove from team
          </Button>
        </div>
      )}
    </div>
  );
}
