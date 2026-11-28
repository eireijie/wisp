import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, LayoutGrid, Loader2, Monitor, X } from "lucide-react";
import type { Agent } from "@bubble-ai/core";
import { newBubbleLook, type GhostAppearance } from "@bubble-ai/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { openDm } from "../openDm.ts";
import { defaultRunsOn, runsOnChoices, runsOnCreate, useDevices, type RunsOnChoice } from "../devices.ts";
import { Ghost } from "../components/Ghost.tsx";
import { Modal, cx } from "../components/ui.tsx";
import { autoHandle, defaultsNeedPicking, nameProblem, suggestName, type AgentDefaults } from "./CreateAgent.tsx";
import { BubblePicker } from "./AgentShort.tsx";
import { BOARD_COLORS } from "./lookWords.ts";
import "../round11-agent.css";

/**
 * New agent (round 11, board 12): one sheet. Its bubble, a name, a colour, Create. It is made with
 * your defaults (its AI, its computer) and its chat opens, where it says hello and does the rest of
 * the setup. "Describe a look" picks from four bubbles; "More options" is the full New agent
 * dialog, with what was picked here already in it. When there are no defaults to make it with,
 * Create goes on to that dialog. A sheet on phones, a centred pop-up on desktops.
 * Round 16 (board 16c): a "Runs on" row picks the device or the shared computer, for everyone.
 */
