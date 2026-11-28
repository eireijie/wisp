import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, BookOpen, ChevronLeft, ChevronRight, Ellipsis, Hand, LayoutGrid, Library, Loader2, Maximize2, MessageCircle, Monitor, Pencil, Plug, Settings2, Clock, Video, X } from "lucide-react";
import { harnessInfo, harnessLabel, type Agent, type Connector, type Routine, type Skill } from "@bubble-ai/core";
import { defaultAppearance, type GhostAppearance } from "@bubble-ai/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { closePopup, go, href, type AgentTab } from "../router.ts";
import { liveShape } from "../liveShape.ts";
import { useFeature, useFeatures } from "../features.ts";
import { openDm } from "../openDm.ts";
import { setChannelPrefs } from "../components/Channels.tsx";
import { useAgentBackground } from "../chatBackground.ts";
import { isTopOverlay, toBody, useOverlay } from "../overlays.ts";
import { useComputerState } from "./computerState.ts";
import { LiveScreen, ScreenThumb } from "../components/Screen.tsx";
import { Ghost } from "../components/Ghost.tsx";
import { useNarrow } from "../components/SetupShell.tsx";
import { AgentAvatar, Menu, cx } from "../components/ui.tsx";
import { prettyModel } from "../components/EffortSlider.tsx";
import { InPlace, Toggle } from "./AgentSections.tsx";
import { runsOnDevice } from "./AgentComputer.tsx";
import { LookEditor, withParts } from "./LookEditor.tsx";
import { VoiceChat } from "./AgentProfile.tsx";
import { BOARD_COLORS, looksFromWords } from "./lookWords.ts";
import { mergeLook, uploadFace } from "../components/lookPhoto.tsx";
import { agentRunsOn, runsOnChoices, runsOnMove, useDevices } from "../devices.ts";
import { RunsOnList } from "./NewAgentSheet.tsx";
import "../round11-agent.css";

const to = (agent: Agent, t: AgentTab) => href({ view: "agents", agentId: agent.id, tab: t });

/** One row of a group (board .li): an icon, its name, and on the right what it is set to, with › when it opens something. */
function Row({ icon, label, value, href: link, onClick, children }: { icon?: ReactNode; label: ReactNode; value?: ReactNode; href?: string; onClick?: () => void; children?: ReactNode }) {
  const inner = (
    <>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <span className="r11-r">
        {children ?? (value != null && value !== "" ? <span className="truncate">{value}</span> : null)}
        {(link || onClick) && <ChevronRight size={15} strokeWidth={2} className="shrink-0" aria-hidden />}
      </span>
    </>
  );
  if (link) return <a href={link} className="r11-li">{inner}</a>;
  if (onClick) return <button type="button" onClick={onClick} className="r11-li">{inner}</button>;
  return <div className="r11-li">{inner}</div>;
}

/** The back arrow (phones) or X (the desktop side panel), as a glass circle. */
function BackOrClose({ back, label }: { back?: string; label: string }) {
  if (back)
    return (
      <a href={back} className="gl r11-circle" aria-label={label}>
        <ChevronLeft size={19} strokeWidth={2} />
      </a>
    );
  return (
    <>
      <span className="md:hidden">
        <button type="button" onClick={() => (history.length > 1 ? history.back() : go({ view: "agents", agentId: null }))} className="gl r11-circle" aria-label="Back">
          <ChevronLeft size={19} strokeWidth={2} />
        </button>
      </span>
      <span className="max-md:hidden">
        <button type="button" onClick={closePopup} className="gl r11-circle" aria-label="Close profile" title="Close (Esc)">
          <X size={17} strokeWidth={2} />
        </button>
      </span>
    </>
  );
}

