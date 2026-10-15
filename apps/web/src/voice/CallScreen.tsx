import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import type { Agent } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { api, observeEvents } from "../api.ts";
import { useStore } from "../store.ts";
import { useMotionReduced } from "../theme.ts";
import { Ghost } from "../components/Ghost.tsx";
import { Button, Modal } from "../components/ui.tsx";
import { VoiceCall, INITIAL_CALL } from "./call.ts";
import { createListener, createSpeaker, type VoiceSettings } from "./providers.ts";
import "./voice.css";

export function CallScreen({ agent, channelId, onClose }: { agent: Agent; channelId: string; onClose(): void }) {
  const [state, setState] = useState(INITIAL_CALL);
  const [seconds, setSeconds] = useState(0);
  const [engine, setEngine] = useState("");
  const [attempt, setAttempt] = useState(0);
  const call = useRef<VoiceCall | null>(null);
  const connected = useStore((s) => s.connected);
  const reduced = useMotionReduced();
  const offline = agent.status === "offline";
  const look = agent.settings.appearance ?? defaultAppearance(agent.handle);
  useEffect(() => {
    setState(INITIAL_CALL); setSeconds(0); setEngine("");
    if (offline) return;
    let disposed = false;
    const unsubscribe = observeEvents((e) => call.current?.event(e));
    void api<VoiceSettings>("GET", "/api/voice/settings").then(async (settings) => {
      if (disposed) return;
      setEngine(`${settings.listen === "openai" ? "OpenAI listening · " : ""}${settings.speak === "device" ? "On this device" : settings.speak === "openai" ? "OpenAI · AI voice" : "ElevenLabs · AI voice"}`);
      const session = new VoiceCall({
        agentId: agent.id, channelId, cloudListening: settings.listen === "openai",
        listener: (cb) => createListener(settings.listen, cb),
        speaker: createSpeaker(settings.speak, agent.settings.voice, agent.handle),
        send: (body) => api("POST", `/api/channels/${channelId}/messages`, { body, voice: true }),
        update: setState,
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
  useEffect(() => { if (!connected) call.current?.disconnect(); }, [connected]);
  const close = () => { call.current?.stop(); onClose(); };
  const retry = () => { if (call.current) void call.current.start(); else setAttempt((n) => n + 1); };
  const label = offline ? `${agent.name} is asleep. Wake their computer to talk.` : !connected ? "Reconnecting…" : state.needsMic ? "A little help with the microphone?" : state.error && !state.ready ? "Couldn't connect just yet" : !state.ready ? "Calling…" : state.muted ? "Microphone muted" : state.talking ? "I'm listening" : state.speaking ? "Speaking" : state.waiting ? "Thinking…" : "Go ahead, I'm listening";
  return (
    <Modal title={null} headerless onClose={close} label={`Voice call with ${agent.name}`} className="voice-modal" contentClassName="voice-content">
      <div className="voice-scene" style={{ "--voice-color": look.color, "--voice-color2": look.color2 ?? look.color } as CSSProperties}>
        <div className="voice-topline">{!offline && state.startedAt !== null && <time aria-label={`Call duration ${seconds} seconds`}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time>}</div>
        <div className="voice-stage">
          {!offline && <div className="voice-halo" style={{ opacity: reduced ? 0.45 : 0.3 + state.micLevel * 0.6, transform: reduced ? undefined : `scale(${1 + state.micLevel * 0.2})` }} />}
          <div className="voice-ghost"><Ghost look={look} size={220} mood={offline ? "asleep" : state.talking ? "listening" : state.waiting && !state.speaking ? "thinking" : "awake"} speakingLevel={state.speaking ? state.speechLevel : undefined} ambient interactive label={`${agent.name} ${label.toLowerCase()}`} /></div>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{agent.name}</h2>
        <p className="voice-status" role="status">{label}</p>
        <div className="voice-captions" aria-live="polite" aria-atomic="true">
          {state.userCaption && <p><span>You</span> {state.userCaption}</p>}
          {state.agentCaption && <p><span>{agent.name}</span> {state.agentCaption}</p>}
        </div>
        {state.longWork && <p className="text-xs text-muted px-5">Feel free to hang up. Watch for the done glow or your desk buddy's bubble.</p>}
        {!offline && (state.needsMic || state.error) && <div className="voice-error" role="alert">
          {state.needsMic && <p className="voice-mic-hint">Allow the microphone so you can talk to {agent.name}</p>}
          {state.error && <p>{state.error}</p>}
          {!state.ready && connected && <Button onClick={retry}>Try again</Button>}
          {state.error && <a href="#/settings/voice" onClick={close}>Voice settings</a>}
        </div>}
        <div className="voice-controls">
          <button className="voice-control" aria-label={state.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state.muted} disabled={offline || (!state.ready && !state.muted)} onClick={() => void call.current?.mute(!state.muted)}>{state.muted ? <MicOff size={22} /> : <Mic size={22} />}</button>
          <button className="voice-control voice-hangup" aria-label="Hang up" onClick={close}><PhoneOff size={23} /></button>
        </div>
        <div className="voice-footer"><p>Hands free · Captions on{engine && <> · <span>{engine}</span></>}</p><p>Full replies stay in chat</p></div>
      </div>
    </Modal>
  );
}
