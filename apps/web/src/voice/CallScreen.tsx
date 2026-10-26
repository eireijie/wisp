import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, ChevronUp, FileText, Mic, MicOff, Settings, X } from "lucide-react";
import type { Agent } from "@wisp/core";
import { defaultAppearance } from "@wisp/core/src/appearance.ts";
import { api, observeEvents } from "../api.ts";
import { useStore } from "../store.ts";
import { useMotionReduced } from "../theme.ts";
import { Ghost, type GhostMood } from "../components/Ghost.tsx";
import { Modal } from "../components/ui.tsx";
import { VoiceCall, INITIAL_CALL, type CallPhase, type CallState } from "./call.ts";
import { callFacts, type CallFacts } from "./facts.ts";
import { callPrefs, phaseLabel, setCallPrefs, SPEEDS, speedLabel, useCallPrefs } from "./prefs.ts";
import { createListener, createSpeaker, effectiveListen, ELEVEN_VOICES, OPENAI_VOICES, deviceVoices, type VoiceSettings, type VoiceSpeaker } from "./providers.ts";
import { recommendVoices } from "./VoicePicker.tsx";
import "./voice.css";

const LANGUAGES: [string, string][] = [["", "Auto"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["es-ES", "Spanish"], ["fr-FR", "French"], ["de-DE", "German"], ["it-IT", "Italian"], ["pt-BR", "Portuguese"], ["ja-JP", "Japanese"], ["ko-KR", "Korean"], ["zh-CN", "Chinese"], ["hi-IN", "Hindi"]];

/** How the ghost looks in each phase: listening opens its eyes wide, working looks down at the task. */
function moodFor(phase: CallPhase, offline: boolean): GhostMood {
  if (offline) return "asleep";
  if (phase === "hearing") return "listening";
  if (phase === "thinking") return "thinking";
  if (phase === "working") return "working";
  return "awake";
}

/** The ghost with its phase animation around it: a breathing ring, a spinning arc, or a bob. */
function CallGhost({ agent, state, phase, size, offline, dim }: { agent: Agent; state: CallState; phase: CallPhase; size: number; offline: boolean; dim?: boolean }) {
  const reduced = useMotionReduced();
  const look = agent.settings.appearance ?? defaultAppearance(agent.handle);
  const level = state.speaking ? state.speechLevel : state.micLevel;
  return (
    <>
      {!offline && (phase === "listening" || phase === "hearing") && <div className="voice-breathe" style={phase === "hearing" && !reduced ? { opacity: 0.5 + level * 0.5, transform: `scale(${1.05 + level * 0.2})`, animation: "none" } : undefined} />}
      {!offline && (phase === "thinking" || phase === "working") && <div className="voice-arc" />}
      {!offline && phase === "speaking" && <div className="voice-halo" style={{ opacity: reduced ? 0.5 : 0.3 + level * 0.7, transform: reduced ? undefined : `scale(${1 + level * 0.12})` }} />}
      <div className={dim ? "voice-dim" : phase === "working" ? "voice-bob" : "flex"}>
        <Ghost look={look} size={size} mood={moodFor(phase, offline)} speakingLevel={state.speaking ? state.speechLevel : undefined} ambient interactive={size > 60} label={`${agent.name}, ${phaseLabel(phase, false).toLowerCase()}`} />
      </div>
    </>
  );
}

export function CallScreen({ agent, channelId, onClose, barSlot }: { agent: Agent; channelId: string; onClose(): void; barSlot?: HTMLElement | null }) {
  const [state, setState] = useState(INITIAL_CALL);
  const [seconds, setSeconds] = useState(0);
  const [engine, setEngine] = useState<VoiceSettings["speak"] | null>(null);
  const [engineLabel, setEngineLabel] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [shrunk, setShrunk] = useState(false);
  const [panel, setPanel] = useState(false);
  const call = useRef<VoiceCall | null>(null);
  const voiceRef = useRef(agent.settings.voice);
  voiceRef.current = agent.settings.voice;
  const connected = useStore((s) => s.connected);
  const prefs = useCallPrefs();
  const offline = agent.status === "offline";
  const look = agent.settings.appearance ?? defaultAppearance(agent.handle);
  useEffect(() => {
    setState(INITIAL_CALL); setSeconds(0); setEngine(null); setEngineLabel("");
    if (offline) return;
    let disposed = false;
    const unsubscribe = observeEvents((e) => call.current?.event(e));
    void api<VoiceSettings>("GET", "/api/voice/settings").then(async (settings) => {
      if (disposed) return;
      setEngine(settings.speak);
      setEngineLabel(`${effectiveListen(settings.listen) === "openai" ? "OpenAI listening · " : ""}${settings.speak === "device" ? "On this device" : settings.speak === "openai" ? "OpenAI · AI voice" : "ElevenLabs · AI voice"}`);
      // the voice and speed are read at every reply, so changing them in the panel is heard right away
      let current: VoiceSpeaker | null = null;
      const speaker: VoiceSpeaker = {
        speak(text, level) { current?.cancel(); current = createSpeaker(settings.speak, voiceRef.current, agent.handle, () => callPrefs().speed); return current.speak(text, level); },
        cancel() { current?.cancel(); },
      };
      const session = new VoiceCall({
        agentId: agent.id, channelId, cloudListening: effectiveListen(settings.listen) === "openai",
        listener: (cb) => createListener(settings.listen, cb, () => callPrefs().language),
        speaker,
        send: (body) => api("POST", `/api/channels/${channelId}/messages`, { body, voice: true }),
        update: setState,
        messages: () => useStore.getState().messages[channelId] ?? [],
        refresh: () => useStore.getState().loadChannel(channelId),
      });
      call.current = session;
      if (useStore.getState().connected) await session.start(); else session.disconnect();
    }).catch((e) => { if (!disposed) setState((s) => ({ ...s, error: e.message })); });
    return () => { disposed = true; unsubscribe(); call.current?.stop(); call.current = null; };
  }, [agent.id, channelId, offline, attempt]);
  useEffect(() => {
    const startedAt = state.startedAt;
    if (startedAt === null || offline) return;
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state.startedAt, offline]);
  useEffect(() => {
    if (!connected) call.current?.disconnect();
    else if (call.current && !call.current.state.ready) void call.current.start();
  }, [connected]);
  const close = () => { call.current?.stop(); onClose(); };
  const retry = () => { if (call.current) void call.current.start(); else setAttempt((n) => n + 1); };
  const toggleMute = () => void call.current?.mute(!state.muted);
  const expand = useCallback(() => setShrunk(false), []);

  const facts = callFacts({ agent, state, connected, seconds, showActivity: prefs.showActivity });
  const style = { "--voice-color": look.color, "--voice-color2": look.color2 ?? look.color } as CSSProperties;

  if (shrunk) {
    const bar = <CallBar agent={agent} state={state} facts={facts} style={style} onExpand={expand} onSettings={() => { setPanel(true); setShrunk(false); }} onMute={toggleMute} onEnd={close} />;
    if (barSlot) return createPortal(bar, barSlot);
    return <div className="fixed top-2 inset-x-0 z-40 max-w-xl mx-auto">{bar}</div>;
  }
  return (
    <Modal title={null} headerless onClose={() => setShrunk(true)} label={`Voice call with ${agent.name}`} className="voice-modal" contentClassName="voice-content">
      <CallScene agent={agent} state={state} facts={facts} style={style} panel={panel} engine={engine} engineLabel={engineLabel} onShrink={() => setShrunk(true)} onPanel={() => setPanel(!panel)} onMute={toggleMute} onRetry={retry} onEnd={close} />
    </Modal>
  );
}


/** The full-screen call. */
export function CallScene({ agent, state, facts, style, panel, engine, engineLabel, onShrink, onPanel, onMute, onRetry, onEnd }: {
  agent: Agent; state: CallState; facts: CallFacts; style: CSSProperties; panel: boolean; engine: VoiceSettings["speak"] | null; engineLabel: string;
  onShrink(): void; onPanel(): void; onMute(): void; onRetry(): void; onEnd(): void;
}) {
  const { offline, phase, paused, failed, micTrouble, label, tone, activity, timer, seconds, connected } = facts;
  return (
    <div className="voice-scene" data-phase={phase} style={style}>
      <div className="voice-head">
        <button className="circle voice-ctl" aria-label="Shrink call into the chat" title="Shrink call into the chat" onClick={onShrink}><ChevronUp size={22} /></button>
      </div>
      <div className="voice-hero">
        <div className="voice-ring"><CallGhost agent={agent} state={state} phase={phase} size={phase === "connecting" ? 150 : 100} offline={offline} dim={paused || failed || micTrouble} /></div>
        <h2 className="voice-name">{agent.name}</h2>
        <span className="voice-timer" aria-label={timer ? `Call duration ${seconds} seconds` : undefined}>{timer || (offline ? `${agent.name} is asleep. Wake their computer to talk.` : label === "Calling…" ? "Calling…" : "")}</span>
        {timer || phase !== "connecting" ? <span className="voice-state" data-tone={tone} role="status">{offline ? "" : label}</span> : <span role="status" className="sr-only">{label}</span>}
        {activity && <span className="voice-chip"><FileText size={16} aria-hidden /><span>{activity}</span></span>}
      </div>

      {panel && <CallSettings agent={agent} engine={engine} engineLabel={engineLabel} />}

      {micTrouble ? (
        <div className="voice-card" role="alert">
          <h3><span className="voice-badge"><MicOff size={20} aria-hidden /></span>A little help with the microphone?</h3>
          <p>Wisp needs your microphone to hear you. Allow it in your browser (the lock beside the address), then try again. {agent.name} will still answer in chat.</p>
          <button className="voice-pill" data-primary onClick={onRetry}>Try again</button>
          <button className="voice-pill" onClick={onShrink}>Keep chatting by text</button>
        </div>
      ) : failed ? (
        <div className="voice-card" role="alert">
          {state.error && <p className="voice-problem">{state.error}</p>}
          <p>Check that your Wisp is reachable and that the voice you picked has its key. The conversation is still here in chat.</p>
          {connected && <button className="voice-pill" data-primary onClick={onRetry}>Try again</button>}
          <a className="voice-pill" href="#/settings/voice" onClick={onEnd}>Voice settings<ChevronRight size={16} aria-hidden /></a>
        </div>
      ) : paused ? (
        <div className="voice-paused">
          <button className="voice-pill" data-primary onClick={onRetry}>Resume</button>
          <span>The call is on hold. {agent.name} keeps working and its full reply will be waiting in chat.</span>
        </div>
      ) : (
        <>
          <div className="voice-captions" aria-live="polite" aria-atomic="true">
            {state.userCaption && <p className="voice-you">{state.userCaption}</p>}
            {state.agentCaption && <p className="voice-it">{state.agentCaption}</p>}
            {state.error && <p className="voice-you" style={{ color: "var(--bad)" }} role="alert">{state.error}</p>}
          </div>
          {state.longWork && <p className="voice-hint">Feel free to hang up. Watch for the done glow or a notification.</p>}
        </>
      )}

      {(micTrouble || failed || paused) && <span className="flex-1" />}
      <div className="voice-controls">
        <button className="circle voice-ctl" aria-label={state.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state.muted} disabled={offline || (!state.ready && !state.muted)} onClick={onMute}>{state.muted ? <MicOff size={24} /> : <Mic size={24} />}</button>
        <button className="circle voice-ctl" aria-label="Call settings" aria-pressed={panel} onClick={onPanel}><Settings size={24} /></button>
        <span className="flex-1" />
        <button className="circle voice-ctl voice-end" aria-label="End call" title="End call" onClick={onEnd}><X size={24} strokeWidth={2.2} /></button>
      </div>
    </div>
  );
}

/** Voice, Speed, Language and whether to show what the agent is doing. */
function CallSettings({ agent, engine, engineLabel }: { agent: Agent; engine: VoiceSettings["speak"] | null; engineLabel: string }) {
  const prefs = useCallPrefs();
  const [voices, setVoices] = useState(deviceVoices);
  useEffect(() => {
    const update = () => setVoices(deviceVoices());
    window.speechSynthesis?.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", update);
  }, []);
  const language = typeof navigator === "undefined" ? "en" : navigator.language || "en";
  const options = useMemo(() => {
    if (engine === "openai") return OPENAI_VOICES.map((v) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) }));
    if (engine === "elevenlabs") return ELEVEN_VOICES.map((v) => ({ id: v.id, label: v.name }));
    return recommendVoices(voices, language, 6).map((v) => ({ id: v.voiceURI, label: v.name.replace(/\s*\(.*$/, "") }));
  }, [engine, voices, language]);
  const picked = engine ? agent.settings.voice?.[engine] ?? "" : "";
  const choices = picked && !options.some((o) => o.id === picked) ? [...options, { id: picked, label: "Saved voice" }] : options;
  const chooseVoice = (id: string) => { if (engine) void api("PATCH", `/api/agents/${agent.id}`, { settings: { voice: { ...agent.settings.voice, [engine]: id } } }).catch(() => {}); };
  return (
    <div className="voice-settings" role="group" aria-label="Call settings">
      <label className="voice-row"><span>Voice</span>
        <select aria-label="Voice" value={picked} disabled={!engine} onChange={(e) => chooseVoice(e.target.value)}>
          <option value="">Automatic</option>
          {choices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <label className="voice-row"><span>Speed</span>
        <select aria-label="Speed" value={prefs.speed} onChange={(e) => setCallPrefs({ speed: Number(e.target.value) })}>
          {SPEEDS.map((s) => <option key={s} value={s}>{speedLabel(s)}</option>)}
        </select>
      </label>
      <label className="voice-row"><span>Language</span>
        <select aria-label="Language" value={prefs.language} onChange={(e) => setCallPrefs({ language: e.target.value })}>
          {LANGUAGES.map(([tag, name]) => <option key={tag} value={tag}>{name}</option>)}
        </select>
      </label>
      <div className="voice-row"><span id="call-show-label">Show what it's doing</span>
        <button type="button" role="switch" aria-checked={prefs.showActivity} aria-labelledby="call-show-label" onClick={() => setCallPrefs({ showActivity: !prefs.showActivity })}>{prefs.showActivity ? "On" : "Off"}</button>
      </div>
      {engineLabel && <p className="voice-note">{engineLabel}. Full replies stay in chat. Language and speed are kept on this device.</p>}
    </div>
  );
}