/** How its computer is doing, in a word, for the profile's Computer row. */
export function computerWord(c: ComputerInfo | undefined, working: boolean): string {
  if (!c) return "None yet";
  if (!c.online) return "Offline";
  if (c.paused) return "Paused";
  if (c.status === "starting") return "Starting";
  if (c.status === "stopped") return "Off";
  return working ? "Working" : "Idle";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The profile (round 11, board 12; round 16, board 16c): one short list. Its bubble, name and what
 * it does; Edit and Message; Library and Computer; "Set up" (Runs on, Apps and skills, Routines,
 * Memory); Notifications; and one All settings row for everything else.
 */
export function ShortProfile({ agent }: { agent: Agent }) {
  const features = useFeatures();
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const computer = useStore((s) => s.computers.find((c) => c.id === agent.computerId));
  const live = useStore(liveShape);
  const dm = useStore((s) => s.channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`)));
  const routinesVersion = useStore((s) => s.routinesVersion);
  const skillsVersion = useStore((s) => s.skillsVersion);
  const phone = useNarrow("(max-width: 767px)");
  const [usable, setUsable] = useState<number | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [notes, setNotes] = useState<number | null>(null);
  useEffect(() => {
    let on = true;
    const has = (i: { agentIds: string[]; allAgents?: boolean }) => !!i.allAgents || i.agentIds.includes(agent.id);
    Promise.all([api<Connector[]>("GET", "/api/connectors").catch(() => []), api<Skill[]>("GET", "/api/skills").catch(() => [])]).then(([apps, skills]) => on && setUsable(apps.filter(has).length + skills.filter(has).length));
    return () => {
      on = false;
    };
  }, [agent.id, skillsVersion]);
  useEffect(() => {
    let on = true;
    if (features.routines) api<Routine[]>("GET", `/api/routines?agent=${agent.id}`).then((r) => on && setRoutines(r), () => on && setRoutines([]));
    return () => {
      on = false;
    };
  }, [agent.id, features.routines, routinesVersion]);
  useEffect(() => {
    let on = true;
    api<{ path: string }[]>("GET", "/api/vault/notes").then(
      (n) => on && setNotes(n.filter((x) => x.path.startsWith(`agents/${agent.id}/`) && !/\/(SOUL|About)\.md$/.test(x.path)).length),
      () => on && setNotes(0),
    );
    return () => {
      on = false;
    };
  }, [agent.id]);
  const working = Object.values(live).some((r) => r.agentId === agent.id) || agent.status === "busy";
  const routinesOn = routines?.filter((r) => r.enabled).length ?? 0;
  const notify = dm ? dm.notify !== "mute" : true;
  const menu = [
    { label: "Who can message", icon: <MessageCircle size={15} />, onSelect: () => go({ view: "agents", agentId: agent.id, tab: "access" }) },
    ...(canEdit ? ["divider" as const, { label: `Remove ${agent.name}`, danger: true, onSelect: () => go({ view: "agents", agentId: agent.id, tab: "remove" }) }] : []),
  ];
  return (
    <div className="r11-page flex min-h-full flex-1 flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center justify-between px-3.5 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <BackOrClose label="Back" />
        <Menu
          align="right"
          items={menu}
          trigger={(open, toggle) => (
            <button type="button" onClick={toggle} aria-expanded={open} className="gl r11-circle" aria-label={`More for ${agent.name}`}>
              <Ellipsis size={19} strokeWidth={2} />
            </button>
          )}
        />
      </header>
      <div className="flex flex-col items-center gap-1.5 px-6 pt-0.5 pb-[18px] text-center">
        <AgentAvatar agent={agent} size={phone ? 104 : 80} live />
        <h2 className="mt-1 max-w-full truncate text-[22px] font-bold leading-7">{agent.name}</h2>
        {agent.settings.role ? <p className="max-w-full truncate text-[13.5px] text-muted">{agent.settings.role}</p> : <p className="text-[13.5px] text-muted">{harnessLabel(agent.harness)}</p>}
        <div className="mt-1.5 flex gap-2">
          {canEdit && (
            <a href={to(agent, "settings")} className="r11-pill">
              Edit
            </a>
          )}
          <button type="button" onClick={() => void openDm(agent.id)} className="r11-pill">
            <MessageCircle size={15} strokeWidth={1.8} aria-hidden /> Message
          </button>
        </div>
      </div>
      <div className="r11-grp">
        <Row icon={<Library size={18} strokeWidth={1.8} />} label="Library" href={to(agent, "library")} />
        <Row icon={<Monitor size={18} strokeWidth={1.8} />} label="Computer" value={computerWord(computer, working)} href={to(agent, computer ? "screen" : "computer")} />
      </div>
      <div className="r11-sec">Set up</div>
      <div className="r11-grp">
        <RunsOnRow agent={agent} canEdit={canEdit} />
        <Row icon={<Plug size={18} strokeWidth={1.8} />} label="Apps and skills" value={usable ? String(usable) : undefined} href={to(agent, "apps")} />
        {features.routines && <Row icon={<Clock size={18} strokeWidth={1.8} />} label="Routines" value={routinesOn ? `${routinesOn} on` : undefined} href={to(agent, "routines")} />}
        <Row icon={<BookOpen size={18} strokeWidth={1.8} />} label="Memory" value={notes ? plural(notes, "note") : undefined} href={to(agent, "notes")} />
      </div>
      <div className="r11-grp mt-3.5">
        <Row icon={<Bell size={18} strokeWidth={1.8} />} label="Notifications">
          <Toggle label={`Notifications from ${agent.name}`} on={notify} disabled={!dm} onChange={(v) => dm && void setChannelPrefs(dm, { notify: v ? "default" : "mute" })} />
        </Row>
      </div>
      <p className="r11-note">Tells you when {agent.name} finishes or needs you.</p>
      <div className="r11-grp mt-3.5">
        <Row icon={<LayoutGrid size={18} strokeWidth={1.8} />} label="All settings" href={to(agent, "more")} />
      </div>
      <p className="r11-note">Model, instructions, permissions, who can message it, voice, background checks. Everything in one list.</p>
    </div>
  );
}

/**
 * Runs on (round 16, board 16c): where the agent runs, and the list to move it (the shared
 * computer or any device this person can use). Agents that connect from outside (MCP) have none.
 */
function RunsOnRow({ agent, canEdit }: { agent: Agent; canEdit: boolean }) {
  const devices = useDevices();
  const computers = useStore((s) => s.computers);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => runsOnChoices(devices ?? [], computers), [devices, computers]);
  if (harnessInfo(agent.harness)?.protocol === "mcp") return null;
  const now = agentRunsOn(agent, computers);
  const label = (now && choices.find((c) => c.key === now)?.label) ?? devices?.find((d) => d.id === agent.nodeId)?.name ?? (agent.nodeId ? "A device" : "No device yet");
  const move = async (key: string) => {
    setOpen(false);
    const pick = choices.find((c) => c.key === key);
    if (!pick || key === now) return;
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, runsOnMove(agent, pick.to, computers));
      await Promise.all([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const can = canEdit && choices.length > 0;
  return (
    <>
      <Row icon={<Monitor size={18} strokeWidth={1.8} />} label="Runs on" onClick={can ? () => setOpen((o) => !o) : undefined}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <span className="truncate">{label}</span>}
      </Row>
      {open && (
        <div className="border-b border-line px-1.5 pb-1.5">
          <RunsOnList choices={choices} value={now} onPick={(k) => void move(k)} className="bg-transparent! shadow-none! p-0!" />
        </div>
      )}
      {error && <p role="alert" className="border-b border-line px-3.5 py-2 text-[13px] text-bad">{error}</p>}
    </>
  );
}

/** A page's top bar (board): back on the left, the title centred, Done on the right. */
function PageBar({ back, title, done, doneLabel = "Done", busy }: { back: string; title: string; done: () => void; doneLabel?: string; busy?: boolean }) {
  return (
    <header className="relative flex shrink-0 items-center justify-between px-3.5 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <a href={back} className="gl r11-circle" aria-label="Back">
        <ChevronLeft size={19} strokeWidth={2} />
      </a>
      <h2 className="pointer-events-none absolute inset-x-24 truncate text-center text-[15px] font-semibold">{title}</h2>
      <button type="button" onClick={done} disabled={busy} className="r11-done">
        {busy ? <Loader2 size={15} className="animate-spin" /> : doneLabel}
      </button>
    </header>
  );
}

/** Edit (board 12): name, look (bubble and chat background), voice calls and brain, in one place. */
export function EditAgent({ agent }: { agent: Agent }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const bg = useAgentBackground(agent.id);
  const headless = runsOnDevice(agent.harness);
  const rename = async (name: string) => {
    if (!name) throw new Error("A name is needed");
    await api("PATCH", `/api/agents/${agent.id}`, { name });
    await refreshAgents();
  };
  const background = !bg ? "Default" : bg.kind === "none" ? "None" : bg.kind === "photo" ? "Photo" : "Colour";
  return (
    <div className="r11-page flex min-h-full flex-1 flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <PageBar back={to(agent, "overview")} title={`Edit ${agent.name}`} done={() => go({ view: "agents", agentId: agent.id, tab: "overview" })} />
      <div className="flex justify-center pt-3.5 pb-4">
        <a href={to(agent, "look")} className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label={`Change ${agent.name}'s bubble`}>
          <AgentAvatar agent={agent} size={92} live />
          <span className="absolute -right-1 bottom-0 grid size-7 place-items-center rounded-full bg-[var(--r11-card)] text-ink shadow-[0_0_0_2px_var(--r11-page)]" aria-hidden>
            <Pencil size={13} strokeWidth={2.2} />
          </span>
        </a>
      </div>
      <div className="r11-sec pt-0.5">Name</div>
      <div className="r11-grp">
        <div className="r11-li">
          {canEdit ? <InPlace value={agent.name} onSave={rename} label="Name" maxLength={80} className="h-10 w-full bg-transparent text-[15px] outline-none" /> : agent.name}
        </div>
      </div>
      <div className="r11-sec">Look</div>
      <div className="r11-grp">
        <Row label="Bubble" href={to(agent, "look")} />
        <Row label="Chat background" value={background} href={to(agent, "wallpaper")} />
      </div>
      <div className="r11-sec">Voice calls</div>
      <div className="r11-voice mx-3.5 overflow-hidden rounded-[16px]">
        <VoiceChat agent={agent} />
      </div>
      <div className="r11-sec">Brain</div>
      <div className="r11-grp">
        <Row label="Model" value={headless ? (agent.model ? prettyModel(agent.model) : "Automatic") : `Set in ${harnessLabel(agent.harness)}`} href={to(agent, "model")} />
        <Row label="Harness" value={harnessLabel(agent.harness)} href={to(agent, "harness")} />
      </div>
    </div>
  );
}

type LookMode = "colour" | "describe" | "style" | "photo";

/**
 * Bubble look (board 12): Colour (twelve swatches), Describe (a few words give four bubbles to pick
 * from), Style (every part: shape, eyes, mouth, hats and the rest) or Photo (a picture in a circle
 * instead of the bubble, the same as the iPhone). Done saves it over what's saved, keeping other fields.
 */
export function BubbleLook({ agent, onDirty, active }: { agent: Agent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const fallback = useMemo(() => withParts(defaultAppearance(agent.handle), agent.handle), [agent.handle]);
  const saved = useMemo(() => (agent.settings.appearance ? withParts(agent.settings.appearance, agent.handle) : fallback), [agent.settings.appearance, agent.handle, fallback]);
  const [look, setLook] = useState<GhostAppearance>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(look) !== JSON.stringify(saved);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // coming back to it starts from what is saved
  useEffect(() => {
    if (active) setLook(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const done = async () => {
    if (!dirty) return go({ view: "agents", agentId: agent.id, tab: "settings" });
    setSaving(true);
    setError(null);
    try {
      // laid over what's saved, so fields this page doesn't show are kept (mergeLook)
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { appearance: mergeLook(agent.settings.appearance, look) } });
      await refreshAgents();
      onDirty(false);
      go({ view: "agents", agentId: agent.id, tab: "settings" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="r11-page flex min-h-full flex-1 flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <PageBar back={to(agent, "settings")} title="Bubble" done={() => void done()} busy={saving} />
      <BubblePicker look={look} onChange={setLook} name={agent.name} onReset={() => setLook({ ...fallback, photo: undefined })} start={saved.photo ? "photo" : "colour"} />
      {error && <p className="mt-3 px-6 text-center text-[13px] text-bad">{error}</p>}
    </div>
  );
}

/** Colour · Describe · Style, a big preview, and the pick: shared by Bubble look and the New agent sheet. */
export function BubblePicker({ look, onChange, name, onReset, start = "colour", size = 120 }: { look: GhostAppearance; onChange: (look: GhostAppearance) => void; name: string; onReset?: () => void; start?: LookMode; size?: number }) {
  const [mode, setMode] = useState<LookMode>(start);
  const [words, setWords] = useState("");
  const [options, setOptions] = useState<GhostAppearance[] | null>(null);
  const modes: [LookMode, string][] = [
    ["colour", "Colour"],
    ["describe", "Describe"],
    ["style", "Style"],
    ["photo", "Photo"],
  ];
  // picking a bubble (a colour, a described look, a style) puts the bubble back, as on the iPhone
  const bubble = (l: GhostAppearance) => onChange({ ...l, photo: undefined });
  return (
    <div className="flex flex-col">
      <div role="tablist" aria-label="How to pick its look" className="my-2.5 flex justify-center gap-1">
        {modes.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)} className={cx("r11-pill", mode !== id && "is-quiet")}>
            {label}
          </button>
        ))}
      </div>
      {mode !== "style" && (
        <div className="flex justify-center pt-3.5 pb-[18px]">
          <Ghost look={look} size={size} label={`${name}'s bubble`} />
        </div>
      )}
      {mode === "colour" && (
        <div className="r11-grp flex flex-col items-center gap-[18px] py-5">
          <div role="radiogroup" aria-label="Colour" className="grid grid-cols-6 gap-x-4 gap-y-3.5">
            {BOARD_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                role="radio"
                aria-checked={look.color?.toLowerCase() === c.hex}
                aria-label={c.name}
                title={c.name}
                onClick={() => bubble({ ...look, color: c.hex, color2: undefined })}
                className="r11-sw"
                style={{ background: `radial-gradient(circle at 34% 28%, color-mix(in srgb, ${c.hex} 35%, white), ${c.hex} 70%)` }}
              />
            ))}
          </div>
          {onReset && (
            <button type="button" onClick={onReset} className="self-start pl-5 text-[14px] text-[#0a84ff] hover:underline">
              Reset to default
            </button>
          )}
        </div>
      )}
      {mode === "describe" && (
        <div className="r11-grp flex flex-col gap-3.5 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (words.trim()) setOptions(looksFromWords(words));
            }}
            className="flex gap-2"
          >
            <input value={words} onChange={(e) => setWords(e.target.value)} placeholder="A calm green bubble with freckles" aria-label="Describe its look" maxLength={120} className="h-10 min-w-0 flex-1 rounded-[12px] bg-hover px-3 text-[15px] text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-ring/40" />
            <button type="submit" disabled={!words.trim()} className="r11-done h-10! disabled:opacity-40">
              Show
            </button>
          </form>
          {options && (
            <div role="radiogroup" aria-label="Pick one" className="grid grid-cols-4 gap-2">
              {options.map((o, i) => (
                <button key={i} type="button" role="radio" aria-checked={JSON.stringify(o) === JSON.stringify(look)} aria-label={`Look ${i + 1}`} onClick={() => bubble(o)} className={cx("grid aspect-square place-items-center rounded-[14px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40", JSON.stringify(o) === JSON.stringify(look) && "shadow-[inset_0_0_0_2px_var(--ink)]")}>
                  <Ghost look={o} size={52} animate={false} ambient={false} label="" />
                </button>
              ))}
            </div>
          )}
          {!options && <p className="text-[13px] text-muted">A few words: a colour, a hat, glasses, a smile. Pick from four.</p>}
        </div>
      )}
      {mode === "photo" && <PhotoPick look={look} onChange={onChange} />}
      {mode === "style" && (
        <div className="px-3.5">
          <LookEditor value={look} onChange={bubble} name={name} onReset={onReset} />
        </div>
      )}
    </div>
  );
}

