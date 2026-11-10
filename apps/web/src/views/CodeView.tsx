import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Columns2, Maximize2, MessageSquare, PanelLeft, Plus, SquareTerminal } from "lucide-react";
import { api } from "../api.ts";
import { href } from "../router.ts";
import { Menu, agentColor, cx, timeAgo } from "../components/ui.tsx";
import { TerminalPane, type ShellTarget } from "../components/TerminalPane.tsx";
import { ShellWorkspace } from "../code/ShellWorkspace.tsx";
import { useFeatures } from "../features.ts";
import { useStore } from "../store.ts";
import { AgentPane, GhostIcon, STATE_COLOR } from "../code/AgentPane.tsx";
import { NewTaskSheet } from "../code/NewTaskSheet.tsx";
import { Palette, type PaletteItem } from "../code/Palette.tsx";
import { ReviewPanel, branchesOf, type ReviewTab } from "../code/ReviewPanel.tsx";
import { groupTasks, paneState, repoName, useCodeTasks, type CodeTask } from "../code/data.ts";

/**
 * Code (a mod, on by default): a terminal workspace for coding tasks, in the spirit of tmux.
 * The task list on the left is like tmux's sessions; a task's panes are its agents, each drawn as
 * its own terminal, plus shells you open beside them. "Shells" holds plain terminals on your
 * computers. What's open is remembered on this browser.
 */

interface Shell {
  key: string;
  computerId: string;
  session: string;
}

type Layout = "main" | "cols" | "zoom";
const SHELLS = "shells";
/** at most this many shells per task (or in Shells), so it never gets crowded */
const MAX_SHELLS = 4;

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

