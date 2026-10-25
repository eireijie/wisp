import type { AgentSettings } from "@wisp/core";
import { getToken } from "../api.ts";
import { voiceIndex } from "./text.ts";

export interface VoiceSettings {
  listen: "device" | "openai";
  speak: "device" | "openai" | "elevenlabs";
  openaiKey: string;
  elevenlabsKey: string;
}
export const DEFAULT_VOICE: VoiceSettings = { listen: "device", speak: "device", openaiKey: "", elevenlabsKey: "" };
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
export const ELEVEN_VOICES = [{ id: "JBFqnCBsd6RMkjVDRZzb", name: "George" }, { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" }, { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" }];
export interface ListenCallbacks {
  partial(text: string): void;
  final(text: string): void;
  level(value: number): void;
  activity(active: boolean): void;
  error(message: string): void;
}
export interface VoiceListener { start(): Promise<void>; stop(): void }
export interface VoiceSpeaker { speak(text: string, level: (value: number) => void): Promise<void>; cancel(): void }

// Web Speech recognition isn't part of TypeScript's DOM library yet.
interface Recognition extends EventTarget {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void; abort(): void;
}
const recognitionClass = () => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};
// The desktop app has no speech service behind the browser's recognition, so it listens through OpenAI instead.
export const inDesktopApp = () => typeof window !== "undefined" && !!window.wispDesktop;
export function canRecognize() { return !inDesktopApp() && !!recognitionClass(); }
export const effectiveListen = (listen: VoiceSettings["listen"]): VoiceSettings["listen"] => (inDesktopApp() ? "openai" : listen);
export function deviceVoices() { return window.speechSynthesis?.getVoices().slice().sort((a, b) => a.voiceURI.localeCompare(b.voiceURI)) ?? []; }

async function voiceRequest(body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch("/api/voice/audio", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error ?? "Couldn't process voice audio. Try again.");
  }
  return res;
}

/** Shared capture with echo cancellation, real mic levels, and short-silence detection. */
class Microphone {
  private stream?: MediaStream;
  private context?: AudioContext;
  private frame = 0;
  private generation = 0;
  async start(level: (value: number) => void, activity: (active: boolean) => void): Promise<MediaStream | null> {
    const generation = ++this.generation;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access needs HTTPS or localhost. Open Wisp on a secure connection to call.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return null; }
    this.stream = stream;
    try {
      const context = this.context = new AudioContext();
      await context.resume();
      if (generation !== this.generation) return null;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let lastVoice = 0, since = 0, talking = false;
      const tick = () => {
        if (generation !== this.generation) return;
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((n, v) => n + v * v, 0) / data.length);
        level(Math.min(1, rms * 7));
        const now = performance.now();
        if (rms > 0.018) {
          lastVoice = now;
          since ||= now;
          if (!talking && now - since > 100) { talking = true; activity(true); }
        } else since = 0;
        if (talking && now - lastVoice > 700) { talking = false; activity(false); }
        this.frame = requestAnimationFrame(tick);
      };
      tick();
      return stream;
    } catch (e) { if (generation === this.generation) this.stop(); throw e; }
  }
  stop() {
    this.generation++;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}