/**
 * Photo (board 12, the same as the iPhone): a picture shown in a circle instead of the bubble. It's
 * cropped to a square of at most 512px and uploaded through the usual file upload; the bubble comes
 * back with "Use the bubble instead" (or by picking a colour, a described look or a style).
 */
function PhotoPick({ look, onChange }: { look: GhostAppearance; onChange: (look: GhostAppearance) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange({ ...look, photo: await uploadFace(file) });
    } catch (e) {
      setError((e as Error).message || "That photo didn't upload.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="r11-grp flex flex-col items-center gap-3 px-4 py-5">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" hidden onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ""))} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="r11-done inline-flex items-center gap-2 disabled:opacity-60">
        {busy && <Loader2 size={15} className="animate-spin" />}
        {busy ? "Uploading…" : look.photo ? "Choose another photo" : "Choose a photo"}
      </button>
      {look.photo && !busy && (
        <button type="button" onClick={() => onChange({ ...look, photo: undefined })} className="text-[14px] text-[#0a84ff] hover:underline">
          Use the bubble instead
        </button>
      )}
      {error ? <p className="text-center text-[13px] text-bad">{error}</p> : <p className="text-center text-[13px] text-muted">A square crop of the middle, shown in a circle.</p>}
    </div>
  );
}

// --- Computer (board 13) --------------------------------------------------------------------------

