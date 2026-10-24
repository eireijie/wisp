import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Crown, Plus, Search, X } from "lucide-react";
import { teamProblem, type Agent, type ChannelTeam, type ChannelTeamNode } from "@wisp/core";
import { useStore } from "../store.ts";
import { AgentAvatar, Input, agentVar, cx } from "./ui.tsx";

const W = 184;
const H = 64;
const GAP = 28;
const ROW = 132;
const PAD = 24;

/** The rules a team chart follows, in the words the chart shows them. */
export const TEAM_RULES = [
  "Leads read every new message in the channel. Everyone else hears only when a lead hands them work or someone @mentions them.",
  "With two or more leads, they talk the request over in its thread and agree on a plan before anyone starts.",
  "Draw an arrow from an agent to whoever it hands work to. Every agent that isn't a lead needs one pointing at it.",
  "Each hand-off opens its own sub-thread, and every agent on the chart knows who else is on the team.",
];

export const EMPTY_TEAM: ChannelTeam = { nodes: [], edges: [] };

/** A free spot on a row of the chart. */
function freeSpot(team: ChannelTeam, row: number): { x: number; y: number } {
  const y = PAD + row * ROW;
  const taken = team.nodes.filter((n) => Math.abs(n.y - y) < H).map((n) => n.x);
  let x = PAD;
  while (taken.some((t) => Math.abs(t - x) < W)) x += W + GAP;
  return { x, y };
}

/**
 * Add an agent to a team: the first one leads; the others get work from the first lead until
 * someone draws different arrows.
 */
export function addToTeam(team: ChannelTeam, agentId: string, at?: { x: number; y: number }): ChannelTeam {
  if (team.nodes.some((n) => n.agentId === agentId)) return team;
  const lead = team.nodes.find((n) => n.lead);
  const spot = at ?? freeSpot(team, lead ? 1 : 0);
  const node: ChannelTeamNode = { agentId, lead: !lead, x: spot.x, y: spot.y };
  return { ...team, nodes: [...team.nodes, node], edges: lead ? [...team.edges, { from: lead.agentId, to: agentId }] : team.edges };
}

