import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, RotateCcw, Shuffle } from "lucide-react";
import type { Agent } from "@warren/core";
import { GHOST_ACCESSORIES, GHOST_EYES, GHOST_HATS, GHOST_MOTIONS, GHOST_MOUTHS, GHOST_SHAPES, defaultAppearance, randomAppearance, type GhostAppearance } from "@warren/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { GhostColors } from "../components/GhostColors.tsx";
import { Ghost } from "../components/Ghost.tsx";
import { Button, cx } from "../components/ui.tsx";
import { Toggle } from "./settings/parts.tsx";
import { VoicePicker } from "../voice/VoicePicker.tsx";
import { Intro, SaveBar } from "./SettingsParts.tsx";

/** What each option is called on screen. The option lists themselves come from core, so they always match the hub. */
export const LOOK_LABELS: Record<string, string> = {
  classic: "Classic",
  round: "Round",
  tall: "Tall",
  sheet: "Sheet",
  wisp: "Wisp",
  dots: "Dots",
  big: "Big",
  happy: "Happy",
  sparkle: "Sparkle",
  wink: "Wink",
  smile: "Smile",
  open: "Open",
  cat: "Cat",
  fangs: "Fangs",
  tongue: "Tongue",
  none: "None",
  tophat: "Top hat",
  party: "Party",
  beanie: "Beanie",
  crown: "Crown",
  witch: "Witch",
  headphones: "Headphones",
  bow: "Bow",
  halo: "Halo",
  flower: "Flower",
  propeller: "Propeller",
  glasses: "Glasses",
  sunglasses: "Sunglasses",
  monocle: "Monocle",
  bowtie: "Bow tie",
  scarf: "Scarf",
  tie: "Tie",
  mustache: "Mustache",
  float: "Float",
  bounce: "Bounce",
  sway: "Sway",
  still: "Still",
};

/** The moods you can preview a look in. */
type PreviewMood = "awake" | "working" | "asleep";
const MOODS: [PreviewMood, string][] = [
  ["awake", "Awake"],
  ["working", "Working"],
  ["asleep", "Asleep"],
];

/**
 * The full look editor: a big preview that watches your pointer, a mood preview, and every option
 * as chips (colors, shape, eyes, mouth, hat, accessory, motion) plus rosy cheeks.
 * Controlled: the caller keeps the look and decides when to save.
 */