/**
 * An agent's computer (board 13): black, and watch first. Opening says Starting… then Connecting…;
 * Watching shows the screen, one line on what the agent is doing, and Take control; once you have
 * it, only "Give back to <name>" shows. The "…" holds the rest (full window, teach a task, its
 * computer's settings). `full`: it fills the window, and Escape or X closes it.
 */
export function ComputerStage({ agent, computer: given, full = false, onClose }: { agent: Agent; computer?: ComputerInfo; full?: boolean; onClose?: () => void }) {
  const own = useStore((s) => s.computers.find((c) => c.id === agent.computerId));
  // a computer handed in (a help request on a shared one) is followed live from the store
  const fresh = useStore((s) => (given ? s.computers.find((c) => c.id === given.id) : undefined));
  const computer = given ? (fresh ?? given) : own;
  const [big, setBig] = useState(false);
  const header = (right?: ReactNode) => (
    <header className="relative z-10 flex shrink-0 items-center justify-between px-3.5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
      {full ? (
        <button type="button" onClick={onClose} className="r11-stage-btn r11-circle" aria-label="Exit full window" title="Exit full window (Esc)">
          <X size={18} strokeWidth={2} />
        </button>
      ) : (
        <a href={to(agent, "overview")} className="r11-stage-btn r11-circle" aria-label={`Back to ${agent.name}`}>
          <ChevronLeft size={19} strokeWidth={2} />
        </a>
      )}
      <span className="pointer-events-none absolute inset-x-16 flex items-center justify-center gap-[7px] truncate font-semibold">
        <AgentAvatar agent={agent} size={26} />
        <span className="truncate">{agent.name}'s computer</span>
      </span>
      {right ?? <span className="size-10" />}
    </header>
  );
  if (!computer)
    return (
      <div className="r11-stage flex min-h-full flex-1 flex-col">
        {header()}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[14px] text-white/75">{agent.name} has no computer yet</p>
          <a href={to(agent, "computer")} className="r11-stage-btn r11-take">
            Give it a computer
          </a>
        </div>
      </div>
    );
  return (
    <>
      <Stage agent={agent} computer={computer} full={full} onClose={onClose} header={header} onBig={full ? undefined : () => setBig(true)} />
      {big && <ComputerWindow agent={agent} computer={computer} onClose={() => setBig(false)} />}
    </>
  );
}