/** A cubic curve between two points that leaves `a` heading down, right or left, with its midpoint (for the remove button). */
function bezier(a: { x: number; y: number }, b: { x: number; y: number }, dir: "down" | "right" | "left") {
  const reach = dir === "down" ? Math.max(40, Math.abs(b.y - a.y) / 2) : Math.max(40, Math.abs(b.x - a.x) / 2);
  const c1 = dir === "down" ? { x: a.x, y: a.y + reach } : { x: a.x + (dir === "right" ? reach : -reach), y: a.y };
  const c2 = dir === "down" ? { x: b.x, y: b.y - reach } : { x: b.x - (dir === "right" ? reach : -reach), y: b.y };
  return { d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`, mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 } };
}

/** Would an arrow from `from` to `to` work? Null when it would, else why not. */
function arrowProblem(team: ChannelTeam, from: string, to: string): string | null {
  if (from === to) return "An agent can't hand work to itself.";
  if (team.nodes.find((n) => n.agentId === to)?.lead) return "Leads read every message already, so arrows can't point at a lead.";
  if (team.edges.some((e) => e.from === from && e.to === to)) return null;
  const problem = teamProblem({ ...team, edges: [...team.edges, { from, to }] });
  return problem && /loop/.test(problem) ? "That arrow would make a loop." : null;
}

/**
 * A channel's agent team as a flow chart: drag agents in from the list on the right (or press
 * +), move them around, make some leads, and draw arrows from an agent's handle to whoever it
 * hands work to. `working` marks agents that are busy right now, with where.
 */
export function TeamChart({
  team,
  onChange,
  onCreateAgent,
  working = {},
  readOnly = false,
  height = 420,
}: {
  team: ChannelTeam;
  onChange?: (team: ChannelTeam) => void;
  onCreateAgent?: () => void;
  working?: Record<string, string>;
  readOnly?: boolean;
  height?: number;
}) {
  const agents = useStore((s) => s.agents);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const nodes = team.nodes.filter((n) => byId.has(n.agentId));
  const edges = team.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const live: ChannelTeam = { ...team, nodes, edges };
  const canvas = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ agentId: string; dx: number; dy: number } | null>(null);
  const [link, setLink] = useState<{ from: string; x: number; y: number; moved: boolean } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const set = (next: ChannelTeam) => onChange?.(next);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + canvas.current!.scrollLeft, y: e.clientY - r.top + canvas.current!.scrollTop };
  };
  const connect = (from: string, to: string) => {
    const why = arrowProblem(live, from, to);
    if (why) return setFlash(why);
    if (!edges.some((e) => e.from === from && e.to === to)) set({ ...team, edges: [...team.edges, { from, to }] });
  };

  // drawing an arrow: follow the pointer, and drop it on the agent under it
  useEffect(() => {
    if (!link) return;
    const move = (e: PointerEvent) => setLink((l) => (l ? { ...l, ...point(e), moved: true } : l));
    const up = (e: PointerEvent) => {
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-team-node]")?.dataset.teamNode;
      setLink((l) => {
        if (!l) return l;
        if (target && target !== l.from) {
          connect(l.from, target);
          return null;
        }
        // a click on the handle (no drag): pick the agent with the next click instead
        return l.moved ? null : l;
      });
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setLink(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.from, team]);

  const startMove = (e: ReactPointerEvent, n: ChannelTeamNode) => {
    if (readOnly || (e.target as HTMLElement).closest("button")) return;
    if (link) {
      if (link.from !== n.agentId) connect(link.from, n.agentId);
      setLink(null);
      return;
    }
    const p = point(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ agentId: n.agentId, dx: p.x - n.x, dy: p.y - n.y });
  };
  const move = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = point(e);
    const x = Math.max(8, Math.round(p.x - drag.dx));
    const y = Math.max(8, Math.round(p.y - drag.dy));
    set({ ...team, nodes: team.nodes.map((n) => (n.agentId === drag.agentId ? { ...n, x, y } : n)) });
  };

  const toggleLead = (n: ChannelTeamNode) => {
    const lead = !n.lead;
    set({
      ...team,
      nodes: team.nodes.map((m) => (m.agentId === n.agentId ? { ...m, lead } : m)),
      // a lead reads everything, so nobody hands it work
      edges: lead ? team.edges.filter((e) => e.to !== n.agentId) : team.edges,
    });
  };
  const remove = (agentId: string) => set({ ...team, nodes: team.nodes.filter((n) => n.agentId !== agentId), edges: team.edges.filter((e) => e.from !== agentId && e.to !== agentId) });
  const add = (agentId: string, at?: { x: number; y: number }) => {
    set(addToTeam({ ...team, nodes, edges }, agentId, at));
  };

  const width = Math.max(...nodes.map((n) => n.x + W + PAD), 0);
  const tall = Math.max(height, ...nodes.map((n) => n.y + H + PAD));
  const at = (id: string) => nodes.find((m) => m.agentId === id)!;
  /**
   * An arrow's path: down from the bottom of one card to the top of the next, or, when the next
   * card is beside or above it, out of the side facing it so it doesn't run under other cards.
   */
  const route = (from: { x: number; y: number }, to: { x: number; y: number } | null, point?: { x: number; y: number }) => {
    const a = { x: from.x + W / 2, y: from.y + H };
    if (!to) return bezier(a, point!, "down");
    if (to.y - (from.y + H) >= 24) return bezier(a, { x: to.x + W / 2, y: to.y }, "down");
    const right = to.x > from.x;
    return bezier({ x: right ? from.x + W : from.x, y: from.y + H / 2 }, { x: right ? to.x : to.x + W, y: to.y + H / 2 }, right ? "right" : "left");
  };
  const edgePath = (e: { from: string; to: string }) => route(at(e.from), at(e.to));
  const problem = nodes.length ? teamProblem(live) : null;
  const needle = q.trim().toLowerCase().replace(/^@/, "");
  const listed = agents.filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.handle.includes(needle) || (a.settings.role ?? "").toLowerCase().includes(needle));
  const linking = link ? byId.get(link.from) : undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row rounded-2xl border border-line overflow-hidden bg-panel">
        {/* the chart */}
        <div
          ref={canvas}
          className={cx("relative flex-1 min-w-0 overflow-auto bg-bg", link && "cursor-crosshair")}
          style={{ height, backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
          onDragOver={(e) => !readOnly && e.dataTransfer.types.includes("text/x-warren-agent") && e.preventDefault()}
          onDrop={(e) => {
            const id = e.dataTransfer.getData("text/x-warren-agent");
            if (!id || readOnly) return;
            e.preventDefault();
            const p = point(e);
            add(id, { x: Math.max(8, Math.round(p.x - W / 2)), y: Math.max(8, Math.round(p.y - H / 2)) });
          }}
          onPointerDown={(e) => e.target === e.currentTarget && setLink(null)}
          aria-label="Team chart"
        >
          <div className="relative" style={{ width: width ? `max(100%, ${width}px)` : "100%", height: tall }}>
            <svg className="absolute inset-0 w-full h-full pointer-events-none text-faint" aria-hidden>
              <defs>
                <marker id="team-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {edges.map((e, i) => {
                const c = edgePath(e);
                const busy = !!working[e.from] && !!working[e.to];
                return (
                  <g key={`${e.from}>${e.to}`} className={cx(busy ? "text-ok" : hoverEdge === i ? "text-muted" : "text-faint")}>
                    <path d={c.d} fill="none" stroke="currentColor" strokeWidth={hoverEdge === i ? 2.5 : 2} markerEnd="url(#team-arrow)" strokeDasharray={busy ? "6 5" : undefined} className={busy ? "team-flow" : undefined} />
                    {!readOnly && <path d={c.d} fill="none" stroke="transparent" strokeWidth={16} className="pointer-events-auto cursor-pointer" onPointerEnter={() => setHoverEdge(i)} onPointerLeave={() => setHoverEdge((h) => (h === i ? null : h))} onClick={() => set({ ...team, edges: team.edges.filter((x) => !(x.from === e.from && x.to === e.to)) })} />}
                  </g>
                );
              })}
              {link && link.moved && <path d={route(at(link.from), null, { x: link.x, y: link.y }).d} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="5 5" className="text-accent" />}
            </svg>
            {!readOnly &&
              hoverEdge !== null &&
              edges[hoverEdge] &&
              (() => {
                const { mid } = edgePath(edges[hoverEdge]);
                return (
                  <span className="absolute pointer-events-none size-5 -ml-2.5 -mt-2.5 rounded-full bg-panel border border-line grid place-items-center text-bad" style={{ left: mid.x, top: mid.y }}>
                    <X size={11} strokeWidth={3} />
                  </span>
                );
              })()}

            {nodes.map((n) => {
              const a = byId.get(n.agentId)!;
              const busy = working[n.agentId];
              return (
                <div
                  key={n.agentId}
                  data-team-node={n.agentId}
                  onPointerDown={(e) => startMove(e, n)}
                  onPointerMove={move}
                  onPointerUp={() => setDrag(null)}
                  className={cx(
                    "group absolute rounded-2xl border bg-panel shadow-panel px-2.5 flex items-center gap-2.5 select-none touch-none",
                    !readOnly && (link ? "cursor-pointer" : drag?.agentId === n.agentId ? "cursor-grabbing" : "cursor-grab"),
                    n.lead ? "border-ink/40" : "border-line",
                    link && link.from !== n.agentId && "ring-2 ring-accent/40",
                    busy && "ring-2 ring-ok/50",
                  )}
                  style={{ left: n.x, top: n.y, width: W, height: H, ...agentVar(a) }}
                >
                  <AgentAvatar agent={a} size={34} live={!!busy} interactive={false} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate agent-ink">{a.name}</div>
                    <div className="text-[11px] text-muted truncate">{busy ? <span className="text-ok font-medium">{busy}</span> : n.role?.trim() || a.settings.role?.trim() || `@${a.handle}`}</div>
                  </div>
                  {readOnly ? (
                    n.lead && (
                      <span className="absolute -top-2.5 left-3 h-5 px-1.5 rounded-full bg-ink text-panel text-[10px] font-semibold inline-flex items-center gap-1">
                        <Crown size={10} /> Lead
                      </span>
                    )
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleLead(n)}
                        aria-pressed={n.lead}
                        title={n.lead ? "Lead: reads every new message. Click to make it get work from a lead instead." : "Make it a lead"}
                        className={cx("absolute -top-2.5 left-3 h-5 px-1.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1 border", n.lead ? "bg-ink text-panel border-ink" : "bg-panel text-muted border-line opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100")}
                      >
                        <Crown size={10} /> {n.lead ? "Lead" : "Make lead"}
                      </button>
                      <button type="button" onClick={() => remove(n.agentId)} aria-label={`Take ${a.name} off the team`} className="absolute -top-2 -right-2 size-5 rounded-full bg-panel border border-line grid place-items-center text-muted hover:text-bad opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100 pointer-coarse:size-6">
                        <X size={11} strokeWidth={3} />
                      </button>
                      {/* drag from here to whoever it hands work to (bigger for a finger than for a mouse) */}
                      <button
                        type="button"
                        aria-label={`Draw an arrow from ${a.name} to an agent it hands work to`}
                        title="Drag to the agent it hands work to"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setLink({ from: n.agentId, ...point(e), moved: false });
                        }}
                        className={cx(
                          "absolute left-1/2 -bottom-2 -ml-2 size-4 pointer-coarse:-bottom-3 pointer-coarse:-ml-3 pointer-coarse:size-6 rounded-full border-2 bg-panel hover:scale-125 transition-transform cursor-crosshair", link?.from === n.agentId ? "border-accent bg-accent" : "border-muted")}
                      />
                    </>
                  )}
                </div>
              );
            })}

            {!nodes.length && (
              <div className="absolute inset-0 grid place-items-center p-6 pointer-events-none">
                <p className="max-w-xs text-center text-sm text-muted">{readOnly ? "This channel has no team yet." : "Drag agents here from the list, or press + next to one. The first one leads."}</p>
              </div>
            )}
          </div>
        </div>

        {/* everyone you could put on it */}
        {!readOnly && (
          <aside className="md:w-64 shrink-0 border-t md:border-t-0 md:border-l border-line flex flex-col max-h-72 md:max-h-none" aria-label="Your agents">
            <div className="px-3 pt-3 pb-2 space-y-2">
              <div className="text-sm font-semibold">Your agents</div>
              {agents.length > 6 && (
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an agent" className="h-8 pl-8 text-sm" aria-label="Find an agent" />
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]" style={{ maxHeight: height - 120 }}>
              {!agents.length && <p className="px-1 py-4 text-xs text-muted">No agents yet. Create one below.</p>}
              {agents.length > 0 && !listed.length && <p className="px-1 py-4 text-xs text-muted">No agents match.</p>}
              {listed.map((a) => (
                <AgentRow key={a.id} agent={a} onChart={nodes.some((n) => n.agentId === a.id)} onAdd={() => add(a.id)} />
              ))}
            </div>
            {onCreateAgent && (
              <div className="p-2 border-t border-line">
                <button type="button" onClick={onCreateAgent} className="w-full h-9 rounded-xl bg-chip hover:bg-hover text-sm font-medium inline-flex items-center justify-center gap-1.5">
                  <Plus size={15} /> Create agent
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {linking && <p className="text-xs text-accent-text">Now click the agent {linking.name} hands work to. Esc cancels.</p>}
      {flash && <p className="text-xs text-bad">{flash}</p>}
      {!flash && !linking && problem && <p className="text-xs text-warn">{problem}</p>}
    </div>
  );
}

function AgentRow({ agent, onChart, onAdd }: { agent: Agent; onChart: boolean; onAdd: () => void }) {
  return (
    <div
      draggable={!onChart}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-warren-agent", agent.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      // an agent already on the chart reads muted; not with opacity, which Android's WebView fails to paint around an animated ghost
      className={cx("flex items-center gap-2 rounded-xl px-1.5 py-1.5", onChart ? "text-muted" : "hover:bg-hover cursor-grab")}
      title={onChart ? `${agent.name} is on the chart` : `Drag ${agent.name} onto the chart`}
    >
      <AgentAvatar agent={agent} size={28} interactive={false} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{agent.name}</div>
        <div className="text-[11px] text-muted truncate">{agent.settings.role?.trim() || `@${agent.handle}`}</div>
      </div>
      {onChart ? (
        <span className="text-[11px] text-muted pr-1">Added</span>
      ) : (
        <button type="button" onClick={onAdd} aria-label={`Add ${agent.name} to the team`} className="size-7 rounded-lg grid place-items-center text-muted hover:text-ink hover:bg-chip">
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}

/** The rules, for under the chart. */
export function TeamRules({ className }: { className?: string }) {
  return (
    <ul className={cx("space-y-1 text-xs text-muted list-disc pl-4", className)}>
      {TEAM_RULES.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

/** Take agents that no longer exist off a chart (the hub does the same when an agent goes). */
export function liveTeam(team: ChannelTeam | null, agents: Pick<Agent, "id">[]): ChannelTeam | null {
  if (!team) return null;
  const ids = new Set(agents.map((a) => a.id));
  return { ...team, nodes: team.nodes.filter((n) => ids.has(n.agentId)), edges: team.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

