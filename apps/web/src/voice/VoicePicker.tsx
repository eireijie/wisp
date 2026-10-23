import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentSettings } from "@warren/core";
import { Play, Square } from "lucide-react";
import { api } from "../api.ts";
import { Advanced } from "../experience.tsx";
import { Button, cx, Input } from "../components/ui.tsx";
import { Select } from "../views/settings/parts.tsx";
import { createSpeaker, deviceVoices, ELEVEN_VOICES, OPENAI_VOICES, type VoiceSettings, type VoiceSpeaker } from "./providers.ts";

export interface VoiceInfo { name: string; lang: string; voiceURI: string; localService?: boolean; default?: boolean }

// The macOS novelty voices. They are fun, but nobody wants one as a helper's everyday voice.
const NOVELTY = new Set(["albert", "bad news", "bahh", "boing", "bubbles", "cellos", "good news", "jester", "organ", "superstar", "trinoids", "whisper", "wobble", "zarvox", "fred", "junior", "ralph", "kathy"]);

const normTag = (tag: string) => tag.replace("_", "-").toLowerCase();
const baseOf = (tag: string) => normTag(tag).split("-")[0];
/** "Eddy (English (US))" -> "eddy": the voice's own name, without the language suffix. */
const bareName = (name: string) => name.replace(/\s*\(.*$/, "").trim().toLowerCase();

export function isNovelty(voice: Pick<VoiceInfo, "name">) { return NOVELTY.has(bareName(voice.name)); }

function quality(name: string) {
  if (/natural|enhanced|premium/i.test(name)) return 4;
  if (/compact/i.test(name)) return -3;
  return 0;
}

/** A short, friendly list for a person's language: same region first, then good-sounding local voices. */
export function recommendVoices<T extends VoiceInfo>(voices: T[], language: string, count = 4): T[] {
  const tag = normTag(language || "en"), base = baseOf(tag);
  const usable = voices.filter((v) => !isNovelty(v));
  const sameBase = usable.filter((v) => baseOf(v.lang) === base);
  const pool = sameBase.length ? sameBase : usable;
  const score = (v: T) => (normTag(v.lang) === tag ? 8 : 0) + (v.localService ? 2 : 0) + (v.default ? 2 : 0) + quality(v.name);
  const seen = new Set<string>();
  return pool
    .map((v, i) => ({ v, i, s: score(v) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.v)
    .filter((v) => { const key = bareName(v.name); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, count);
}

/** Search by name and narrow to one language. An empty `lang` means every language. */
export function filterVoices<T extends VoiceInfo>(voices: T[], { query, lang }: { query: string; lang: string }): T[] {
  const q = query.trim().toLowerCase();
  const tag = lang ? normTag(lang) : "";
  return voices.filter((v) => (!tag || normTag(v.lang) === tag) && (!q || v.name.toLowerCase().includes(q)));
}

/** "English (United States)" when the browser can say it, the plain tag otherwise. */
export function languageLabel(tag: string, displayLocale = "en"): string {
  const clean = tag.replace("_", "-");
  try {
    const Names = (Intl as unknown as { DisplayNames?: new (l: string[], o: object) => { of(code: string): string | undefined } }).DisplayNames;
    if (!Names) return clean;
    return new Names([displayLocale], { type: "language", languageDisplay: "standard" }).of(clean) || clean;
  } catch { return clean; }
}

/** The language-filter value to start on: the person's own language if any voice speaks it. */
export function defaultLanguage(voices: VoiceInfo[], language: string): string {
  const tag = normTag(language || "en"), base = baseOf(tag);
  const exact = voices.find((v) => normTag(v.lang) === tag);
  if (exact) return exact.lang;
  return voices.find((v) => baseOf(v.lang) === base)?.lang ?? "";
}

interface Choice { id: string; label: string; detail?: string }

function Choices({ label, choices, selected, playing, disabled, onSelect, onListen }: { label: string; choices: Choice[]; selected: string; playing: string | null; disabled?: boolean; onSelect(id: string): void; onListen(id: string): void }) {
  return <div role="radiogroup" aria-label={label} className="rounded-xl border border-line divide-y divide-line">
    {choices.map((c) => {
      const on = c.id === selected;
      return <div key={c.id} className={cx("flex items-center gap-2 pr-2", on && "bg-accent-soft")}>
        <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onSelect(c.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50">
          <span className={cx("block truncate", on ? "font-medium text-accent-text" : "text-ink")}>{c.label}</span>
          {c.detail && <span className="block truncate text-xs text-muted">{c.detail}</span>}
        </button>
        {on && <span className="text-xs text-accent-text" aria-hidden>Chosen</span>}
        <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => onListen(c.id)} aria-label={`${playing === c.id ? "Stop" : "Listen to"} ${c.label}`}>
          {playing === c.id ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          {playing === c.id ? "Stop" : "Listen"}
        </Button>
      </div>;
    })}
  </div>;
}

export function VoicePicker({ agent, value, onChange, onLevel }: { agent: Agent; value: AgentSettings["voice"]; onChange(value: NonNullable<AgentSettings["voice"]>): void; onLevel(level: number | undefined): void }) {
  const [engine, setEngine] = useState<VoiceSettings["speak"]>("device");
  const [voices, setVoices] = useState(deviceVoices);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const speaker = useRef<VoiceSpeaker | null>(null);
  const generation = useRef(0);
  const language = typeof navigator === "undefined" ? "en" : navigator.language || "en";
  useEffect(() => {
    const update = () => setVoices(deviceVoices());
    window.speechSynthesis?.addEventListener("voiceschanged", update);
    return () => { generation.current++; speaker.current?.cancel(); window.speechSynthesis?.removeEventListener("voiceschanged", update); };
  }, []);
  useEffect(() => { let alive = true; void api<VoiceSettings>("GET", "/api/voice/settings").then((s) => { if (alive) setEngine(s.speak); }, () => {}); return () => { alive = false; }; }, []);

  /** Play (or stop) a sample. `id` is the voice to try; "" means this helper's automatic voice. */
  const preview = async (id: string) => {
    const current = ++generation.current;
    speaker.current?.cancel();
    if (playing === id) { setPlaying(null); onLevel(undefined); return; }
    setPlaying(id); setError("");
    try {
      // Preview never constructs a listener or requests the microphone.
      speaker.current = createSpeaker(engine, { ...value, [engine]: id }, agent.handle);
      await speaker.current.speak(`Hi, I'm ${agent.name}. It's lovely to hear from you!`, (level) => { if (current === generation.current) onLevel(level); });
    } catch (e) { if (current === generation.current) setError((e as Error).message); }
    finally { if (current === generation.current) { setPlaying(null); onLevel(undefined); } }
  };
  const switchEngine = (next: VoiceSettings["speak"]) => {
    generation.current++; speaker.current?.cancel(); setPlaying(null); onLevel(undefined); setError("");
    setEngine(next);
  };

  const activeLang = lang ?? defaultLanguage(voices, language);
  const recommended = useMemo(() => recommendVoices(voices, language), [voices, language]);
  const languages = useMemo(() => [...new Set(voices.map((v) => v.lang))].sort((a, b) => languageLabel(a, language).localeCompare(languageLabel(b, language))), [voices, language]);
  const filtered = useMemo(() => filterVoices(voices, { query, lang: activeLang }), [voices, query, activeLang]);

  const auto: Choice = { id: "", label: `Automatic for ${agent.name}`, detail: "A voice picked for this helper" };
  const asChoice = (v: VoiceInfo): Choice => ({ id: v.voiceURI, label: v.name, detail: languageLabel(v.lang, language) });
  const selected = value?.[engine] ?? "";
  let choices: Choice[];
  if (engine === "device") {
    const picked = selected && !recommended.some((v) => v.voiceURI === selected) ? voices.find((v) => v.voiceURI === selected) : undefined;
    choices = [auto, ...(picked ? [asChoice(picked)] : []), ...recommended.map(asChoice)];
  } else if (engine === "openai") choices = [auto, ...OPENAI_VOICES.map((v) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) }))];
  else choices = [auto, ...ELEVEN_VOICES.map((v) => ({ id: v.id, label: v.name }))];
  // A saved voice this browser no longer lists still shows up, so the choice is never hidden.
  if (selected && !choices.some((c) => c.id === selected)) choices.push({ id: selected, label: "Saved voice", detail: selected });

  return <section id="voice-picker" className="space-y-3">
    <h4 className="text-sm font-semibold">Voice</h4>
    <p className="text-xs text-muted">Choose how {agent.name} sounds. Press Listen to hear a voice before you pick it. Calls use the voice type you choose in <a href="#/settings/voice" className="underline">Settings → Notifications → Voice</a>.</p>
    <Select label="Voice type to choose from" value={engine} disabled={playing !== null} onChange={(v) => switchEngine(v as VoiceSettings["speak"])}><option value="device">On this device (free)</option><option value="openai">OpenAI (online)</option><option value="elevenlabs">ElevenLabs (online)</option></Select>
    {engine === "device" && <h5 className="text-xs font-medium text-muted">Recommended for you</h5>}
    <Choices label={`${agent.name}'s voice`} choices={choices} selected={selected} playing={playing} onSelect={(id) => onChange({ ...value, [engine]: id })} onListen={preview} />
    {engine === "device" && voices.length === 0 && <p className="text-xs text-muted">This device hasn't listed any voices yet. Try again in a moment.</p>}
    {engine === "device" && voices.length > 0 && <div>
      <button type="button" aria-expanded={showAll} aria-controls="all-voices" onClick={() => setShowAll(!showAll)} className="text-xs text-muted underline hover:text-ink">{showAll ? "Hide all voices" : "All voices"}</button>
      {showAll && <div id="all-voices" className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Search voices by name" type="search" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 basis-40" />
          <Select label="Language" value={activeLang} onChange={setLang} className="max-w-full">
            <option value="">All languages</option>
            {languages.map((l) => <option key={l} value={l}>{languageLabel(l, language)}</option>)}
          </Select>
        </div>
        {filtered.length ? <div className="max-h-72 overflow-y-auto rounded-xl">
          <Choices label="All voices" choices={filtered.map(asChoice)} selected={selected} playing={playing} onSelect={(id) => onChange({ ...value, device: id })} onListen={preview} />
        </div> : <p className="text-xs text-muted">No voices match. Clear the search or choose another language.</p>}
      </div>}
    </div>}
    {engine === "elevenlabs" && <Advanced title="Advanced: use your own ElevenLabs voice">
      <Input aria-label="Custom ElevenLabs voice ID" placeholder="Paste your ElevenLabs voice ID" value={value?.elevenlabs ?? ""} disabled={playing !== null} onChange={(e) => onChange({ ...value, elevenlabs: e.target.value })} />
    </Advanced>}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
  </section>;
}
