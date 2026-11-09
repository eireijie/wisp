import { useEffect, useState } from "react";
import { Plus, SquareTerminal } from "lucide-react";
import { api } from "../api.ts";
import { href } from "../router.ts";
import { Menu, cx } from "../components/ui.tsx";
import { TerminalPane, type ShellTarget } from "../components/TerminalPane.tsx";
import { useFeatures } from "../features.ts";

/**
 * Code (a mod, on by default): a terminal workspace. For now it holds shells on your own computers,
 * side by side; agents' panes and tasks join it later. Open panes are remembered on this browser,
 * so coming back reattaches to the same shells.
 */

interface Pane {
  key: string;
  computerId: string;
  session: string;
}

const STORE = "wisp.code.panes";
/** at most this many side by side, so it never gets crowded */
const MAX_PANES = 4;

function load(): Pane[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((p) => p && typeof p.computerId === "string" && typeof p.session === "string").slice(0, MAX_PANES) : [];
  } catch {
    return [];
  }
}

function save(panes: Pane[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(panes));
  } catch {}
}

/** A shell name nobody else's pane on that computer uses: the computer's first word and a number. */
function newSession(target: ShellTarget, panes: Pane[]) {
  const stem = target.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-")[0] || "shell";
  const taken = new Set(panes.filter((p) => p.computerId === target.id).map((p) => p.session));
  let n = 1;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

export function CodeView() {
  const on = useFeatures().code;
  const [targets, setTargets] = useState<ShellTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panes, setPanes] = useState<Pane[]>(load);
  const [focus, setFocus] = useState<string | null>(() => load()[0]?.key ?? null);

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

  useEffect(() => save(panes), [panes]);

  const add = (target: ShellTarget) => {
    if (panes.length >= MAX_PANES) return;
    const pane = { key: crypto.randomUUID(), computerId: target.id, session: newSession(target, panes) };
    setPanes((p) => [...p, pane]);
    setFocus(pane.key);
  };
  const remove = (key: string) => {
    setPanes((p) => {
      const next = p.filter((x) => x.key !== key);
      if (focus === key) setFocus(next.at(-1)?.key ?? null);
      return next;
    });
  };

  // panes for computers you can't open a terminal on any more (removed, or Code access changed) go
  const shown = targets ? panes.flatMap((p) => {
    const target = targets.find((t) => t.id === p.computerId);
    return target ? [{ ...p, target }] : [];
  }) : [];
  const cols = shown.length <= 1 ? 1 : 2;
  const rows = Math.ceil(shown.length / cols);

  const picker = (label: string, primary = false) =>
    targets && targets.length > 0 ? (
      <Menu
        align="right"
        trigger={(_, toggle) => (
          <button
            type="button"
            onClick={toggle}
            disabled={panes.length >= MAX_PANES}
            title={panes.length >= MAX_PANES ? `Up to ${MAX_PANES} at once` : undefined}
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] transition-[background-color,transform] active:scale-[.96] disabled:opacity-40",
              primary ? "border-[#f2f2f4] bg-[#f2f2f4] font-semibold text-[#0c0c0e] hover:bg-white" : "border-white/[.09] bg-[#1d1d21] text-[#f2f2f4] hover:bg-[#26262b]",
            )}
          >
            <Plus size={14} strokeWidth={2} />
            {label}
          </button>
        )}
        items={targets.map((t) => ({ label: t.online ? t.name : `${t.name} (offline)`, icon: <SquareTerminal size={15} strokeWidth={1.8} />, onSelect: () => add(t) }))}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0c0c0e] text-[#f2f2f4]">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4">
        <h1 className="text-[14px] font-semibold">Code</h1>
        <span className="flex-1" />
        {on && shown.length > 0 && picker("Shell")}
      </header>
      {on && shown.length > 0 ? (
        <div className="grid min-h-0 flex-1 gap-2 px-2 pb-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
          {shown.map((p) => (
            <TerminalPane key={p.key} target={p.target} session={p.session} focused={focus === p.key} onFocus={() => setFocus(p.key)} onClose={() => remove(p.key)} />
          ))}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center px-6 pb-16 text-center">
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
                {picker("New shell", true)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
