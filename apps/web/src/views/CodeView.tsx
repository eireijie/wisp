import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Maximize2, MessageSquare, PanelLeft, Plus, SquareTerminal } from "lucide-react";
import type { Agent, Team } from "@wisp/core";
import { api } from "../api.ts";
import { href } from "../router.ts";
import { Menu, cx } from "../components/ui.tsx";
import type { ShellTarget } from "../components/TerminalPane.tsx";
import { ShellWorkspace, type OpenRequest } from "../code/ShellWorkspace.tsx";
import { useFeatures } from "../features.ts";
import { useStore, useTeams } from "../store.ts";
import { openDm } from "../openDm.ts";
import { AgentTerminal } from "../code/AgentTerminal.tsx";
import { Between } from "../code/Between.tsx";
import { FlowLive } from "../code/FlowLive.tsx";
import { StartSheet, type Started } from "../code/StartSheet.tsx";
import { Palette, type PaletteItem } from "../code/Palette.tsx";
import { ReviewPanel, branchesOf, type ReviewTab } from "../code/ReviewPanel.tsx";
import { useCodeTasks } from "../code/data.ts";
import { Mini, MOD, StateMark, TeamFaces, isMac } from "../code/parts.tsx";
import { teamState, useAgentStates, type AgentState } from "../code/useTerminal.ts";

/**
 * Code (a mod, on by default): the advanced view of Wisp. The same agents, teams and chats, shown
 * as their terminals. Every agent's runs are drawn as its CLI's terminal; a team shows every
 * member's terminal side by side (or its flow chart) with what they send each other; Shells holds
 * plain terminals on your computers. What you type under a terminal is a chat message, so it
 * shows in Chats too.
 */

type Sel = { kind: "team"; id: string } | { kind: "agent"; id: string } | { kind: "shells" };
type View = "terms" | "flow";

