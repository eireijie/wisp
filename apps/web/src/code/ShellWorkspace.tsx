import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Columns2, Maximize2, Minimize2, Play, Plus, Rows2, SquareTerminal, X } from "lucide-react";
import { HARNESSES } from "@wisp/core";
import { api } from "../api.ts";
import { href } from "../router.ts";
import { Menu, cx } from "../components/ui.tsx";
import { TerminalPane, type ShellTarget } from "../components/TerminalPane.tsx";
import { useFeatures } from "../features.ts";
import { MAX_PANES, MAX_TABS, allLeaves, layout, leaves, neighbor, newSession, removePane, restore, setRatio, splitPane, type Leaf, type Tab, type Workspace } from "./layout.ts";

/**
 * Code's terminal workspace, working like tmux. Tabs, each split into
 * panes side by side or stacked, with dividers you drag; a pane is a shell on one of your
 * computers, or an agent harness's CLI. ⌃B then a key does what tmux's prefix does. The layout
 * is remembered on this browser and the shells keep running on the computer, so a reload, a
 * dropped connection or another tab picks up the same shells.
 */

const STORE = "wisp.code.workspace";
/** before tabs: a flat list of panes */
const OLD_STORE = "wisp.code.panes";

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

const harnessLabel = (id?: string) => HARNESSES.find((h) => h.id === id)?.label;

type Move = "left" | "right" | "up" | "down";

/** what a shifted key types on a US keyboard, for events that report the unshifted key */
const SHIFTED: Record<string, string> = { "'": '"', "5": "%", "7": "&", "\\": "|" };

/** The keys after ⌃B, as the hint shows them. */
const KEYS: [string, string][] = [
  ["%", "split"],
  ['"', "stack"],
  ["←↑→↓", "move"],
  ["x", "close"],
  ["z", "zoom"],
  ["c", "new tab"],
  ["n p", "next/prev"],
  ["1–9", "tab"],
];