export function NewAgentSheet({ onClose, onMore }: { onClose: () => void; onMore: (picked: { name: string; look: GhostAppearance }) => void }) {
  const agents = useStore((s) => s.agents);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const placeholder = useMemo(() => suggestName(agents), [agents]);
  const [name, setName] = useState("");
  const [look, setLook] = useState<GhostAppearance>(() => ({ ...newBubbleLook(), color: BOARD_COLORS[0].hex }));
  const [describe, setDescribe] = useState(false);
  const [defaults, setDefaults] = useState<AgentDefaults | null | "error">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useDevices();
  const computers = useStore((s) => s.computers);
  const owner = useStore((s) => s.me?.role) === "owner";
  const choices = useMemo(() => runsOnChoices(devices ?? [], computers), [devices, computers]);
  const fallback = defaultRunsOn(choices, defaults && defaults !== "error" ? defaults : null, owner);
  const [picked, setPicked] = useState<string | null>(null);
  const runsOn = choices.find((c) => c.key === picked) ?? fallback;
  useEffect(() => {
    let on = true;
    api<AgentDefaults>("GET", "/api/settings/agent-defaults").then(
      (d) => on && setDefaults(d),
      () => on && setDefaults("error"),
    );
    return () => {
      on = false;
    };
  }, []);
  const finalName = name.trim() || placeholder;
  const problem = nameProblem(finalName, "", agents);
  const needsMore = defaultsNeedPicking(defaults);

  const create = async () => {
    if (busy || problem) return;
    if (needsMore) return onMore({ name: finalName, look });
    setBusy(true);
    setError(null);
    try {
      // a device picked here goes with it; left alone, the defaults place it as they always did
      const where = runsOn && picked && runsOn.key !== fallback?.key ? runsOnCreate(runsOn.to) : {};
      const a = await api<Agent>("POST", "/api/agents", { name: finalName, handle: autoHandle(finalName, agents.map((x) => x.handle)), instructions: "", useDefaults: true, ...where, settings: { appearance: look } });
      await Promise.all([refreshAgents(), useStore.getState().refreshComputers()]);
      onClose();
      // straight to its chat, where it has already said hello
      await openDm(a.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New agent" label="New agent" headerless onClose={busy ? () => {} : onClose} className="r11-page flex flex-col max-sm:h-[calc(100dvh-54px)] max-sm:rounded-t-[28px]! sm:max-w-[400px]! sm:rounded-[24px]!" contentClassName="flex flex-1 flex-col items-center p-0! pb-[max(1.5rem,env(safe-area-inset-bottom))]!">
      <div className="grid w-full grid-cols-[40px_1fr_40px] items-center px-4 pt-3.5">
        <button type="button" onClick={onClose} disabled={busy} className="r11-circle bg-[color-mix(in_srgb,var(--ink)_9%,transparent)] hover:bg-[color-mix(in_srgb,var(--ink)_14%,transparent)]" aria-label="Close">
          <X size={18} strokeWidth={2} />
        </button>
        <h1 className="text-center text-[15px] font-semibold">New agent</h1>
      </div>
      {describe ? (
        <div className="w-full pt-1">
          <BubblePicker look={look} onChange={setLook} name={finalName} start="describe" size={104} />
          <button type="button" onClick={() => setDescribe(false)} className="mx-auto mt-3 block text-[13.5px] text-muted hover:text-ink">
            Back to colours
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3.5">
            <Ghost look={look} size={118} label={`${finalName}'s bubble`} />
          </div>
          <div className="mt-[22px] w-full max-w-[300px] px-0">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="Name your agent"
              aria-label="Name your agent"
              maxLength={80}
              className="r11-field"
            />
          </div>
          {problem && name.trim() && <p className="mt-2 text-[13px] text-st-needs">{problem}</p>}
          {choices.length > 0 && runsOn && (
            <div className="mt-2.5 w-full max-w-[300px]">
              <RunsOnPicker choices={choices} value={runsOn.key} onChange={setPicked} />
            </div>
          )}
          <div role="radiogroup" aria-label="Colour" className="mt-[26px] grid grid-cols-6 gap-x-4 gap-y-3.5 [--sw-gap:var(--r11-page)]">
            {BOARD_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                role="radio"
                aria-checked={look.color?.toLowerCase() === c.hex}
                aria-label={c.name}
                title={c.name}
                onClick={() => setLook({ ...look, color: c.hex, color2: undefined })}
                className="r11-sw"
                style={{ background: `radial-gradient(circle at 34% 28%, color-mix(in srgb, ${c.hex} 35%, white), ${c.hex} 70%)` }}
              />
            ))}
          </div>
          <p className="mt-5 text-[13.5px] text-muted">
            Or{" "}
            <button type="button" onClick={() => setDescribe(true)} className="r11-link">
              describe a look
            </button>{" "}
            ·{" "}
            <button type="button" onClick={() => onMore({ name: finalName, look })} className="r11-link">
              more options
            </button>
          </p>
        </>
      )}
      <div className="min-h-6 flex-1" />
      {error && <p className="mb-3 max-w-[300px] text-center text-[13px] text-bad">{error}</p>}
      <div className="w-full max-w-[300px]">
        <button type="button" onClick={() => void create()} disabled={busy || !!problem || defaults === null} className="r11-create">
          {busy ? <Loader2 size={17} className="animate-spin" /> : null}
          {needsMore ? "Continue" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * "Runs on" (round 16, board 16c): a row with where it runs, and under it, once opened, the shared
 * computer and every device this person can use, a tick on the one picked. New agent and the
 * agent's profile both use it. It opens and closes at once.
 */
export function RunsOnPicker({ choices, value, onChange, busy }: { choices: RunsOnChoice[]; value: string | null; onChange: (key: string) => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const current = choices.find((c) => c.key === value);
  return (
    <div className="w-full">
      <button type="button" aria-expanded={open} aria-haspopup="listbox" disabled={busy} onClick={() => setOpen((o) => !o)} className="flex h-12 w-full items-center gap-2.5 rounded-[14px] bg-[var(--r11-card)] px-3.5 text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <span className="flex-1 text-muted">Runs on</span>
        <span className="truncate text-ink">{current?.label ?? "Pick one"}</span>
        {busy ? <Loader2 size={14} className="shrink-0 animate-spin text-muted" /> : <ChevronDown size={14} strokeWidth={2} className={cx("shrink-0 text-muted", open && "rotate-180")} aria-hidden />}
      </button>
      {open && (
        <RunsOnList
          choices={choices}
          value={value}
          className="mt-1.5"
          onPick={(key) => {
            setOpen(false);
            if (key !== value) onChange(key);
          }}
        />
      )}
    </div>
  );
}

/** The choices themselves: an icon, the name and its state, a tick on the one picked. */
export function RunsOnList({ choices, value, onPick, className }: { choices: RunsOnChoice[]; value: string | null; onPick: (key: string) => void; className?: string }) {
  return (
    <div role="listbox" aria-label="Runs on" className={cx("side-menu flex flex-col p-[5px]", className)}>
      {choices.map((c) => (
        <button key={c.key} type="button" role="option" aria-selected={c.key === value} onClick={() => onPick(c.key)} className="flex min-h-[52px] w-full items-center gap-2.5 rounded-[10px] px-[11px] text-left outline-none hover:bg-hover focus-visible:bg-hover">
          {c.key === "shared" ? <LayoutGrid size={19} strokeWidth={1.8} className="shrink-0" aria-hidden /> : <Monitor size={19} strokeWidth={1.8} className="shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] text-ink">{c.label}</span>
            <span className="block truncate text-[12px] text-muted">{c.sub}</span>
          </span>
          {c.key === value && <Check size={16} strokeWidth={2.4} className="shrink-0" aria-hidden />}
        </button>
      ))}
    </div>
  );
}
