import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Moon, Brain, RotateCcw, Shuffle, Sun } from "../icons.tsx";
import type { Agent } from "@warren/core";
import { GHOST_ACCESSORIES, GHOST_PALETTES, GHOST_EYES, GHOST_HATS, GHOST_MOTIONS, GHOST_MOUTHS, GHOST_SHAPES, defaultAppearance, randomAppearance, type GhostAppearance } from "@warren/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Ghost, type GhostMood } from "../components/Ghost.tsx";
import { Button, cx } from "../components/ui.tsx";
import { Intro, SaveBar } from "./SettingsParts.tsx";

const LABELS: Record<string, string> = {
  classic: "Classic",
  round: "Round",
  tall: "Tall",
  sheet: "Bedsheet",
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
  sunglasses: "Shades",
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

/** The agent's ghost: shape, colors, face, outfit and how it moves. */
export function LookPanel({ agent, onDirty, active }: { agent: Agent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const fallback = useMemo(() => defaultAppearance(agent.handle), [agent.handle]);
  const saved = agent.settings.appearance ?? fallback;
  const [look, setLook] = useState<GhostAppearance>(saved);
  const [mood, setMood] = useState<GhostMood>("awake");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(look) !== JSON.stringify(saved);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const set = <K extends keyof GhostAppearance>(k: K, v: GhostAppearance[K]) => setLook((l) => ({ ...l, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { appearance: look } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Intro title="Look">
        <p>Every agent is a little ghost. Dress {agent.name} up; it shows everywhere it appears, concentrates while it works, and naps in gray when its device is offline.</p>
      </Intro>

      <div className="grid lg:grid-cols-[300px_1fr] gap-6 items-start">
        {/* stage */}
        <div className="lg:sticky lg:top-0 space-y-3">
          <div className="rounded-2xl border border-line bg-bg overflow-hidden">
            <div className="h-64 grid place-items-center">
              <Ghost look={look} size={190} mood={mood} wave label={`${agent.name}'s ghost`} />
            </div>
          </div>
          <div className="flex rounded-xl border border-line p-0.5" role="radiogroup" aria-label="Preview mood">
            {(
              [
                ["awake", "Awake", <Sun key="s" size={14} />],
                ["thinking", "Working", <Brain key="b" size={14} />],
                ["asleep", "Offline", <Moon key="m" size={14} />],
              ] as const
            ).map(([m, label, icon]) => (
              <button key={m} role="radio" aria-checked={mood === m} onClick={() => setMood(m)} className={cx("flex-1 h-8 rounded-lg text-sm inline-flex items-center justify-center gap-1.5", mood === m ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink")}>
                {icon} {label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setLook(randomAppearance())}>
              <Shuffle size={15} /> Shuffle
            </Button>
            <Button variant="ghost" onClick={() => setLook(fallback)} title="Back to its original ghost">
              <RotateCcw size={15} /> Reset
            </Button>
          </div>
        </div>

        {/* controls */}
        <div className="space-y-7 min-w-0">
          <Group title="Shape">
            <Tiles>
              {GHOST_SHAPES.map((v) => (
                <Tile key={v} label={LABELS[v]} selected={look.shape === v} onClick={() => set("shape", v)}>
                  <Ghost look={{ ...look, shape: v, hat: "none", accessory: "none" }} size={56} animate={false} />
                </Tile>
              ))}
            </Tiles>
          </Group>

          <Group title="Colors">
            <div className="flex flex-wrap items-center gap-2">
              {GHOST_PALETTES.map((p) => {
                const selected = look.color.toLowerCase() === p.color && look.color2?.toLowerCase() === p.color2;
                return (
                  <button
                    key={p.name}
                    onClick={() => setLook((l) => ({ ...l, color: p.color, color2: p.color2 }))}
                    title={p.name}
                    aria-label={p.name}
                    aria-pressed={selected}
                    className={cx("size-9 rounded-full border border-black/10 transition-transform", selected ? "ring-2 ring-offset-2 ring-offset-panel ring-accent scale-105" : "hover:scale-105")}
                    style={{ background: `linear-gradient(180deg, ${p.color}, ${p.color2})` }}
                  />
                );
              })}
              {/* any two colors: the left half picks the top, the right half the bottom */}
              <span
                className={cx("relative size-9 rounded-full border border-line overflow-hidden flex", !GHOST_PALETTES.some((p) => p.color === look.color.toLowerCase() && p.color2 === look.color2?.toLowerCase()) && "ring-2 ring-offset-2 ring-offset-panel ring-accent")}
                title="Pick your own top and bottom colors"
              >
                <label className="relative flex-1 cursor-pointer" style={{ background: look.color }}>
                  <input type="color" value={look.color} onChange={(e) => set("color", e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Top color" />
                </label>
                <label className="relative flex-1 cursor-pointer" style={{ background: look.color2 ?? look.color }}>
                  <input type="color" value={look.color2 ?? look.color} onChange={(e) => set("color2", e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Bottom color" />
                </label>
              </span>
              <Switch checked={look.glow} onChange={(v) => set("glow", v)} label="Glow" />
            </div>
          </Group>

          <Group title="Eyes">
            <Tiles>
              {GHOST_EYES.map((v) => (
                <Tile key={v} label={LABELS[v]} selected={look.eyes === v} onClick={() => set("eyes", v)}>
                  <Face look={{ ...look, eyes: v }} />
                </Tile>
              ))}
            </Tiles>
          </Group>

          <Group title="Mouth" extra={<Switch checked={look.cheeks} onChange={(v) => set("cheeks", v)} label="Blush" />}>
            <Tiles>
              {GHOST_MOUTHS.map((v) => (
                <Tile key={v} label={LABELS[v]} selected={look.mouth === v} onClick={() => set("mouth", v)}>
                  <Face look={{ ...look, mouth: v }} />
                </Tile>
              ))}
            </Tiles>
          </Group>

          <Group title="Hat">
            <Tiles>
              {GHOST_HATS.map((v) => (
                <Tile key={v} label={LABELS[v]} selected={look.hat === v} onClick={() => set("hat", v)}>
                  <Ghost look={{ ...look, hat: v }} size={56} animate={false} />
                </Tile>
              ))}
            </Tiles>
          </Group>

          <Group title="Accessory">
            <Tiles>
              {GHOST_ACCESSORIES.map((v) => (
                <Tile key={v} label={LABELS[v]} selected={look.accessory === v} onClick={() => set("accessory", v)}>
                  <Ghost look={{ ...look, accessory: v, hat: "none" }} size={56} animate={false} />
                </Tile>
              ))}
            </Tiles>
          </Group>

          <Group title="Motion">
            <div className="inline-flex flex-wrap rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Motion">
              {GHOST_MOTIONS.map((v) => (
                <button key={v} role="radio" aria-checked={look.motion === v} onClick={() => set("motion", v)} className={cx("px-3 h-8 rounded-md text-sm", look.motion === v ? "bg-accent text-accent-ink font-medium" : "text-muted hover:text-ink")}>
                  {LABELS[v]}
                </button>
              ))}
            </div>
          </Group>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setLook(saved)} active={active} note={agent.settings.appearance ? "Looking good." : "Using its original ghost."} />
    </div>
  );
}

/** A close-up of the face, for eye and mouth options. */
function Face({ look }: { look: GhostAppearance }) {
  return (
    <span className="block size-14 overflow-hidden rounded-full">
      <span className="block origin-center" style={{ transform: "scale(1.9) translateY(4%)" }}>
        <Ghost look={{ ...look, hat: "none", accessory: "none", glow: false }} size={56} animate={false} />
      </span>
    </span>
  );
}

function Group({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">{children}</div>;
}

function Tile({ label, selected, onClick, children }: { label: string; selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx("rounded-xl border p-2 flex flex-col items-center gap-1 transition-colors", selected ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}
    >
      {children}
      <span className={cx("text-xs", selected ? "text-accent-text font-medium" : "text-muted")}>{label}</span>
    </button>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none ml-1">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cx("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-accent" : "bg-chip")}>
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      {label}
    </label>
  );
}
