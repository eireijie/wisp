import { useEffect, useRef, useState } from "react";
import type { Agent, AgentSettings } from "@warren/core";
import { api } from "../api.ts";
import { Button, Input } from "../components/ui.tsx";
import { Select } from "../views/settings/parts.tsx";
import { createSpeaker, deviceVoices, ELEVEN_VOICES, OPENAI_VOICES, type VoiceSettings, type VoiceSpeaker } from "./providers.ts";

export function VoicePicker({ agent, value, onChange, onLevel }: { agent: Agent; value: AgentSettings["voice"]; onChange(value: NonNullable<AgentSettings["voice"]>): void; onLevel(level: number | undefined): void }) {
  const [engine, setEngine] = useState<VoiceSettings["speak"]>("device");
  const [voices, setVoices] = useState(deviceVoices);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const speaker = useRef<VoiceSpeaker | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const update = () => setVoices(deviceVoices());
    window.speechSynthesis?.addEventListener("voiceschanged", update);
    return () => { generation.current++; speaker.current?.cancel(); window.speechSynthesis?.removeEventListener("voiceschanged", update); };
  }, []);
  const preview = async () => {
    const current = ++generation.current;
    speaker.current?.cancel();
    if (playing) { setPlaying(false); onLevel(undefined); return; }
    setPlaying(true); setError("");
    try {
      // Preview never constructs a listener or requests the microphone.
      speaker.current = createSpeaker(engine, value, agent.handle);
      await speaker.current.speak(`Hi, I'm ${agent.name}. It's lovely to hear from you!`, (level) => { if (current === generation.current) onLevel(level); });
    } catch (e) { if (current === generation.current) setError((e as Error).message); }
    finally { if (current === generation.current) { setPlaying(false); onLevel(undefined); } }
  };
  useEffect(() => { let alive = true; void api<VoiceSettings>("GET", "/api/voice/settings").then((s) => { if (alive) setEngine(s.speak); }, () => {}); return () => { alive = false; }; }, []);
  return <section className="space-y-2">
    <h4 className="text-sm font-semibold">Voice</h4>
    <p className="text-xs text-muted">Each ghost gets its own default. Choose a voice for any engine; calls use your choice in <a href="#/settings/voice" className="underline">Settings → Voice</a>.</p>
    <div className="flex flex-wrap gap-2">
      <Select label="Voice engine to preview" value={engine} disabled={playing} onChange={(v) => setEngine(v as VoiceSettings["speak"])}><option value="device">On this device</option><option value="openai">OpenAI</option><option value="elevenlabs">ElevenLabs</option></Select>
      <Select label={`${engine} voice`} value={value?.[engine] ?? ""} disabled={playing} onChange={(v) => onChange({ ...value, [engine]: v })} className="max-w-full">
        <option value="">Automatic for {agent.name}</option>
        {engine === "device" ? voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>) : engine === "openai" ? OPENAI_VOICES.map((v) => <option key={v}>{v}</option>) : ELEVEN_VOICES.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        {value?.[engine] && !(engine === "device" ? voices.map((v) => v.voiceURI) : engine === "openai" ? OPENAI_VOICES : ELEVEN_VOICES.map((v) => v.id)).includes(value[engine]!) && <option value={value[engine]}>Saved voice ({value[engine]})</option>}
      </Select>
      <Button onClick={preview}>{playing ? "Stop preview" : "Preview"}</Button>
    </div>
    {engine === "elevenlabs" && <Input aria-label="Custom ElevenLabs voice ID" placeholder="Or paste your ElevenLabs voice ID" value={value?.elevenlabs ?? ""} disabled={playing} onChange={(e) => onChange({ ...value, elevenlabs: e.target.value })} />}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
  </section>;
}