/** `lead`: what the header starts with. `embedded`: inside a page that already keeps clear of the phone's tab bar. */
export function ShellWorkspace({ lead, embedded = false }: { lead?: ReactNode; embedded?: boolean }) {
  const on = useFeatures().code;
  const [targets, setTargets] = useState<ShellTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace>(() => restore(read(STORE), read(OLD_STORE), () => crypto.randomUUID()));
  const [armed, setArmed] = useState(false);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  const layers = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    let gone = false;
    const refresh = () =>
      api<ShellTarget[]>("GET", "/api/terminals").then(
        (t) => !gone && (setTargets(t), setError(null)),
        (err) => !gone && setError((err as Error).message),
      );
    void refresh();
    const timer = setInterval(refresh, 15_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const r = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(ws));
      localStorage.removeItem(OLD_STORE);
    } catch {}
  }, [ws]);

  const tab = ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
  const changeTab = useCallback((id: string, fn: (t: Tab) => Tab) => setWs((w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === id ? fn(t) : t)) })), []);
  const targetOf = (computerId: string) => targets?.find((t) => t.id === computerId);
  /** where a new pane goes when you don't pick: the focused pane's computer, else the first one online */
  const defaultTarget = () => {
    const focused = leaves(tab.root).find((l) => l.key === tab.focus);
    return (focused && targetOf(focused.computerId)) ?? targets?.find((t) => t.online) ?? targets?.[0];
  };

  const leafFor = (target: ShellTarget, launch?: string): Leaf => ({
    kind: "pane",
    key: crypto.randomUUID(),
    computerId: target.id,
    session: newSession(launch ?? target.name, target.id, allLeaves(ws)),
    ...(launch ? { launch } : {}),
  });

  const addPane = (target: ShellTarget | undefined, dir: "row" | "col" = "row", launch?: string) => {
    if (!target || leaves(tab.root).length >= MAX_PANES) return;
    const leaf = leafFor(target, launch);
    changeTab(tab.id, (t) => ({ ...t, root: splitPane(t.root, t.focus ?? "", dir, leaf), focus: leaf.key, zoom: false }));
  };

  const newTab = (target: ShellTarget | undefined = defaultTarget(), launch?: string) => {
    if (!target || ws.tabs.length >= MAX_TABS) return;
    const leaf = leafFor(target, launch);
    const t: Tab = { id: crypto.randomUUID(), root: leaf, focus: leaf.key };
    setWs((w) => ({ tabs: [...w.tabs, t], active: t.id }));
  };

  const closePane = (key: string) =>
    setWs((w) => {
      const owner = w.tabs.find((t) => leaves(t.root).some((l) => l.key === key));
      if (!owner) return w;
      const root = removePane(owner.root, key);
      // an emptied tab goes, unless it's the last one
      if (!root && w.tabs.length > 1) {
        const tabs = w.tabs.filter((t) => t.id !== owner.id);
        const i = w.tabs.indexOf(owner);
        return { tabs, active: w.active === owner.id ? tabs[Math.max(0, i - 1)].id : w.active };
      }
      const keys = leaves(root).map((l) => l.key);
      const focus = owner.focus && keys.includes(owner.focus) ? owner.focus : (keys.at(-1) ?? null);
      return { ...w, tabs: w.tabs.map((t) => (t.id === owner.id ? { ...t, root, focus, zoom: t.zoom && keys.length > 1 } : t)) };
    });

  const closeTab = (id: string) =>
    setWs((w) => {
      if (w.tabs.length === 1) return { ...w, tabs: [{ ...w.tabs[0], root: null, focus: null, zoom: false }] };
      const i = w.tabs.findIndex((t) => t.id === id);
      const tabs = w.tabs.filter((t) => t.id !== id);
      return { tabs, active: w.active === id ? tabs[Math.max(0, i - 1)].id : w.active };
    });

  const move = (dir: Move) => {
    const next = tab.focus && neighbor(tab.root, tab.focus, dir);
    if (next) changeTab(tab.id, (t) => ({ ...t, focus: next, zoom: false }));
  };
  const cycle = (step: number) => {
    const keys = leaves(tab.root).map((l) => l.key);
    if (keys.length < 2) return;
    const i = keys.indexOf(tab.focus ?? "");
    changeTab(tab.id, (t) => ({ ...t, focus: keys[(i + step + keys.length) % keys.length] }));
  };
  const switchTab = (i: number) => {
    const t = ws.tabs[(i + ws.tabs.length) % ws.tabs.length];
    if (t) setWs((w) => ({ ...w, active: t.id }));
  };
  const zoom = () => changeTab(tab.id, (t) => ({ ...t, zoom: !t.zoom }));

  // the keys, like tmux: ⌃B then one key. ⌘D and ⌘⇧D split straight away.
  const act = useRef<(key: string) => void>(() => {});
  act.current = (k) => {
    if (k === "%" || k === "|") addPane(defaultTarget(), "row");
    else if (k === '"' || k === "-") addPane(defaultTarget(), "col");
    else if (k === "ArrowLeft" || k === "h") move("left");
    else if (k === "ArrowRight" || k === "l") move("right");
    else if (k === "ArrowUp" || k === "k") move("up");
    else if (k === "ArrowDown" || k === "j") move("down");
    else if (k === "o") cycle(1);
    else if (k === "x" && tab.focus) closePane(tab.focus);
    else if (k === "&") closeTab(tab.id);
    else if (k === "z") zoom();
    else if (k === "c") newTab();
    else if (k === "n") switchTab(ws.tabs.indexOf(tab) + 1);
    else if (k === "p") switchTab(ws.tabs.indexOf(tab) - 1);
    else if (/^[1-9]$/.test(k)) switchTab(Number(k) - 1);
  };
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    const disarm = () => {
      waiting = false;
      clearTimeout(timer);
      setArmed(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        waiting = true;
        setArmed(true);
        clearTimeout(timer);
        timer = setTimeout(disarm, 4000);
        return;
      }
      if (waiting) {
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        // by the physical key too, so % and " work whatever the keyboard layout reports
        const key = (e.shiftKey && SHIFTED[e.key]) || e.key;
        if (key !== "Escape") act.current(key);
        return disarm();
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        e.stopPropagation();
        act.current(e.shiftKey ? '"' : "%");
      }
    };
    // capture: before the terminal takes the key
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
    };
  }, [on]);

  // dragging a divider: its split's ratio follows the pointer
  const drag = (e: ReactPointerEvent<HTMLDivElement>, tabId: string, d: ReturnType<typeof layout>["dividers"][number]) => {
    const layer = layers.current.get(tabId);
    if (!layer) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const box = layer.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const at = d.dir === "row" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      const ratio = d.dir === "row" ? (at - d.rect.x) / d.rect.w : (at - d.rect.y) / d.rect.h;
      changeTab(tabId, (t) => ({ ...t, root: setRatio(t.root, d.path, ratio) }));
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const tabName = (t: Tab) => {
    const l = leaves(t.root).find((x) => x.key === t.focus) ?? leaves(t.root)[0];
    return l ? (harnessLabel(l.launch) ?? l.session) : "empty";
  };

  const full = leaves(tab.root).length >= MAX_PANES;
  const btn = "inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] transition-[background-color,transform] active:scale-[.96] disabled:opacity-40";
  const iconBtn = "grid h-7 w-7 place-items-center rounded-[7px] text-[#a1a1aa] transition-[background-color,color,transform] hover:bg-white/[.06] hover:text-[#f2f2f4] active:scale-[.94] disabled:opacity-40";

  const computerMenu = (label: string, primary = false) =>
    targets && targets.length > 0 ? (
      <Menu
        align="right"
        trigger={(_, toggle) => (
          <button type="button" onClick={toggle} disabled={full} title={full ? `Up to ${MAX_PANES} panes in a tab` : "A shell on one of your computers"} className={cx(btn, primary ? "border-[#f2f2f4] bg-[#f2f2f4] font-semibold text-[#0c0c0e] hover:bg-white" : "border-white/[.09] bg-[#1d1d21] text-[#f2f2f4] hover:bg-[#26262b]")}>
            <Plus size={14} strokeWidth={2} />
            {label}
          </button>
        )}
        items={targets.map((t) => ({ label: t.online ? t.name : `${t.name} (offline)`, icon: <SquareTerminal size={15} strokeWidth={1.8} />, onSelect: () => addPane(t) }))}
      />
    ) : null;

  const runMenu =
    targets && targets.length > 0 ? (
      <Menu
        align="right"
        trigger={(_, toggle) => (
          <button type="button" onClick={toggle} disabled={full} aria-label="Run an agent's CLI in a pane" title="Run an agent's CLI in a new pane" className={iconBtn}>
            <Play size={14} strokeWidth={1.9} />
          </button>
        )}
        items={HARNESSES.map((h) => ({ label: h.label, icon: <SquareTerminal size={15} strokeWidth={1.8} />, onSelect: () => addPane(defaultTarget(), "row", h.id) }))}
      />
    ) : null;

  const hasPanes = ws.tabs.some((t) => t.root);

  return (
    <div className={cx("flex h-full min-h-0 flex-col bg-[#0c0c0e] text-[#f2f2f4]", !embedded && "max-md:pb-[88px]")}>
      <header className="flex h-12 shrink-0 items-center gap-1.5 px-4">
        {lead}
        <span className="flex-1" />
        {on && tab.root && (
          <>
            <button type="button" onClick={() => addPane(defaultTarget(), "row")} disabled={full} aria-label="Split side by side" title="Split side by side (⌃B % or ⌘D)" className={iconBtn}>
              <Columns2 size={15} strokeWidth={1.8} />
            </button>
            <button type="button" onClick={() => addPane(defaultTarget(), "col")} disabled={full} aria-label="Split stacked" title={'Split stacked (⌃B " or ⌘⇧D)'} className={iconBtn}>
              <Rows2 size={15} strokeWidth={1.8} />
            </button>
            {!narrow && (
              <button type="button" onClick={zoom} aria-label={tab.zoom ? "Show all panes" : "Zoom the pane"} title="Zoom (⌃B z)" className={cx(iconBtn, tab.zoom && "bg-white/[.08] text-[#f2f2f4]")}>
                {tab.zoom ? <Minimize2 size={14} strokeWidth={1.9} /> : <Maximize2 size={14} strokeWidth={1.9} />}
              </button>
            )}
            {runMenu}
            <span className="ml-1">{computerMenu("Shell")}</span>
          </>
        )}
      </header>

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {on &&
          targets &&
          ws.tabs.map((t) => {
            const { panes, dividers } = layout(t.root);
            const zoomed = narrow || !!t.zoom;
            const shown = t.id === tab.id;
            return (
              <div
                key={t.id}
                ref={(el) => void (el ? layers.current.set(t.id, el) : layers.current.delete(t.id))}
                // other tabs stay put (hidden), so their shells stay connected
                className={cx("absolute inset-x-1.5 inset-y-0", !shown && "invisible pointer-events-none")}
                aria-hidden={!shown}
              >
                {panes.map(({ leaf, rect }) => {
                  const target = targetOf(leaf.computerId);
                  const focused = t.focus === leaf.key;
                  const hide = zoomed && !focused;
                  const style: CSSProperties = zoomed ? { left: 0, top: 0, width: "100%", height: "100%" } : { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` };
                  return (
                    <div key={leaf.key} style={style} className={cx("absolute grid p-[3px]", hide && "invisible")}>
                      {target ? (
                        <TerminalPane
                          target={target}
                          session={leaf.session}
                          launch={leaf.launch}
                          title={leaf.launch ? `${harnessLabel(leaf.launch)} · ${leaf.session}` : undefined}
                          focused={shown && focused}
                          onFocus={() => (t.focus === leaf.key ? undefined : changeTab(t.id, (x) => ({ ...x, focus: leaf.key })))}
                          onClose={() => closePane(leaf.key)}
                        />
                      ) : (
                        <Gone onClose={() => closePane(leaf.key)} />
                      )}
                    </div>
                  );
                })}
                {!zoomed &&
                  dividers.map((d) => {
                    const style: CSSProperties =
                      d.dir === "row"
                        ? // kept off its ends, so where dividers meet each one can still be grabbed
                          { left: `calc(${d.at * 100}% - 4px)`, top: `calc(${d.rect.y * 100}% + 8px)`, width: 8, height: `calc(${d.rect.h * 100}% - 16px)` }
                        : { top: `calc(${d.at * 100}% - 4px)`, left: `calc(${d.rect.x * 100}% + 8px)`, height: 8, width: `calc(${d.rect.w * 100}% - 16px)` };
                    return (
                      <div
                        key={d.path.join(".") || "root"}
                        role="separator"
                        aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
                        title="Drag to resize · double-click to even out"
                        onPointerDown={(e) => drag(e, t.id, d)}
                        onDoubleClick={() => changeTab(t.id, (x) => ({ ...x, root: setRatio(x.root, d.path, 0.5) }))}
                        style={style}
                        className={cx("group absolute z-10 touch-none", d.dir === "row" ? "cursor-col-resize" : "cursor-row-resize")}
                      >
                        <span className={cx("absolute rounded-full bg-white/0 transition-colors duration-150 group-hover:bg-white/25 group-active:bg-[#6aa2ff]", d.dir === "row" ? "inset-y-2 left-[3.5px] w-px" : "inset-x-2 top-[3.5px] h-px")} />
                      </div>
                    );
                  })}
              </div>
            );
          })}

        {(!on || !targets || !tab.root) && (
          <div className="absolute inset-0 grid place-items-center px-6 pb-16 text-center">
            <div className="flex max-w-[320px] flex-col items-center gap-3 m-fade-in">
              <SquareTerminal size={22} strokeWidth={1.6} className="text-[#8e8e96]" />
              {!on ? (
                <>
                  <p className="text-[13px] text-[#a1a1aa]">Code is turned off.</p>
                  <a href={href({ view: "mods" })} className="text-[12.5px] text-[#6aa2ff] hover:text-[#9cc2ff]">
                    Mods
                  </a>
                </>
              ) : targets === null ? (
                <p className="text-[12.5px] text-[#8e8e96]">{error ?? "Loading…"}</p>
              ) : targets.length === 0 ? (
                <>
                  <p className="text-[13px] text-[#a1a1aa]">No computers of yours to open a terminal on.</p>
                  <a href={href({ view: "computers", computerId: null })} className="text-[12.5px] text-[#6aa2ff] hover:text-[#9cc2ff]">
                    Computers
                  </a>
                </>
              ) : (
                <>
                  <p className="text-[13px] text-[#a1a1aa]">A shell on one of your computers.</p>
                  {computerMenu("New shell", true)}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {on && targets && hasPanes && (
        <footer className="flex h-8 shrink-0 items-center gap-1 overflow-hidden px-3 font-mono text-[11.5px]">
          {ws.tabs.map((t, i) => (
            <span key={t.id} className={cx("group inline-flex h-[22px] max-w-[180px] items-center rounded-[5px] transition-colors", t.id === tab.id ? "bg-[#26262b] text-[#f2f2f4]" : "text-[#8e8e96] hover:bg-white/[.05] hover:text-[#d4d4d8]")}>
              <button type="button" onClick={() => setWs((w) => ({ ...w, active: t.id }))} className="truncate px-2" title={`Tab ${i + 1} (⌃B ${i + 1})`}>
                {i + 1}:{tabName(t)}
              </button>
              <button type="button" onClick={() => closeTab(t.id)} aria-label={`Close tab ${i + 1}`} title="Close tab (⌃B &)" className="-ml-1 mr-0.5 hidden h-4 w-4 place-items-center rounded text-[#8e8e96] hover:text-[#f2f2f4] group-hover:grid">
                <X size={11} strokeWidth={2.2} />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => newTab()} disabled={ws.tabs.length >= MAX_TABS} aria-label="New tab" title="New tab (⌃B c)" className="grid h-[22px] w-[22px] place-items-center rounded-[5px] text-[#8e8e96] transition-colors hover:bg-white/[.05] hover:text-[#f2f2f4] disabled:opacity-40">
            <Plus size={12} strokeWidth={2.2} />
          </button>
          <span className="flex-1" />
          {narrow && leaves(tab.root).length > 1 && (
            <span className="flex items-center gap-1 text-[#a1a1aa]">
              <button type="button" onClick={() => cycle(-1)} className="px-1.5" aria-label="Previous pane">
                ‹
              </button>
              {leaves(tab.root).findIndex((l) => l.key === tab.focus) + 1}/{leaves(tab.root).length}
              <button type="button" onClick={() => cycle(1)} className="px-1.5" aria-label="Next pane">
                ›
              </button>
            </span>
          )}
          {!narrow &&
            (armed ? (
              <span className="m-fade-in flex items-center gap-3 truncate text-[#a1a1aa]">
                <kbd className="rounded-[4px] bg-[#6aa2ff] px-1.5 text-[#0c0c0e]">⌃B</kbd>
                {KEYS.map(([k, what]) => (
                  <span key={k} className="whitespace-nowrap">
                    <span className="text-[#f2f2f4]">{k}</span> {what}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-[#6b6b75]">
                <kbd className="text-[#8e8e96]">⌃B</kbd> keys
              </span>
            ))}
        </footer>
      )}
    </div>
  );
}

/** A pane whose computer you can't open a terminal on any more (removed, or Code access changed). */
function Gone({ onClose }: { onClose: () => void }) {
  return (
    <div className="grid place-items-center rounded-[10px] border border-white/[.08] bg-[#0c0c0e] px-6 text-center text-[12.5px] text-[#8e8e96]">
      <div className="flex flex-col items-center gap-2.5">
        <span>This computer isn't available for terminals any more.</span>
        <button type="button" onClick={onClose} className="inline-flex h-7 items-center rounded-md border border-white/[.09] bg-[#1d1d21] px-2.5 text-[#f2f2f4] hover:bg-[#26262b]">
          Close pane
        </button>
      </div>
    </div>
  );
}