export function LookEditor({ value: look, onChange, name, below, extra, speakingLevel }: { value: GhostAppearance; onChange: (look: GhostAppearance) => void; name: string; below?: ReactNode; extra?: ReactNode; speakingLevel?: number }) {
  const [mood, setMood] = useState<PreviewMood>("awake");
  const set = <K extends keyof GhostAppearance>(k: K, v: GhostAppearance[K]) => onChange({ ...look, [k]: v });
  return (
    <div className="grid lg:grid-cols-[minmax(280px,400px)_1fr] gap-6 lg:gap-8 items-start">
      {/* preview */}
      <div className="lg:sticky lg:top-0 space-y-3">
        <div className="rounded-[1.75rem] bg-bg border border-line h-72 sm:h-96 grid place-items-center overflow-hidden">
          <Ghost look={look} size={240} mood={mood} speakingLevel={speakingLevel} trackPointer interactive label={`${name}'s ghost, looking toward your pointer`} />
        </div>
        <div>
          <div className="text-[13px] font-semibold text-muted mb-1.5">Preview a mood</div>
          <div className="flex rounded-xl bg-chip p-0.5" role="radiogroup" aria-label="Preview a mood">
            {MOODS.map(([m, label]) => (
              <button key={m} type="button" role="radio" aria-checked={mood === m} onClick={() => setMood(m)} className={cx("flex-1 h-8 rounded-[10px] text-[13px] font-semibold", mood === m ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {below}
      </div>

      {/* options */}
      <div className="space-y-6 min-w-0">
        {extra}
        <Section title="Colors">
          <GhostColors look={look} onChange={(c) => onChange({ ...look, ...c })} labels />
        </Section>
        <Chips title="Shape" options={GHOST_SHAPES} value={look.shape} onPick={(v) => set("shape", v)} />
        <Chips title="Eyes" options={GHOST_EYES} value={look.eyes} onPick={(v) => set("eyes", v)} />
        <Chips title="Mouth" options={GHOST_MOUTHS} value={look.mouth} onPick={(v) => set("mouth", v)} />
        <Chips title="Hat" options={GHOST_HATS} value={look.hat} onPick={(v) => set("hat", v)} />
        <Chips title="Accessory" options={GHOST_ACCESSORIES} value={look.accessory} onPick={(v) => set("accessory", v)} />
        <Chips title="Motion" options={GHOST_MOTIONS} value={look.motion} onPick={(v) => set("motion", v)} />
        <section className="rounded-2xl border border-line divide-y divide-line">
          <SwitchRow name="Rosy cheeks" body="A little blush under the eyes." on={look.cheeks} onChange={(v) => set("cheeks", v)} />
        </section>
      </div>
    </div>
  );
}

/**
 * The look editor as its own screen (from New agent's "Edit look"): back, the agent's name,
 * Shuffle and Save. It works on a copy; Save hands the look back.
 */
export function LookEditorScreen({ initial, name, onSave, onBack, saving = false, saveLabel = "Save look", error }: { initial: GhostAppearance; name: string; onSave: (look: GhostAppearance) => void; onBack: () => void; saving?: boolean; saveLabel?: string; error?: string | null }) {
  const [look, setLook] = useState(initial);
  const who = name.trim() || "Your agent";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="size-9 rounded-xl bg-chip hover:bg-hover grid place-items-center text-muted hover:text-ink" aria-label="Back">
          <ArrowLeft size={17} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight truncate">
            {who}'s look
          </h1>
          <p className="text-sm text-muted">Everything here shows up wherever {name.trim() || "it"} appears. Move your pointer over the preview and it watches.</p>
        </div>
        <Button type="button" onClick={() => setLook(randomAppearance())}>
          <Shuffle size={15} /> Shuffle
        </Button>
        <Button type="button" variant="primary" disabled={saving} onClick={() => onSave(look)}>
          {saving && <Loader2 size={15} className="animate-spin" />} {saveLabel}
        </Button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <LookEditor value={look} onChange={setLook} name={who} />
    </div>
  );
}

/** The agent page's Look tab: the full editor plus its voice, saved with the page's save bar. */
export function LookPanel({ agent, onDirty, active }: { agent: Agent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const fallback = useMemo(() => defaultAppearance(agent.handle), [agent.handle]);
  const saved = agent.settings.appearance ?? fallback;
  const [look, setLook] = useState<GhostAppearance>(saved);
  const [voice, setVoice] = useState(agent.settings.voice ?? {});
  const [speakingLevel, setSpeakingLevel] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(look) !== JSON.stringify(saved) || JSON.stringify(voice) !== JSON.stringify(agent.settings.voice ?? {});
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { appearance: look, voice } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Intro title="Look">
        <p>Every agent is a little ghost. Dress {agent.name} up; it shows everywhere it appears, concentrates while it works, and naps in gray when its device is offline.</p>
      </Intro>
      <LookEditor
        value={look}
        onChange={setLook}
        name={agent.name}
        below={
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setLook(randomAppearance())}>
              <Shuffle size={15} /> Shuffle
            </Button>
            <Button variant="ghost" onClick={() => setLook(fallback)} title="Back to its original ghost">
              <RotateCcw size={15} /> Reset
            </Button>
          </div>
        }
        speakingLevel={speakingLevel}
        extra={<VoicePicker agent={agent} value={voice} onChange={setVoice} onLevel={setSpeakingLevel} />}
      />
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => { setLook(saved); setVoice(agent.settings.voice ?? {}); }} active={active} note={agent.settings.appearance ? "Looking good." : "Using its original ghost."} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Chips<T extends string>({ title, options, value, onPick }: { title: string; options: readonly T[]; value: T; onPick: (v: T) => void }) {
  return (
    <Section title={title}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={title}>
        {options.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onPick(v)}
            className={cx("h-9 px-3.5 rounded-full border text-[13px] font-semibold transition-colors", value === v ? "bg-ink text-bg border-ink" : "bg-panel text-ink border-line hover:bg-hover")}
          >
            {LOOK_LABELS[v] ?? v}
          </button>
        ))}
      </div>
    </Section>
  );
}

function SwitchRow({ name, body, on, onChange }: { name: string; body: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{name}</div>
        <div className="text-[13px] text-muted">{body}</div>
      </div>
      <Toggle on={on} onChange={onChange} label={name} />
    </div>
  );
}