/** A shell name nobody else's pane on that computer uses: a stem and a number. */
function newSession(stem: string, computerId: string, all: Shell[]) {
  const s = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-")[0] || "shell";
  const taken = new Set(all.filter((p) => p.computerId === computerId).map((p) => p.session));
  let n = 1;
  while (taken.has(`${s}-${n}`)) n++;
  return `${s}-${n}`;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl ";

export function CodeView() {
  const on = useFeatures().code;
  const agents = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals);
  const live = useStore((s) => s.live);
  const { tasks, error } = useCodeTasks();
  const [targets, setTargets] = useState<ShellTarget[] | null>(null);
  const [selected, setSelected] = useState<string>(() => load("wisp.code.task", SHELLS));
  // shells opened beside a task's agents; Shells itself is the tmux-style workspace (ShellWorkspace), stored on its own
  const [shells, setShells] = useState<Record<string, Shell[]>>(() => {
    const { [SHELLS]: _plain, ...rest } = load<Record<string, Shell[]>>("wisp.code.shells", {});
    return rest;
  });
  const [focus, setFocus] = useState<Record<string, string>>(() => load("wisp.code.focus", {}));
  const [layout, setLayout] = useState<Layout>(() => load("wisp.code.layout", "main"));
  // on a phone the list opens over the panes, so it starts closed
  const [listOpen, setListOpen] = useState<boolean>(() => load("wisp.code.list", true) && (typeof window === "undefined" || window.innerWidth >= 768));
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  const [talking, setTalking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  const [picker, setPicker] = useState(0);
  const [review, setReview] = useState(false);
  const [reviewTab, setReviewTab] = useState<ReviewTab>("changes");
  const tasksVersion = useStore((s) => s.tasksVersion);
  // on a smaller screen the task list makes way for Review, so the panes keep their room
  useEffect(() => {
    if (review && window.innerWidth < 1280) setListOpen(false);
  }, [review]);

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

  useEffect(() => save("wisp.code.task", selected), [selected]);
  useEffect(() => {
    save("wisp.code.shells", shells);
  }, [shells]);
  useEffect(() => save("wisp.code.focus", focus), [focus]);
  useEffect(() => save("wisp.code.layout", layout), [layout]);
  useEffect(() => {
    if (!narrow) save("wisp.code.list", listOpen);
  }, [listOpen, narrow]);

  const task = tasks?.find((t) => t.root.id === selected) ?? null;
  // a task that's gone (deleted, or Code lost access) falls back to Shells
  useEffect(() => {
    if (tasks && selected !== SHELLS && !task) setSelected(SHELLS);
  }, [tasks, selected, task]);

  const allShells = useMemo(() => Object.values(shells).flat(), [shells]);
  const myShells = (shells[selected] ?? []).flatMap((s) => {
    const target = targets?.find((t) => t.id === s.computerId);
    return target ? [{ ...s, target }] : [];
  });

  // the panes, in order: a task's agents, then its shells
  const taskAgents = task ? task.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a) : [];
  const paneIds = [...taskAgents.map((a) => a.id), ...myShells.map((s) => s.key)];
  const focused = paneIds.includes(focus[selected] ?? "") ? focus[selected]! : (paneIds[0] ?? null);
  const setFocused = useCallback((id: string) => setFocus((f) => ({ ...f, [selected]: id })), [selected]);
  const effLayout: Layout = narrow ? "zoom" : layout;

  const addShell = useCallback(
    (target: ShellTarget, stem?: string) => {
      const list = shells[selected] ?? [];
      if (list.length >= MAX_SHELLS) return;
      const s: Shell = { key: crypto.randomUUID(), computerId: target.id, session: newSession(stem ?? target.name, target.id, allShells) };
      setShells((all) => ({ ...all, [selected]: [...(all[selected] ?? []), s] }));
      setFocused(s.key);
    },
    [shells, selected, allShells, setFocused],
  );
  const removeShell = (key: string) => setShells((all) => ({ ...all, [selected]: (all[selected] ?? []).filter((s) => s.key !== key) }));

  /** ⌘D: a shell beside the focused agent, on its computer; in Shells, the menu of computers */
  const split = useCallback(() => {
    const agent = taskAgents.find((a) => a.id === focused) ?? taskAgents[0];
    const target = agent?.computerId ? targets?.find((t) => t.id === agent.computerId) : undefined;
    if (task && target) return addShell(target, task.root.title);
    if (targets?.length === 1) return addShell(targets[0]);
    setPicker((n) => n + 1);
  }, [taskAgents, focused, targets, task, addShell]);

  const tasksInOrder = useMemo(() => (tasks ? groupTasks(tasks).flatMap((g) => g.tasks) : []), [tasks]);
  const stepTask = useCallback(
    (d: 1 | -1) => {
      const ids = [SHELLS, ...tasksInOrder.map((t) => t.root.id)];
      const i = ids.indexOf(selected);
      setSelected(ids[(i + d + ids.length) % ids.length]);
      setTalking(false);
    },
    [tasksInOrder, selected],
  );

  // the keys from the design; ⌘ shortcuts work everywhere in Code, others stay out of text fields and shells
  const lastEsc = useRef(0);
  useEffect(() => {
    if (!on) return;
    const k = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const t = e.target as HTMLElement | null;
      const inShell = !!t?.closest(".xterm");
      const typing = !inShell && !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const take = (f: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      };
      // Shells is the tmux-style workspace, which has its own split, pane and zoom keys
      const own = !task && (e.key.toLowerCase() === "d" || e.key === "Enter" || /^[1-9]$/.test(e.key));
      if (mod && own) return;
      if (mod && !e.shiftKey && !e.altKey) {
        const n = Number(e.key);
        if (n >= 1 && n <= 9 && paneIds[n - 1]) return take(() => setFocused(paneIds[n - 1]));
        switch (e.key.toLowerCase()) {
          case "k":
            return take(() => setPalette(true));
          case "n":
            return take(() => setSheet(true));
          case "b":
            return take(() => setListOpen((v) => !v));
          case "]":
            return take(() => stepTask(1));
          case "[":
            return take(() => stepTask(-1));
          case "d":
            return take(split);
          case "i":
            return task && taskAgents.some((a) => a.id === focused) ? take(() => setTalking(true)) : undefined;
          case "enter":
            return take(() => setLayout((l) => (l === "zoom" ? "main" : "zoom")));
        }
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "d") return take(split);
      if (mod && e.shiftKey && task) {
        const n = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
        if (n >= 0) return take(() => (setReview(true), setReviewTab((["changes", "files", "checks"] as const)[n])));
        // take the focused agent's keyboard, or hand it back
        const kb = e.key.toLowerCase() === "k" ? "take" : e.key.toLowerCase() === "h" ? "back" : null;
        if (kb) return take(() => window.dispatchEvent(new CustomEvent("wisp-code-keyboard", { detail: kb })));
        const act = e.key.toLowerCase() === "b" ? "back" : e.key.toLowerCase() === "m" ? "merge" : null;
        if (act)
          return take(() => {
            setReview(true);
            setReviewTab("changes");
            // the panel may be opening: let it mount before it hears what to do
            setTimeout(() => window.dispatchEvent(new CustomEvent("wisp-code-review", { detail: act })), 50);
          });
      }
      if (e.altKey && !mod && !inShell && !typing && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const i = paneIds.indexOf(focused ?? "");
        const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        if (paneIds.length) return take(() => setFocused(paneIds[(i + d + paneIds.length) % paneIds.length]));
      }
      if (e.altKey && !mod && (e.key === "1" || e.key === "2" || e.code === "Digit1" || e.code === "Digit2") && !inShell && !typing) return take(() => setLayout(e.code === "Digit2" || e.key === "2" ? "cols" : "main"));
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
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [on, paneIds, focused, setFocused, stepTask, split, task, taskAgents]);

  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [];
    taskAgents.forEach((a, i) => items.push({ id: `pane:${a.id}`, label: `Go to ${a.name}'s pane`, sub: task?.root.title, keys: `${MOD}${i + 1}`, icon: <GhostIcon color={agentColor(a)} size={13} />, run: () => setFocused(a.id) }));
    taskAgents.forEach((a) => items.push({ id: `talk:${a.id}`, label: `Talk to ${a.name}`, keys: `${MOD}I`, icon: <MessageSquare size={13} />, run: () => (setFocused(a.id), setTalking(true)) }));
    taskAgents.forEach((a) => {
      const t = a.computerId ? targets?.find((x) => x.id === a.computerId) : undefined;
      if (t) items.push({ id: `shell:${a.id}`, label: `Open a shell on ${a.name}'s computer`, sub: t.name, icon: <SquareTerminal size={13} />, run: () => addShell(t, task?.root.title) });
    });
    items.push({ id: "new", label: "New task", keys: `${MOD}N`, icon: <Plus size={13} />, run: () => setSheet(true) });
    if (task) (targets ?? []).forEach((t) => items.push({ id: `sh:${t.id}`, label: `New shell on ${t.name}`, icon: <SquareTerminal size={13} />, run: () => addShell(t) }));
    items.push({ id: "shells", label: "Shells", sub: "plain terminals on your computers", icon: <SquareTerminal size={13} />, run: () => setSelected(SHELLS) });
    (tasks ?? []).forEach((t) => items.push({ id: `task:${t.root.id}`, label: t.root.title, sub: repoName(t.team.repo), icon: <span className="h-[7px] w-[7px] rounded-full" style={{ background: STATE_COLOR[t.state] }} />, run: () => setSelected(t.root.id) }));
    items.push({ id: "list", label: listOpen ? "Hide the task list" : "Show the task list", keys: `${MOD}B`, icon: <PanelLeft size={13} />, run: () => setListOpen((v) => !v) });
    items.push({ id: "zoom", label: layout === "zoom" ? "Show all panes" : "Zoom this pane", keys: `${MOD}↵`, icon: <Maximize2 size={13} />, run: () => setLayout((l) => (l === "zoom" ? "main" : "zoom")) });
    return items;
  }, [taskAgents, task, targets, tasks, listOpen, layout, setFocused, addShell]);

  if (!on)
    return (
      <Empty>
        <p className="text-[13px] text-[#a1a1aa]">Code is turned off.</p>
        <a href={href({ view: "mods" })} className="text-[12.5px] text-[#6aa2ff] hover:text-[#9cc2ff]">
          Mods
        </a>
      </Empty>
    );

  const needs = task ? taskAgents.filter((a) => paneState(task, a.id, approvals, Object.values(live).some((r) => r.agentId === a.id)) === "needs").length : 0;
  const showList = listOpen;

  return (
    <div className="relative flex h-full min-h-0 bg-[#0c0c0e] text-[#f2f2f4] max-md:pb-[88px]">
      {showList && (
        <>
          {narrow && <div className="m-scrim absolute inset-0 z-20 bg-black/50" onClick={() => setListOpen(false)} />}
          <TaskList
            tasks={tasks}
            error={error}
            selected={selected}
            narrow={narrow}
            onPick={(id) => {
              setSelected(id);
              setTalking(false);
              if (narrow) setListOpen(false);
            }}
            onNew={() => setSheet(true)}
          />
        </>
      )}
      {!task ? (
        <main className="flex min-w-0 flex-1 flex-col">
          <ShellWorkspace
            embedded
            lead={
              <>
                <button type="button" onClick={() => setListOpen((v) => !v)} aria-label={showList ? "Hide the task list" : "Show the task list"} title={`Tasks  ${MOD}B`} className="-ml-1.5 grid h-8 w-8 place-items-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[.06] hover:text-[#f2f2f4]">
                  <PanelLeft size={16} strokeWidth={1.8} />
                </button>
                <span className="text-[14px] font-semibold">Shells</span>
              </>
            }
          />
        </main>
      ) : (
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-white/[.06] pl-3 pr-3">
          <button type="button" onClick={() => setListOpen((v) => !v)} aria-label={showList ? "Hide the task list" : "Show the task list"} title={`Tasks  ${MOD}B`} className="grid h-8 w-8 place-items-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[.06] hover:text-[#f2f2f4]">
            <PanelLeft size={16} strokeWidth={1.8} />
          </button>
          <span className="truncate text-[14px] font-semibold">{task ? task.root.title : "Shells"}</span>
          {task && <span className="hidden truncate font-mono text-[11.5px] text-[#8e8e96] sm:inline">{repoName(task.team.repo)}</span>}
          <span className="flex-1" />
          {!narrow && paneIds.length > 1 && (
            <div role="group" aria-label="Layout" className="flex gap-0.5">
              {(
                [
                  ["main", "Main and stack  ⌥1", <MainIcon key="m" />],
                  ["cols", "Side by side  ⌥2", <Columns2 key="c" size={15} strokeWidth={1.8} />],
                  ["zoom", `Zoom  ${MOD}↵`, <Maximize2 key="z" size={14} strokeWidth={1.8} />],
                ] as const
              ).map(([id, label, icon]) => (
                <button key={id} type="button" onClick={() => setLayout(id)} aria-pressed={layout === id} aria-label={label} title={label} className={cx("grid h-6 w-7 place-items-center rounded-[5px] transition-colors", layout === id ? "bg-[#2a2a2f] text-[#f2f2f4]" : "text-[#a1a1aa] hover:text-[#f2f2f4]")}>
                  {icon}
                </button>
              ))}
            </div>
          )}
          {task && branchesOf(task).length > 0 && (
            <button type="button" onClick={() => setReview((v) => !v)} aria-pressed={review} title={`Review  ${MOD}⇧1`} className={cx("inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] transition-[background-color,border-color,transform] active:scale-[.96]", review ? "border-white/[.18] bg-[#2a2a2f]" : "border-white/[.09] bg-[#1d1d21] hover:bg-[#26262b]")}>
              Review
            </button>
          )}
          {targets && targets.length > 0 && (myShells.length < MAX_SHELLS) && (
            <ShellMenu key={picker} open={picker > 0} targets={targets} onPick={(t) => addShell(t, task?.root.title)} label={task ? "Shell" : "New shell"} />
          )}
        </header>

        {paneIds.length === 0 ? (
          <Empty>
            {task ? (
              <p className="text-[13px] text-[#a1a1aa]">No agent has picked this up yet.</p>
            ) : targets === null ? (
              <p className="text-[12.5px] text-[#8e8e96]">Loading…</p>
            ) : targets.length === 0 ? (
              <>
                <p className="text-[13px] text-[#a1a1aa]">No computers of yours to open a terminal on.</p>
                <a href={href({ view: "computers", computerId: null })} className="text-[12.5px] text-[#6aa2ff] hover:text-[#9cc2ff]">
                  Computers
                </a>
              </>
            ) : (
              <p className="text-[13px] text-[#a1a1aa]">A shell on one of your computers.</p>
            )}
          </Empty>
        ) : (
          <div className="grid min-h-0 flex-1 gap-2.5 p-2.5" style={gridStyle(effLayout, paneIds.length)}>
            {paneIds.map((id, i) => {
              const place = placeOf(effLayout, id, focused, paneIds, i);
              if (!place) return null;
              const agent = taskAgents.find((a) => a.id === id);
              if (agent && task)
                return <AgentPane key={`${task.root.id}:${id}`} task={task} agent={agent} focused={focused === id} onFocus={() => setFocused(id)} talking={talking} setTalking={setTalking} style={place} shell={targets?.find((t) => t.kind === "device" && !!t.nodeId && t.nodeId === agent.nodeId)} />;
              const s = myShells.find((x) => x.key === id)!;
              return (
                <div key={id} style={place} className="grid min-h-0 min-w-0">
                  <TerminalPane target={s.target} session={s.session} focused={focused === id} onFocus={() => setFocused(id)} onClose={() => removeShell(id)} />
                </div>
              );
            })}
          </div>
        )}

        {/* a tmux-style status line: the task, its panes, and what needs you */}
        {(task || paneIds.length > 0) && (
          <footer className="flex h-[26px] shrink-0 items-center gap-0.5 overflow-x-auto border-t border-white/[.06] bg-[#121215] px-2 font-mono text-[11.5px] text-[#a1a1aa]">
            <span className="mr-2 shrink-0 rounded-[3px] bg-[#26262b] px-2 py-px font-semibold text-[#f2f2f4]">{task ? statusName(task) : "shells"}</span>
            {paneIds.map((id, i) => {
              const a = taskAgents.find((x) => x.id === id);
              const st = a && task ? paneState(task, a.id, approvals, Object.values(live).some((r) => r.agentId === a.id)) : null;
              const name = a ? a.name.toLowerCase() : (myShells.find((x) => x.key === id)?.session ?? "shell");
              return (
                <button key={id} type="button" onClick={() => setFocused(id)} className={cx("shrink-0 rounded-[3px] px-[7px] py-px transition-colors", id === focused ? "bg-[#26262b] text-[#f2f2f4]" : st === "needs" ? "text-[#ffb340]" : "hover:text-[#f2f2f4]")}>
                  {i + 1}:{name}
                  {id === focused ? "*" : ""}
                  {st === "needs" ? " !" : ""}
                </button>
              );
            })}
            <span className="flex-1" />
            {task && <span className={cx("shrink-0", needs > 0 && "text-[#ffb340]")}>{needs === 1 ? "1 needs you" : `${needs} need you`}</span>}
            {!narrow && <span className="ml-3 shrink-0 text-[#6b6b75]">{MOD}K</span>}
          </footer>
        )}
      </main>
      )}
      {review && task && <ReviewPanel key={task.root.id} task={task} tab={reviewTab} setTab={setReviewTab} version={tasksVersion} />}
      {sheet && <NewTaskSheet onClose={() => setSheet(false)} onStarted={(id) => (setSheet(false), id && setSelected(id))} />}
      {palette && <Palette items={paletteItems} onClose={() => setPalette(false)} />}
    </div>
  );
}