/** The call shrunk into a bar at the top of the chat: phase animation, time and state, the activity line, and controls. */
export function CallBar({ agent, state, facts, style, onExpand, onSettings, onMute, onEnd }: {
  agent: Agent; state: CallState; facts: CallFacts; style: CSSProperties;
  onExpand(): void; onSettings(): void; onMute(): void; onEnd(): void;
}) {
  const { phase, offline, label, timer, activity } = facts;
  const drag = useRef<number | null>(null);
  const down = (e: ReactPointerEvent) => { drag.current = e.clientY; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); };
  const up = (e: ReactPointerEvent) => { const from = drag.current; drag.current = null; if (from === null || e.clientY - from > 14 || Math.abs(e.clientY - from) < 4) onExpand(); };
  return (
    <div className="voice-bar" style={style} role="region" aria-label={`Call with ${agent.name}`}>
      <div className="voice-bar-row">
        <span className="voice-bar-ring"><CallGhost agent={agent} state={state} phase={phase} size={30} offline={offline} /></span>
        <span className="voice-bar-text">
          <b role="status">{timer ? `${timer} · ${label}` : label}</b>
          {activity && <span>{activity}</span>}
        </span>
        <button className="voice-bar-btn" aria-label="Call settings" title="Call settings" onClick={onSettings}><Settings size={20} /></button>
        <button className="voice-bar-btn" aria-label={state.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state.muted} disabled={offline || (!state.ready && !state.muted)} onClick={onMute}>{state.muted ? <MicOff size={20} /> : <Mic size={20} />}</button>
        <button className="voice-bar-btn voice-bar-end" aria-label="End call" title="End call" onClick={onEnd}><X size={20} strokeWidth={2.2} /></button>
      </div>
      <button className="voice-handle" aria-label="Expand the call" title="Expand the call" onPointerDown={down} onPointerUp={up} onClick={onExpand} />
    </div>
  );
}
