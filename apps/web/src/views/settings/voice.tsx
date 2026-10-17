import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { Button, Input } from "../../components/ui.tsx";
import { DEFAULT_VOICE, type VoiceSettings } from "../../voice/providers.ts";
import { Card, PageHeader, Row, Section, Select } from "./parts.tsx";

export function VoicePage() {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { api<VoiceSettings>("GET", "/api/voice/settings").then((s) => { setSettings(s); setLoaded(true); }, (e) => setMessage(e.message)); }, []);
  const save = async () => {
    setSaving(true); setMessage("");
    try { setSettings(await api("PUT", "/api/voice/settings", settings)); setMessage("Saved. Your next call will use these settings."); }
    catch (e) { setMessage((e as Error).message); }
    finally { setSaving(false); }
  };
  return <>
    <PageHeader title="Voice">Call your ghosts, hands free. On this device is free and needs no key. Your browser may use its own online speech service.</PageHeader>
    <Section title="Your voice engines" description="These settings belong to you. Your microphone is requested only when you start a call.">
      <Card>
        <Row label="Listening" hint="How your speech becomes a chat message."><Select label="Listening engine" disabled={!loaded} value={settings.listen} onChange={(listen) => setSettings({ ...settings, listen: listen as VoiceSettings["listen"] })}><option value="device">On this device</option><option value="openai">OpenAI</option></Select></Row>
        <Row label="Speaking" hint="An AI voice reads a short version; the complete reply stays in chat."><Select label="Speaking engine" disabled={!loaded} value={settings.speak} onChange={(speak) => setSettings({ ...settings, speak: speak as VoiceSettings["speak"] })}><option value="device">On this device</option><option value="openai">OpenAI</option><option value="elevenlabs">ElevenLabs</option></Select></Row>
      </Card>
    </Section>
    <Section title="Bring your own key" description="Optional. Provider usage is billed to your account. Keys stay on your hub, masked on read like connector credentials. Clear a key and save to remove it.">
      <Card>
        <Row label="OpenAI API key" hint="Enables transcription and speech."><Input aria-label="OpenAI API key" type="password" autoComplete="off" disabled={!loaded} value={settings.openaiKey} onChange={(e) => setSettings({ ...settings, openaiKey: e.target.value })} /></Row>
        <Row label="ElevenLabs API key" hint="Enables speech; listening still uses your chosen engine."><Input aria-label="ElevenLabs API key" type="password" autoComplete="off" disabled={!loaded} value={settings.elevenlabsKey} onChange={(e) => setSettings({ ...settings, elevenlabsKey: e.target.value })} /></Row>
      </Card>
    </Section>
    <Button variant="primary" disabled={!loaded || saving} onClick={save}>{saving ? "Saving…" : "Save voice settings"}</Button>
    {message && <p role="status" className="text-sm text-muted mt-3">{message}</p>}
    <p className="mt-6 text-xs text-muted">Pick each ghost's voice in Agents → Look. For calls, use HTTPS or localhost. If browser recognition isn't available in your Electron build, OpenAI listening is an alternative. Headphones help with interruptions and speaker echo.</p>
  </>;
}