function statusName(task: CodeTask) {
  return task.root.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 2).join("-") || "task";
}

function MainIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16M12 12h9" />
    </svg>
  );
}

function gridStyle(layout: Layout, n: number): CSSProperties {
  if (layout === "zoom" || n === 1) return { gridTemplateColumns: "minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr)" };
  if (layout === "cols") {
    const cols = Math.min(n, 3);
    return { gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gridTemplateRows: `repeat(${Math.ceil(n / cols)}, minmax(0,1fr))` };
  }
  return { gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gridTemplateRows: `repeat(${n - 1}, minmax(0,1fr))` };
}

/** Where a pane sits: the focused one big on the left and the rest stacked, side by side, or zoomed. */
function placeOf(layout: Layout, id: string, focused: string | null, ids: string[], i: number): CSSProperties | null {
  if (layout === "zoom" || ids.length === 1) return id === focused || (!focused && i === 0) ? { gridColumn: 1, gridRow: 1 } : null;
  if (layout === "cols") return {};
  if (id === focused) return { gridColumn: 1, gridRow: `1 / span ${ids.length - 1}` };
  const rest = ids.filter((x) => x !== focused);
  return { gridColumn: 2, gridRow: rest.indexOf(id) + 1 };
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

function ShellMenu({ targets, onPick, label, open }: { targets: ShellTarget[]; onPick: (t: ShellTarget) => void; label: string; open: boolean }) {
  const opened = useRef(false);
  return (
    <Menu
      align="right"
      trigger={(_, toggle) => {
        // ⌘D with no obvious computer opens this menu
        if (open && !opened.current) {
          opened.current = true;
          queueMicrotask(toggle);
        }
        return (
          <button type="button" onClick={toggle} title={`New shell  ${MOD}D`} className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-2.5 text-[12.5px] text-[#f2f2f4] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96]">
            <Plus size={14} strokeWidth={2} />
            {label}
          </button>
        );
      }}
      items={targets.map((t) => ({ label: t.online ? t.name : `${t.name} (offline)`, icon: <SquareTerminal size={15} strokeWidth={1.8} />, onSelect: () => onPick(t) }))}
    />
  );
}

function TaskList({ tasks, error, selected, narrow, onPick, onNew }: { tasks: CodeTask[] | null; error: string | null; selected: string; narrow: boolean; onPick: (id: string) => void; onNew: () => void }) {
  const agents = useStore((s) => s.agents);
  const groups = tasks ? groupTasks(tasks) : [];
  return (
    <aside aria-label="Coding tasks" className={cx("m-code-list flex w-[244px] shrink-0 flex-col border-r border-white/[.06] bg-[#0f0f11]", narrow && "absolute inset-y-0 left-0 z-30 shadow-2xl")}>
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-[14px] font-semibold">Code</span>
        <button type="button" onClick={onNew} aria-label="New task" title={`New task  ${MOD}N`} className="grid h-8 w-8 place-items-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[.06] hover:text-[#f2f2f4]">
          <Plus size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        <button type="button" onClick={() => onPick(SHELLS)} className={cx("flex items-center gap-2 rounded-[7px] px-2 py-2 text-left text-[13px] transition-colors", selected === SHELLS ? "bg-white/[.07]" : "hover:bg-white/[.04]")}>
          <SquareTerminal size={14} strokeWidth={1.8} className="text-[#8e8e96]" />
          <span className="font-medium">Shells</span>
        </button>
        {error && !tasks && <div className="px-2 py-3 text-[12px] text-[#8e8e96]">{error}</div>}
        {tasks && tasks.length === 0 && (
          <button type="button" onClick={onNew} className="mt-3 rounded-[7px] border border-dashed border-white/[.1] px-3 py-3 text-left text-[12.5px] text-[#8e8e96] transition-colors hover:border-white/20 hover:text-[#f2f2f4]">
            Start a coding task for a team that works in a repo.
          </button>
        )}
        {groups.map((g) => (
          <div key={g.label} className="flex flex-col gap-0.5">
            <div className="flex justify-between px-2 pb-1 pt-3 text-[11px] text-[#8e8e96]">
              <span>{g.label}</span>
              <span>{g.tasks.length}</span>
            </div>
            {g.tasks.map((t) => (
              <button
                key={t.root.id}
                type="button"
                onClick={() => onPick(t.root.id)}
                className={cx("flex w-full flex-col gap-[3px] rounded-[7px] p-2 text-left transition-colors", selected === t.root.id ? "bg-white/[.07]" : "hover:bg-white/[.04]")}
              >
                <div className="flex w-full items-center gap-2">
                  <span className={cx("h-[7px] w-[7px] shrink-0 rounded-full", t.state === "working" && "m-code-pulse")} style={{ background: STATE_COLOR[t.state] }} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.root.title}</span>
                  <span className="shrink-0 text-[11px] text-[#8e8e96]">{timeAgo(t.root.updatedAt)}</span>
                </div>
                <div className="flex w-full items-center gap-1.5 pl-[15px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#8e8e96]">{repoName(t.team.repo)}</span>
                  <span className="flex -space-x-1">
                    {t.agentIds.slice(0, 4).map((id) => (
                      <GhostIcon key={id} color={agentColor(agents.find((a) => a.id === id))} size={12} />
                    ))}
                  </span>
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
