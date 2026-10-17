import { useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { Button, Input } from "../../components/ui.tsx";
import { Advanced } from "../../experience.tsx";
import { href } from "../../router.ts";
import { useStore } from "../../store.ts";
import { canRecognize, createSpeaker, DEFAULT_VOICE, type VoiceSettings, type VoiceSpeaker } from "../../voice/providers.ts";
import { Card, PageHeader, Row, Section, Select } from "./parts.tsx";

type Result = { ok: boolean; text: string } | null;
const MIC_SECONDS = 3;

/** Listen to the microphone for a few seconds and say plainly whether it picked anything up. */
function useMicTest() {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<Result>(null);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const start = async () => {
    cleanup.current();
    setResult(null); setLevel(0);
    if (!navigator.mediaDevices?.getUserMedia) { setResult({ ok: false, text: "Microphone needs a secure connection (HTTPS or localhost)." }); return; }
    let stopped = false, frame = 0, timer: ReturnType<typeof setTimeout> | undefined, stream: MediaStream | undefined, context: AudioContext | undefined;
    const finish = (r?: Result) => {
      if (stopped) return;
      stopped = true; cancelAnimationFrame(frame); clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => {});
      setTesting(false); setLevel(0);
      if (r) setResult(r);
    };
    cleanup.current = () => finish();
    setTesting(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      context = new AudioContext();
      await context.resume();
      if (stopped) return;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let peak = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((n, v) => n + v * v, 0) / data.length);
        peak = Math.max(peak, rms);
        setLevel(Math.min(1, rms * 7));
        frame = requestAnimationFrame(tick);
      };
      tick();
      timer = setTimeout(() => finish(peak > 0.01 ? { ok: true, text: "Your microphone works." } : { ok: false, text: "We couldn't hear anything. Check that the right microphone is selected." }), MIC_SECONDS * 1000);
    } catch (e) {
      const name = (e as Error).name;
      finish({ ok: false, text: name === "NotAllowedError" || name === "SecurityError" ? "Microphone access is blocked. Allow it in your browser's site settings." : name === "NotFoundError" ? "We couldn't find a microphone. Plug one in and try again." : "We couldn't use the microphone. Check that no other app is using it." });
    }
  };
  return { testing, level, result, start };
}

function useSpeakerTest(engine: VoiceSettings["speak"]) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const speaker = useRef<VoiceSpeaker | null>(null);
  const run = useRef(0);
  useEffect(() => () => { run.current++; speaker.current?.cancel(); }, []);
  const start = async () => {
    const current = ++run.current;
    speaker.current?.cancel();
    setTesting(true); setResult(null);
    try {
      speaker.current = createSpeaker(engine, undefined, "test");
      await speaker.current.speak("Hello! This is how your helpers will sound.", () => {});
      if (current === run.current) setResult({ ok: true, text: "Did you hear it? If not, check your volume." });
    } catch (e) { if (current === run.current) setResult({ ok: false, text: (e as Error).message }); }
    finally { if (current === run.current) setTesting(false); }
  };
  return { testing, result, start };
}

function Outcome({ result }: { result: Result }) {
  return <p role="status" className={result ? `text-xs ${result.ok ? "text-muted" : "text-bad"}` : "sr-only"}>{result?.text}</p>;
}