const selKey = (s: Sel) => (s.kind === "shells" ? "shells" : `${s.kind}:${s.id}`);
function parseSel(v: unknown): Sel {
  if (typeof v !== "string") return { kind: "shells" };
  const [kind, id] = v.split(":");
  return (kind === "team" || kind === "agent") && id ? { kind, id } : { kind: "shells" };
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

export function CodeView() {
  const on = useFeatures().code;
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const channels = useStore((s) => s.channels);
  const teams = useTeams();
  const states = useAgentStates();
  const { tasks } = useCodeTasks();
  const tasksVersion = useStore((s) => s.tasksVersion);
  const [targets, setTargets] = useState<ShellTarget[] | null>(null);
  const [sel, setSelRaw] = useState<Sel>(() => parseSel(load("wisp.code.sel", null)));
  const [view, setView] = useState<View>(() => load("wisp.code.view", "terms"));
  const [focus, setFocus] = useState<Record<string, string>>(() => load("wisp.code.focus", {}));
  const [zoom, setZoom] = useState(false);
  const [listOpen, setListOpen] = useState<boolean>(() => load("wisp.code.list", true) && (typeof window === "undefined" || window.innerWidth >= 768));
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  const [sheet, setSheet] = useState<Started | null | false>(false);
  const [palette, setPalette] = useState(false);
  const [review, setReview] = useState(false);
  const [reviewTab, setReviewTab] = useState<ReviewTab>("changes");
  const [openShell, setOpenShell] = useState<OpenRequest | null>(null);

  useEffect(() => {
    const r = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);

  useEffect(() => {
    let gone = false;
    const refresh = () => api<ShellTarget[]>("GET", "/api/terminals").then((t) => !gone && setTargets(t), () => {});
    void refresh();
    const timer = setInterval(refresh, 15_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);

  // whose keyboard is taken (then kept current by the hub's events)
  useEffect(() => {
    api<Record<string, string>>("GET", "/api/keyboard").then((keyboard) => useStore.setState({ keyboard }), () => {});
  }, []);

  useEffect(() => save("wisp.code.sel", selKey(sel)), [sel]);
  useEffect(() => save("wisp.code.view", view), [view]);
  useEffect(() => save("wisp.code.focus", focus), [focus]);
  useEffect(() => {
    if (!narrow) save("wisp.code.list", listOpen);
  }, [listOpen, narrow]);

  const team = sel.kind === "team" ? teams.find((t) => t.id === sel.id) : undefined;
  const agent = sel.kind === "agent" ? agents.find((a) => a.id === sel.id) : undefined;
  // something that's gone (deleted, or not yours to see) falls back to Shells
  useEffect(() => {
    if ((sel.kind === "team" && teams.length && !team) || (sel.kind === "agent" && agents.length && !agent)) setSelRaw({ kind: "shells" });
  }, [sel, team, agent, teams.length, agents.length]);

  // looking at an agent is seeing what it finished
  const seen = useCallback((ids: string[]) => {
    const f = useStore.getState().finished;
    if (ids.some((id) => f[id])) useStore.setState({ finished: Object.fromEntries(Object.entries(f).filter(([id]) => !ids.includes(id))) });
  }, []);
  const members = useMemo(() => (team ? team.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a) : agent ? [agent] : []), [team, agent, agents]);
  const finished = useStore((s) => s.finished);
  useEffect(() => {
    if (members.length) seen(members.map((a) => a.id));
  }, [members, finished, seen]);

  const setSel = useCallback(
    (s: Sel) => {
      setSelRaw(s);
      setZoom(false);
      setReview(false);
      if (narrow) setListOpen(false);
    },
    [narrow],
  );
  const jump = useCallback((agentId: string) => setSel({ kind: "agent", id: agentId }), [setSel]);

  const paneIds = members.map((a) => a.id);
  const k = selKey(sel);
  const focused = paneIds.includes(focus[k] ?? "") ? focus[k]! : (paneIds[0] ?? null);
  const setFocused = useCallback((id: string) => setFocus((f) => ({ ...f, [k]: id })), [k]);

  // a team that codes in a repo: its latest task, for Changes and Files
  const codeTask = useMemo(() => (team ? tasks?.find((t) => t.team.id === team.id && branchesOf(t).length > 0) : undefined), [team, tasks]);

  const order: Sel[] = useMemo(() => [...teams.map((t) => ({ kind: "team" as const, id: t.id })), ...agents.map((a) => ({ kind: "agent" as const, id: a.id })), { kind: "shells" as const }], [teams, agents]);
  const step = useCallback(
    (d: 1 | -1) => {
      const i = order.findIndex((s) => selKey(s) === k);
      setSel(order[(i + d + order.length) % order.length]);
    },
    [order, k, setSel],
  );

  const started = (s: Started) => {
    setSheet(false);
    if (s.kind === "shell") {
      setSel({ kind: "shells" });
      setOpenShell({ computerId: s.computerId, launch: s.launch, n: Date.now() });
    } else setSel(s);
  };

  // the keys: ⌘ shortcuts work everywhere in Code, others stay out of text fields and shells
  const lastEsc = useRef(0);
  useEffect(() => {
    if (!on) return;
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inShell = !!t?.closest(".xterm");
      const typing = !inShell && !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const take = (f: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      };
      // Shells is the tmux-style workspace, with its own split, pane and zoom keys
      const own = sel.kind === "shells" && (e.key.toLowerCase() === "d" || e.key === "Enter" || /^[1-9]$/.test(e.key));
      if (mod && own) return;
      if (mod && !e.shiftKey && !e.altKey) {
        const n = Number(e.key);
        if (n >= 1 && n <= 9 && paneIds[n - 1]) return take(() => setFocused(paneIds[n - 1]));
        switch (e.key.toLowerCase()) {
          case "t":
          case "n":
            return take(() => setSheet(null));
          case "k":
            return take(() => setPalette(true));
          case "b":
            return take(() => setListOpen((v) => !v));
          case "]":
            return take(() => step(1));
          case "[":
            return take(() => step(-1));
          case "i":
            return paneIds.length ? take(() => window.dispatchEvent(new CustomEvent("wisp-code-keyboard", { detail: "talk" }))) : undefined;
          case "enter":
            return paneIds.length > 1 ? take(() => setZoom((z) => !z)) : undefined;
        }
      }
      if (mod && e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "p") return take(() => setPalette(true));
        // take the focused agent's keyboard, or hand it back
        const kb = key === "k" ? "take" : key === "h" ? "back" : null;
        if (kb && paneIds.length) return take(() => window.dispatchEvent(new CustomEvent("wisp-code-keyboard", { detail: kb })));
      }
      if (e.altKey && !mod && !inShell && !typing && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && paneIds.length) {
        const i = paneIds.indexOf(focused ?? "");
        const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        return take(() => setFocused(paneIds[(i + d + paneIds.length) % paneIds.length]));
      }
      // esc twice stops the focused agent's current step
      if (e.key === "Escape" && !typing && !inShell) {
        const now = Date.now();
        if (now - lastEsc.current < 600 && focused) {
          const run = Object.values(useStore.getState().live).find((r) => r.agentId === focused);
          if (run) void api("POST", `/api/runs/${run.runId}/cancel`).catch(() => {});
        }
        lastEsc.current = now;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [on, sel.kind, paneIds, focused, setFocused, step]);

  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [{ id: "start", label: "Start an agent", keys: `${MOD}T`, icon: <Plus size={13} />, run: () => setSheet(null) }];
    members.forEach((a, i) => items.push({ id: `pane:${a.id}`, label: `Go to ${a.name}'s terminal`, keys: `${MOD}${i + 1}`, icon: <Mini agent={a} size={13} />, run: () => setFocused(a.id) }));
    members.forEach((a) => items.push({ id: `talk:${a.id}`, label: `Talk to ${a.name}`, keys: `${MOD}I`, icon: <MessageSquare size={13} />, run: () => (setFocused(a.id), setTimeout(() => window.dispatchEvent(new CustomEvent("wisp-code-keyboard", { detail: "talk" })), 30)) }));
    teams.forEach((t) => items.push({ id: `team:${t.id}`, label: t.name, sub: "team", icon: <TeamFaces agents={t.members.map((m) => agents.find((a) => a.id === m.agentId))} size={13} ring="#16161a" />, run: () => setSel({ kind: "team", id: t.id }) }));
    agents.forEach((a) => items.push({ id: `agent:${a.id}`, label: a.name, sub: "agent", icon: <Mini agent={a} size={13} />, run: () => setSel({ kind: "agent", id: a.id }) }));
    (targets ?? []).forEach((t) => items.push({ id: `sh:${t.id}`, label: `New shell on ${t.name}`, icon: <SquareTerminal size={13} />, run: () => started({ kind: "shell", computerId: t.id }) }));
    items.push({ id: "list", label: listOpen ? "Hide the sidebar" : "Show the sidebar", keys: `${MOD}B`, icon: <PanelLeft size={13} />, run: () => setListOpen((v) => !v) });
    if (members.length > 1) items.push({ id: "zoom", label: zoom ? "Show every terminal" : "Zoom this terminal", keys: `${MOD}↵`, icon: <Maximize2 size={13} />, run: () => setZoom((z) => !z) });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, teams, agents, targets, listOpen, zoom, setFocused, setSel]);

  if (!on)
    return (
      <Empty>
        <p className="text-[13px] text-[#a1a1aa]">Code is turned off.</p>
        <a href={href({ view: "mods" })} className="text-[12.5px] text-[#6aa2ff] hover:text-[#9cc2ff]">
          Mods
        </a>
      </Empty>
    );

  const all = Object.values(states);
  const needsN = all.filter((s) => s === "needs").length;
  const workingN = all.filter((s) => s === "working").length;
  const toggleList = (
    <button type="button" onClick={() => setListOpen((v) => !v)} aria-label={listOpen ? "Hide the sidebar" : "Show the sidebar"} title={`Sidebar  ${MOD}B`} className="-ml-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[.06] hover:text-[#f2f2f4]">
      <PanelLeft size={16} strokeWidth={1.8} />
    </button>
  );
  const whereOf = (a: Agent) => {
    const comp = a.computerId ? computers.find((c) => c.id === a.computerId)?.name : undefined;
    const device = targets?.find((t) => t.kind === "device" && !!t.nodeId && t.nodeId === a.nodeId)?.name;
    return comp ?? device ?? "";
  };
  const roleOf = (a: Agent) => {
    const m = team?.members.find((x) => x.agentId === a.id);
    return m ? (team!.leads.includes(a.id) ? "lead" : (m.role || "").toLowerCase()) : undefined;
  };
  const chatTeam = team ? channels.find((c) => c.id === team.channelId)?.settings.team ?? null : null;
  const shown = zoom && focused ? members.filter((a) => a.id === focused) : members;

  return (
    <div className="relative flex h-full min-h-0 bg-[#0c0c0e] text-[#f2f2f4] max-md:pb-[88px]">
      {listOpen && (
        <>
          {narrow && <div className="m-scrim absolute inset-0 z-20 bg-black/50" onClick={() => setListOpen(false)} />}
          <Sidebar teams={teams} agents={agents} states={states} sel={sel} narrow={narrow} targets={targets} onPick={setSel} onStart={() => setSheet(null)} onShell={(t) => started({ kind: "shell", computerId: t.id })} />
        </>
      )}
      {sel.kind === "shells" ? (
        <main className="flex min-w-0 flex-1 flex-col">
          <ShellWorkspace
            embedded
            open={openShell}
            lead={
              <>
                {toggleList}
                <span className="text-[14px] font-semibold">Shells</span>
              </>
            }
          />
        </main>
      ) : (
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[.06] pl-3 pr-2.5">
            {toggleList}
            <span className="truncate text-[14px] font-semibold">{team?.name ?? agent?.name ?? ""}</span>
            <span className="hidden truncate text-[12px] text-[#8e8e96] sm:inline">{team ? teamSubtitle(team, agents) : agent ? [harness(agent), whereOf(agent)].filter(Boolean).join(" · ") : ""}</span>
            <span className="flex-1" />
            {team && (
              <div role="group" aria-label="View" className="flex gap-0.5 rounded-[7px] bg-[#151518] p-0.5">
                {(["terms", "flow"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} className={cx("h-6 rounded-[5px] px-[9px] text-[12px] transition-colors", view === v ? "bg-[#2a2a2f] text-[#f2f2f4]" : "text-[#a1a1aa] hover:text-[#f2f2f4]")}>
                    {v === "terms" ? "Terminals" : "Flow"}
                  </button>
                ))}
              </div>
            )}
            {codeTask && (
              <>
                <HeadButton on={review && reviewTab === "files"} onClick={() => (setReviewTab("files"), setReview((r) => !(r && reviewTab === "files")))}>
                  Files
                </HeadButton>
                <HeadButton on={review && reviewTab === "changes"} onClick={() => (setReviewTab("changes"), setReview((r) => !(r && reviewTab === "changes")))}>
                  Changes
                  <span className="rounded-lg bg-[#26262b] px-[5px] text-[10.5px] text-[#a1a1aa]">{branchesOf(codeTask).length}</span>
                </HeadButton>
              </>
            )}
            {team ? (
              <a href={href({ view: "chat", channelId: team.channelId, threadId: null })} className="inline-flex h-7 items-center rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-2.5 text-[12.5px] text-[#f2f2f4] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96]">
                Open chat
              </a>
            ) : agent ? (
              <HeadButton on={false} onClick={() => void openDm(agent.id)}>
                Open chat
              </HeadButton>
            ) : null}
          </header>

          <div className="flex min-h-0 flex-1">
            {team && view === "flow" && chatTeam ? (
              <FlowLive team={chatTeam} agents={agents} states={states} onOpen={jump} />
            ) : members.length === 0 ? (
              <Empty>
                <p className="text-[13px] text-[#a1a1aa]">No agents here yet.</p>
              </Empty>
            ) : (
              <div className="grid min-h-0 min-w-0 flex-1 gap-2.5 p-2.5" style={gridStyle(shown.length)}>
                {shown.map((a) => (
                  <AgentTerminal
                    key={`${k}:${a.id}`}
                    agent={a}
                    state={states[a.id] ?? "idle"}
                    role={team ? roleOf(a) : undefined}
                    where={whereOf(a)}
                    focused={focused === a.id}
                    onFocus={() => setFocused(a.id)}
                    onJump={jump}
                    shell={targets?.find((t) => t.kind === "device" && !!t.nodeId && t.nodeId === a.nodeId)}
                  />
                ))}
              </div>
            )}
            {team && <Between key={team.channelId} channelId={team.channelId} onJump={jump} />}
            {review && codeTask && <ReviewPanel key={codeTask.root.id} task={codeTask} tab={reviewTab} setTab={setReviewTab} version={tasksVersion} />}
          </div>

          <footer className="flex h-7 shrink-0 items-center gap-3.5 overflow-x-auto border-t border-white/[.06] bg-[#0f0f11] px-3.5 text-[11.5px] text-[#a1a1aa]">
            <span className="shrink-0">{agents.length === 1 ? "1 agent" : `${agents.length} agents`}</span>
            <span className="shrink-0">{workingN} working</span>
            <span className={cx("shrink-0", needsN > 0 && "text-[#ffb340]")}>{needsN ? `${needsN} need${needsN === 1 ? "s" : ""} you` : "nothing needs you"}</span>
            <span className="flex-1" />
            {!narrow && (
              <>
                <span className="shrink-0">
                  <span className="font-mono text-[#d4d4d8]">{MOD}⇧K</span> take the keyboard
                </span>
                <span className="shrink-0">
                  <span className="font-mono text-[#d4d4d8]">{MOD}K</span> commands
                </span>
              </>
            )}
          </footer>
        </main>
      )}
      {sheet !== false && <StartSheet targets={targets} initial={sheet ?? (team ? { kind: "team", id: team.id } : agent ? { kind: "agent", id: agent.id } : null)} onClose={() => setSheet(false)} onStarted={started} />}
      {palette && <Palette items={paletteItems} onClose={() => setPalette(false)} />}
    </div>
  );
}

const harness = (a: Agent) => ({ codex: "Codex", "claude-code": "Claude Code", gemini: "Gemini CLI" })[a.harness as "codex"] ?? a.harness;

function teamSubtitle(team: Team, agents: Agent[]) {
  const n = team.members.length;
  const lead = team.leadId ? agents.find((a) => a.id === team.leadId)?.name : undefined;
  return `${n === 1 ? "1 agent" : `${n} agents`}${lead ? ` · ${lead} leads` : ""}`;
}

/** Every member side by side: up to three across, four as a square. */
function gridStyle(n: number): CSSProperties {
  if (n <= 1) return { gridTemplateColumns: "minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr)" };
  const cols = n === 4 ? 2 : Math.min(n, 3);
  return { gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gridTemplateRows: `repeat(${Math.ceil(n / cols)}, minmax(0,1fr))` };
}

function HeadButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={cx("inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] transition-[background-color,border-color,transform] active:scale-[.96]", on ? "border-white/[.18] bg-[#2a2a2f]" : "border-white/[.09] bg-[#1d1d21] hover:bg-[#26262b]")}>
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center px-6 pb-16 text-center">
      <div className="m-fade-in flex max-w-[320px] flex-col items-center gap-3">
        <SquareTerminal size={22} strokeWidth={1.6} className="text-[#8e8e96]" />
        {children}
      </div>
    </div>
  );
}