export function createListener(chosen: VoiceSettings["listen"], callbacks: ListenCallbacks): VoiceListener {
  const engine = effectiveListen(chosen);
  const mic = new Microphone();
  let active = false, generation = 0;
  let recognition: Recognition | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let recorder: MediaRecorder | undefined;
  let maxTurn: ReturnType<typeof setTimeout> | undefined;
  let idleRecording: ReturnType<typeof setInterval> | undefined;
  let talking = false, capturedSpeech = false;
  let finishStarting: (() => void) | undefined;
  let transcriptions = Promise.resolve();
  const requests = new Set<AbortController>();
  const stop = () => {
    active = false; generation++;
    clearTimeout(timer); clearTimeout(restart); clearTimeout(maxTurn); clearInterval(idleRecording);
    talking = false; capturedSpeech = false;
    if (recognition) { recognition.onstart = recognition.onend = recognition.onresult = recognition.onerror = null; recognition.abort(); recognition = undefined; }
    finishStarting?.(); finishStarting = undefined;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = undefined;
    requests.forEach((r) => r.abort()); requests.clear();
    mic.stop(); callbacks.level(0); callbacks.activity(false);
  };
  const fail = (error: string) => { stop(); callbacks.error(error); };
  return {
    stop,
    async start() {
      if (active) return;
      if (engine === "device" && !canRecognize()) throw new Error("This browser doesn't offer speech recognition. Try Chrome or Safari, or choose OpenAI in Settings → Notifications → Voice.");
      active = true;
      const current = ++generation;
      try {
        const stream = await mic.start(callbacks.level, (voiceActive) => {
          if (!active || generation !== current) return;
          talking = voiceActive;
          callbacks.activity(talking);
          if (engine !== "openai") return;
          if (talking) capturedSpeech = true;
          if (!talking && recorder?.state === "recording") recorder.stop();
        });
        if (!stream || !active || generation !== current) return;
        function beginRecording() {
          if (!stream || !active) return;
          const mime = ["audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
          if (!mime) return fail("This browser can't record audio for OpenAI. Try another browser.");
          capturedSpeech = talking;
          const rec = recorder = new MediaRecorder(stream, { mimeType: mime });
          const chunks: Blob[] = [];
          rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
          rec.onerror = () => { if (active && current === generation) fail("Couldn't record your microphone. Please try calling again."); };
          rec.onstop = () => {
            if (!active || current !== generation) return;
            clearTimeout(maxTurn);
            if (recorder === rec) recorder = undefined;
            const shouldTranscribe = capturedSpeech;
            beginRecording(); // Keep a little leading audio so the next turn doesn't lose its first syllable.
            if (!shouldTranscribe) return;
            const request = new AbortController(); requests.add(request);
            transcriptions = transcriptions.then(async () => {
              if (!active || current !== generation) { requests.delete(request); return; }
              try {
                callbacks.partial("Transcribing…");
                const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
                let binary = "";
                for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                if (!active || current !== generation) return;
                const res = await voiceRequest({ kind: "listen", mime, audio: btoa(binary) }, request.signal);
                const data = await res.json() as { text: string };
                if (active && current === generation) { callbacks.partial(""); if (data.text.trim()) callbacks.final(data.text.trim()); }
              } catch (e) { if (!request.signal.aborted && current === generation) fail((e as Error).message); }
              finally { requests.delete(request); }
            });
          };
          rec.start();
          maxTurn = setTimeout(() => { if (rec.state === "recording") rec.stop(); }, 60_000);
        }
        if (engine === "openai") {
          if (typeof MediaRecorder === "undefined") { fail("This browser can't record audio. Try Chrome or Safari."); return; }
          beginRecording();
          if (!active) return;
          // Discard idle audio locally; only segments containing speech leave the device.
          idleRecording = setInterval(() => { if (!capturedSpeech && recorder?.state === "recording") recorder.stop(); }, 1500);
          return;
        }
        const started = new Promise<void>((resolve) => { finishStarting = resolve; });
        const boot = () => {
          if (!active || current !== generation) return;
          const Recognition = recognitionClass()!;
          const rec = recognition = new Recognition();
          rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || "en-US";
          rec.onstart = () => {
            if (!active || current !== generation || rec !== recognition) return;
            finishStarting?.(); finishStarting = undefined;
          };
          let text = "";
          const flush = () => {
            clearTimeout(timer);
            const final = text.trim(); text = "";
            if (final && active && current === generation) callbacks.final(final);
          };
          rec.onresult = (e) => {
            if (!active || rec !== recognition) return;
            text = Array.from(e.results).map((r) => r[0].transcript).join(" ").trim();
            callbacks.partial(text);
            clearTimeout(timer);
            // Restart after committing so cumulative result indices cannot replay a turn.
            const finish = () => {
              if (!active || current !== generation || rec !== recognition) return;
              if (talking) { timer = setTimeout(finish, 200); return; }
              flush(); rec.onresult = null; rec.abort();
            };
            timer = setTimeout(finish, 800);
          };
          rec.onspeechend = () => { /* Results, including interim results, drive the silence timer. */ };
          rec.onerror = (e) => {
            if (!active || current !== generation || rec !== recognition) return;
            if (["aborted", "no-speech"].includes(e.error)) return;
            fail(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone or speech access was denied. Allow it in your browser settings, then call again." : "Speech recognition isn't available right now. Try again, or choose OpenAI in Settings → Notifications → Voice.");
          };
          rec.onend = () => { if (active && current === generation) { flush(); restart = setTimeout(boot, 150); } };
          try { rec.start(); } catch { fail("Couldn't start speech recognition. Please try calling again."); }
        };
        boot();
        await started;
      } catch (e) { if (current === generation) { stop(); throw (e as Error).name === "NotAllowedError" ? new Error("Microphone access was denied. Allow the microphone in your browser or system settings, then call again.") : e; } }
    },
  };
}

export function createSpeaker(engine: VoiceSettings["speak"], voices: AgentSettings["voice"], seed: string): VoiceSpeaker {
  if (engine === "device") deviceVoices(); // Trigger asynchronous OS voice discovery before the first reply.
  let cancelCurrent = () => {};
  return {
    cancel() { cancelCurrent(); cancelCurrent = () => {}; },
    async speak(text, level) {
      cancelCurrent();
      if (engine === "device") {
        if (!window.speechSynthesis) throw new Error("Speech playback isn't available in this browser. Captions are still here.");
        return new Promise<void>((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(text);
          const list = deviceVoices();
          const local = list.filter((v) => v.lang.split("-")[0] === (navigator.language || "en").split("-")[0]);
          const candidates = local.length ? local : list;
          utterance.voice = list.find((v) => v.voiceURI === voices?.device) ?? candidates[voiceIndex(seed, candidates.length)] ?? null;
          utterance.rate = 1.03;
          let interval: ReturnType<typeof setInterval> | undefined, finished = false;
          const end = (error?: Error) => {
            if (finished) return;
            finished = true; clearInterval(interval); level(0);
            if (error) reject(error); else resolve();
          };
          cancelCurrent = () => { end(); window.speechSynthesis.cancel(); };
          // Web Speech exposes word boundaries, not PCM. Use a quiet estimated mouth envelope.
          utterance.onstart = () => { let t = 0; interval = setInterval(() => level(0.2 + 0.55 * Math.abs(Math.sin(++t * 1.7))), 90); };
          utterance.onboundary = () => level(0.85);
          utterance.onend = () => end();
          utterance.onerror = (e) => end(["canceled", "interrupted"].includes(e.error) ? undefined : new Error("Couldn't play the voice. Check your device's speech settings."));
          window.speechSynthesis.speak(utterance);
        });
      }
      const controller = new AbortController();
      let context: AudioContext | undefined, source: AudioBufferSourceNode | undefined, frame = 0;
      let finish: (() => void) | undefined;
      cancelCurrent = () => { controller.abort(); source?.stop(); finish?.(); cancelAnimationFrame(frame); level(0); void context?.close().catch(() => {}); };
      try {
        // Create/resume before awaiting the network so previews work with autoplay policies.
        context = new AudioContext();
        await context.resume();
        if (controller.signal.aborted) return;
        const voice = voices?.[engine] || (engine === "openai" ? OPENAI_VOICES[voiceIndex(seed, OPENAI_VOICES.length)] : ELEVEN_VOICES[voiceIndex(seed, ELEVEN_VOICES.length)].id);
        const res = await voiceRequest({ kind: "speak", provider: engine, text, voice }, controller.signal);
        const buffer = await context.decodeAudioData(await res.arrayBuffer());
        if (controller.signal.aborted) return;
        source = context.createBufferSource(); source.buffer = buffer;
        const analyser = context.createAnalyser(); analyser.fftSize = 512;
        source.connect(analyser); analyser.connect(context.destination);
        const data = new Float32Array(analyser.fftSize);
        const tick = () => { analyser.getFloatTimeDomainData(data); level(Math.min(1, Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length) * 5)); frame = requestAnimationFrame(tick); };
        await new Promise<void>((resolve) => { finish = resolve; source!.onended = () => resolve(); source!.start(); tick(); });
      } catch (e) { if (!controller.signal.aborted) throw e; }
      finally { cancelAnimationFrame(frame); level(0); if (context?.state !== "closed") await context?.close().catch(() => {}); }
    },
  };
}