/** The stage in a window of its own, over everything. */
export function ComputerWindow({ agent, computer, onClose }: { agent: Agent; computer: ComputerInfo; onClose: () => void }) {
  return toBody(
    <div className="r11-stage fixed inset-0 z-50 flex flex-col" role="dialog" aria-modal="true" aria-label={`${agent.name}'s computer`}>
      <ComputerStage agent={agent} computer={computer} full onClose={onClose} />
    </div>,
  );
}

function Stage({ agent, computer: c, full, onClose, header, onBig }: { agent: Agent; computer: ComputerInfo; full: boolean; onClose?: () => void; header: (right?: ReactNode) => ReactNode; onBig?: () => void }) {
  const me = useStore((s) => s.me);
  const state = useComputerState(c);
  const teach = useFeature("teach");
  const members = useStore((s) => s.members);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = !!me && c.controller?.id === me.user.id;
  const someoneElse = !!c.controller && !mine;
  const canControl = me?.role !== "guest" && c.online && !c.paused && !someoneElse;
  const live = c.online && !c.paused && c.status !== "stopped" && c.status !== "starting";
  const ownScreenDown = !!c.screens && !c.screens.includes(agent.id);
  const touched = useRef(0);
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const control = async (take: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/api/computers/${c.id}/control`, { take, ...(c.screens ? { agent: agent.id } : {}) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const wake = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/api/computers/${c.id}/start`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // while you use it, tell the hub now and then that you're still there (the screen's input skips the hub)
  const activity = () => {
    if (Date.now() - touched.current < 15_000) return;
    touched.current = Date.now();
    void api("POST", `/api/computers/${c.id}/control`, { take: true, ...(c.screens ? { agent: agent.id } : {}) }).catch(() => {});
  };
  // leaving gives it back, so the agent isn't stuck waiting on a closed view
  useEffect(
    () => () => {
      if (mineRef.current) void api("POST", `/api/computers/${c.id}/control`, { take: false }).catch(() => {});
    },
    [c.id],
  );
  const overlayId = useRef(Symbol("screen")).current;
  useOverlay(overlayId, "screen", full);
  useEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => {
      // while in control, Escape belongs to the remote computer
      if (e.key === "Escape" && !mineRef.current && isTopOverlay(overlayId)) onClose?.();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [full, onClose, overlayId]);

  const someone = c.controller ? (members.find((m) => m.id === c.controller!.id)?.name ?? "Someone") : null;
  const line = c.help && c.help.agentId === agent.id ? `${agent.name} needs you: ${c.help.request}` : someoneElse ? `${someone} is using it` : state.working && c.activity?.text ? `${agent.name}: ${c.activity.text}` : state.working ? `${agent.name} is working` : `${agent.name} isn't using it right now`;
  const menu = [
    ...(onBig && live ? [{ label: "Full window", icon: <Maximize2 size={15} />, onSelect: onBig }] : []),
    ...(teach && canControl ? [{ label: "Teach a task", icon: <Video size={15} />, onSelect: () => go({ view: "computers", computerId: c.id, teach: agent.id }) }] : []),
    { label: "Computer settings", icon: <Settings2 size={15} />, onSelect: () => go({ view: "agents", agentId: agent.id, tab: "computer" }) },
  ];
  const more = (
    <Menu
      align="right"
      items={menu}
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} className="r11-stage-btn r11-circle" aria-label="More">
          <Ellipsis size={19} strokeWidth={2} />
        </button>
      )}
    />
  );

  return (
    <div className={cx("r11-stage relative flex flex-1 flex-col", full ? "h-full" : "min-h-full")}>
      {!mine && header(more)}
      <div className={cx("relative flex min-h-0 flex-1 items-center justify-center", mine ? "absolute inset-0" : "")}>
        {live ? (
          ownScreenDown ? (
            <div className="relative aspect-[16/10] w-full">
              <ScreenThumb computer={c} agentId={agent.id} quiet className="h-full w-full rounded-none" />
            </div>
          ) : (
            <div className="relative h-full w-full">
              <LiveScreen computer={c} control={mine} noRing compact={!full} onActivity={activity} agentId={c.screens ? agent.id : undefined} />
            </div>
          )
        ) : c.status === "starting" ? (
          <div className="flex flex-col items-center gap-2.5" role="status">
            <span className="r11-spin" aria-hidden />
            <span className="text-[14px] text-white/75">{c.statusText && !/^starting/i.test(c.statusText) ? c.statusText : "Starting the computer…"}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <Ghost look={c.online && !c.paused ? (agent.settings.appearance ?? defaultAppearance(agent.handle)) : { ...(agent.settings.appearance ?? defaultAppearance(agent.handle)), color: "#8d8d8d", color2: undefined }} size={52} mood="asleep" ambient={false} label="asleep" />
            <p className="text-[14px] text-white/75">{!c.online ? `${c.name} is offline` : c.paused ? `${c.name} is paused` : "The computer is off"}</p>
            {c.online && !c.paused && me?.role !== "guest" && (
              <button type="button" onClick={() => void wake()} disabled={busy} className="r11-stage-btn r11-take">
                {busy ? <Loader2 size={15} className="animate-spin" /> : null} Turn it on
              </button>
            )}
          </div>
        )}
      </div>
      {live && (
        <div className={cx("relative z-10 flex shrink-0 items-center gap-3 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]", mine ? "absolute inset-x-0 bottom-0 justify-end" : "justify-between")}>
          {!mine && <span className="min-w-0 truncate text-[13px] text-white/70">{line}</span>}
          {mine ? (
            <button type="button" onClick={() => void control(false)} disabled={busy} className="r11-take r11-giveback">
              Give back to {agent.name}
            </button>
          ) : (
            canControl &&
            !ownScreenDown && (
              <button type="button" onClick={() => void control(true)} disabled={busy} className="r11-stage-btn r11-take">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Hand size={15} strokeWidth={2} aria-hidden />} Take control
              </button>
            )
          )}
        </div>
      )}
      {error && <p className="relative z-10 shrink-0 px-4 pb-3 text-center text-[13px] text-[#ff8a80]">{error}</p>}
    </div>
  );
}