/** Teams, Agents and Shells, each with its live status. */
function Sidebar({ teams, agents, states, sel, narrow, targets, onPick, onStart, onShell }: { teams: Team[]; agents: Agent[]; states: Record<string, AgentState>; sel: Sel; narrow: boolean; targets: ShellTarget[] | null; onPick: (s: Sel) => void; onStart: () => void; onShell: (t: ShellTarget) => void }) {
  const k = selKey(sel);
  const row = (on: boolean) => cx("flex h-8 w-full items-center gap-[9px] rounded-[7px] px-2 text-left transition-colors", on ? "bg-white/[.075]" : "hover:bg-white/[.045]");
  const plus = (label: string, onClick?: () => void) => (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="grid h-7 w-7 place-items-center rounded-[7px] text-[#a1a1aa] transition-colors hover:bg-white/[.07] hover:text-[#f2f2f4]">
      <Plus size={15} strokeWidth={2} />
    </button>
  );
  return (
    <aside aria-label="Teams, agents and shells" className={cx("m-code-list flex w-[248px] shrink-0 flex-col overflow-y-auto border-r border-white/[.06] bg-[#0f0f11]", narrow && "absolute inset-y-0 left-0 z-30 shadow-2xl")}>
      <div className="flex h-11 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-[12px] font-semibold text-[#8e8e96]">Teams</span>
        {plus(`Start  ${MOD}T`, onStart)}
      </div>
      <div className="flex flex-col gap-px px-2">
        {teams.length === 0 && <div className="px-2 pb-1 text-[12px] text-[#71717a]">No teams yet.</div>}
        {teams.map((t) => {
          const st = teamState(t.members.map((m) => states[m.agentId] ?? "idle"));
          return (
            <button key={t.id} type="button" onClick={() => onPick({ kind: "team", id: t.id })} aria-current={k === `team:${t.id}` ? "true" : undefined} className={row(k === `team:${t.id}`)}>
              <span className="flex w-[34px] shrink-0">
                <TeamFaces agents={t.members.map((m) => agents.find((a) => a.id === m.agentId))} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.name}</span>
              <span className={cx("shrink-0 text-[11px]", st === "needs" ? "font-semibold text-[#ffb340]" : "text-[#8e8e96]")}>{st === "needs" ? "Needs you" : st === "working" ? "Working" : st === "done" ? "Done" : "Idle"}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-1.5 flex h-9 shrink-0 items-center border-t border-white/[.05] px-4 pt-3">
        <span className="text-[12px] font-semibold text-[#8e8e96]">Agents</span>
      </div>
      <div className="flex flex-col gap-px px-2">
        {agents.length === 0 && <div className="px-2 pb-1 text-[12px] text-[#71717a]">No agents yet.</div>}
        {agents.map((a) => (
          <button key={a.id} type="button" onClick={() => onPick({ kind: "agent", id: a.id })} aria-current={k === `agent:${a.id}` ? "true" : undefined} className={row(k === `agent:${a.id}`)}>
            <Mini agent={a} size={20} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{a.name}</span>
            <StateMark state={states[a.id] ?? "idle"} />
          </button>
        ))}
      </div>

      <div className="mt-1.5 flex h-9 shrink-0 items-center justify-between border-t border-white/[.05] pl-4 pr-2 pt-3">
        <span className="text-[12px] font-semibold text-[#8e8e96]">Shells</span>
        {targets && targets.length > 0 && (
          <Menu
            align="left"
            trigger={(_, toggle) => plus("New shell", toggle)}
            items={targets.map((t) => ({ label: t.online ? t.name : `${t.name} (offline)`, icon: <SquareTerminal size={15} strokeWidth={1.8} />, onSelect: () => onShell(t) }))}
          />
        )}
      </div>
      <div className="flex flex-col gap-px px-2 pb-3">
        <button type="button" onClick={() => onPick({ kind: "shells" })} aria-current={k === "shells" ? "true" : undefined} className={row(k === "shells")}>
          <span className="w-[18px] text-center font-mono text-[12px] text-[#8e8e96]">$</span>
          <span className="min-w-0 flex-1 truncate text-[13px]">Your shells</span>
          <span className="font-mono text-[11px] text-[#71717a]">{targets ? `${targets.filter((t) => t.online).length} online` : ""}</span>
        </button>
      </div>
    </aside>
  );
}