export function VoicePage() {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const agents = useStore((s) => s.agents);
  const mic = useMicTest();
  const speakerTest = useSpeakerTest(settings.speak);
  useEffect(() => { api<VoiceSettings>("GET", "/api/voice/settings").then((s) => { setSettings(s); setLoaded(true); }, (e) => setMessage(e.message)); }, []);
  const save = async () => {
    setSaving(true); setMessage("");
    try { setSettings(await api("PUT", "/api/voice/settings", settings)); setMessage("Saved. Your next call will use these settings."); }
    catch (e) { setMessage((e as Error).message); }
    finally { setSaving(false); }
  };
  const canListen = typeof window !== "undefined" && canRecognize();
  const needOpenai = (settings.listen === "openai" || settings.speak === "openai") && !settings.openaiKey;
  const needEleven = settings.speak === "elevenlabs" && !settings.elevenlabsKey;
  const openaiRow = <Row key="openai" label="OpenAI key" hint="Needed for OpenAI listening and voices. OpenAI bills you for it."><Input aria-label="OpenAI API key" type="password" autoComplete="off" disabled={!loaded} value={settings.openaiKey} onChange={(e) => setSettings({ ...settings, openaiKey: e.target.value })} /></Row>;
  const elevenRow = <Row key="eleven" label="ElevenLabs key" hint="Needed for ElevenLabs voices. ElevenLabs bills you for it."><Input aria-label="ElevenLabs API key" type="password" autoComplete="off" disabled={!loaded} value={settings.elevenlabsKey} onChange={(e) => setSettings({ ...settings, elevenlabsKey: e.target.value })} /></Row>;
  const neededRows = [needOpenai && openaiRow, needEleven && elevenRow].filter(Boolean);
  const otherRows = [!needOpenai && openaiRow, !needEleven && elevenRow].filter(Boolean);
  return <>
    <PageHeader title="Voice">Talk with your helpers out loud, and choose how voices sound.</PageHeader>
    <Section title="How voices work" description="Your microphone is only used when you start a call or a test.">
      <Card>
        <Row label="On this device" hint="Nothing leaves your computer. It's free and needs no key. Some browsers, like Chrome, may still send what you say to their own online speech service when listening." />
        <Row label="Online voices" hint="Audio goes to OpenAI or ElevenLabs, and they bill you separately for it. You need your own key from them." />
      </Card>
    </Section>
    <Section title="Your voice choices" description="These settings belong to you.">
      <Card>
        <Row label="Listening" hint="How your speech becomes a chat message."><Select label="Listening engine" disabled={!loaded} value={settings.listen} onChange={(listen) => setSettings({ ...settings, listen: listen as VoiceSettings["listen"] })}><option value="device">On this device</option><option value="openai">OpenAI (online)</option></Select></Row>
        <Row label="Speaking" hint="An AI voice reads a short version. The complete reply stays in chat."><Select label="Speaking engine" disabled={!loaded} value={settings.speak} onChange={(speak) => setSettings({ ...settings, speak: speak as VoiceSettings["speak"] })}><option value="device">On this device</option><option value="openai">OpenAI (online)</option><option value="elevenlabs">ElevenLabs (online)</option></Select></Row>
      </Card>
    </Section>
    {neededRows.length > 0 && <Section title="One more thing" description="The voices you picked need a key from the company that provides them. They bill you directly."><Card>{neededRows}</Card></Section>}
    <Advanced className="mb-8" title="Advanced: API keys and troubleshooting">
      {otherRows.length > 0 && <Section title="API keys" description="Optional. Keys stay on your hub and are hidden when shown again. Clear a key and save to remove it."><Card>{otherRows}</Card></Section>}
      <p className="mb-8 text-xs text-muted">Calls need a secure connection (HTTPS, or localhost on this computer). In the desktop app, if listening doesn't work, choose OpenAI for listening. Headphones help when you interrupt, and stop your speakers from echoing into the microphone.</p>
    </Advanced>
    <Button variant="primary" disabled={!loaded || saving} onClick={save}>{saving ? "Saving…" : "Save voice settings"}</Button>
    {message && <p role="status" className="text-sm text-muted mt-3">{message}</p>}

    <div className="mt-10" />
    <Section title="Try it out" description="Check that your microphone and speakers work. Save first if you changed the speaking voice.">
      <Card>
        <Row label="Listening in this browser" hint={settings.listen === "openai" ? "You chose OpenAI for listening, so this browser's own listening isn't needed." : canListen ? "Listening on this device works in this browser." : "This browser can't listen on its own. Try Chrome or Safari, or choose OpenAI above."} />
        <Row label="Microphone" hint={<>
          {mic.testing ? `Say something. Listening for ${MIC_SECONDS} seconds…` : "Say a few words while it listens."}
          {mic.testing && <span className="mt-1.5 block h-1.5 w-40 max-w-full overflow-hidden rounded-full bg-chip" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(mic.level * 100)}%` }} /></span>}
          <Outcome result={mic.result} />
        </>}><Button disabled={mic.testing} onClick={mic.start}>{mic.testing ? "Listening…" : "Test microphone"}</Button></Row>
        <Row label="Speaker" hint={<>Plays a short sentence.<Outcome result={speakerTest.result} /></>}><Button disabled={speakerTest.testing} onClick={speakerTest.start}>{speakerTest.testing ? "Playing…" : "Test speaker"}</Button></Row>
      </Card>
    </Section>
    <Section title="Each helper's voice" description="Every helper can have its own voice.">
      {agents.length ? <Card>{agents.map((a) => <Row key={a.id} label={a.name}><a href={href({ view: "agents", agentId: a.id, tab: "look" })} className="text-sm text-accent-text hover:underline" aria-label={`Choose voice for ${a.name}`}>Choose voice</a></Row>)}</Card> : <p className="text-sm text-muted">Add a helper first, then you can choose its voice.</p>}
    </Section>
  </>;
}
