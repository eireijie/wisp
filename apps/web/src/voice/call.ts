import type { ClientEvent } from "@warren/core";
import type { ListenCallbacks, VoiceListener, VoiceSpeaker } from "./providers.ts";
import { isSpeechEcho, spokenReply } from "./text.ts";

export interface CallState {
  ready: boolean; muted: boolean; speaking: boolean; talking: boolean; waiting: boolean;
  needsMic: boolean; startedAt: number | null;
  micLevel: number; speechLevel: number; userCaption: string; agentCaption: string; error: string; longWork: boolean;
}
export const INITIAL_CALL: CallState = { ready: false, muted: false, speaking: false, talking: false, waiting: false, needsMic: false, startedAt: null, micLevel: 0, speechLevel: 0, userCaption: "", agentCaption: "", error: "", longWork: false };

/** Owns one call. No browser or React dependency, so late callbacks and interruptions are testable. */
export class VoiceCall {
  state = { ...INITIAL_CALL };
  private listener: VoiceListener;
  private stopped = false;
  private pending = 0;
  private capture = 0;
  private streamed = "";
  private streamRun = "";
  private speech = 0;
  private spoken = "";
  private spokenAt = 0;
  private filler?: ReturnType<typeof setTimeout>;
  private long?: ReturnType<typeof setTimeout>;
  private micHint?: ReturnType<typeof setTimeout>;
  private seen = new Set<string>();
  constructor(private options: {
    agentId: string; channelId: string; cloudListening: boolean;
    listener(callbacks: ListenCallbacks): VoiceListener;
    speaker: VoiceSpeaker;
    send(text: string): Promise<unknown>;
    update(state: CallState): void;
  }) {
    this.listener = options.listener({
      level: (micLevel) => this.update({ micLevel }),
      activity: (talking) => {
        if (this.stopped || this.state.muted || !this.state.ready) return;
        this.update({ talking });
        if (talking && options.cloudListening) this.interrupt();
      },
      partial: (text) => {
        if (this.stopped || this.state.muted || !this.state.ready || this.echo(text)) return;
        if (text) this.interrupt();
        this.update({ userCaption: text, talking: !!text });
      },
      final: (text) => { if (!this.stopped && !this.state.muted && this.state.ready && !this.echo(text)) void this.turn(text); },
      error: (error) => {
        clearTimeout(this.micHint);
        this.update({ error, needsMic: true, ready: false, talking: false });
      },
    });
  }
  private update(patch: Partial<CallState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.options.update(this.state);
  }
  private echo(text: string) { return (this.state.speaking || Date.now() - this.spokenAt < 1200) && isSpeechEcho(text, this.spoken); }
  async start() {
    if (this.stopped) return;
    if (this.capture) this.listener.stop();
    const capture = ++this.capture;
    clearTimeout(this.micHint);
    this.update({ error: "", muted: false, ready: false, needsMic: false, talking: false, micLevel: 0 });
    this.micHint = setTimeout(() => { if (capture === this.capture) this.update({ needsMic: true }); }, 4000);
    try {
      await this.listener.start();
      if (capture === this.capture && !this.state.error) this.update({ ready: true, needsMic: false, startedAt: this.state.startedAt ?? Date.now() });
    } catch (e) {
      if (capture === this.capture) this.update({ error: (e as Error).message, needsMic: true, ready: false });
    } finally { if (capture === this.capture) clearTimeout(this.micHint); }
  }
  async mute(muted: boolean) {
    this.update({ muted, talking: false, userCaption: muted ? "" : this.state.userCaption });
    if (muted) { this.capture++; clearTimeout(this.micHint); this.listener.stop(); } else await this.start();
  }
  interrupt() {
    this.speech++;
    this.options.speaker.cancel();
    this.spokenAt = Date.now();
    this.update({ speaking: false, speechLevel: 0 });
  }
  private async say(text: string) {
    if (this.stopped || !text || !this.state.ready) return;
    this.interrupt();
    const speech = this.speech;
    this.spoken = text;
    this.update({ speaking: true, agentCaption: text });
    try { await this.options.speaker.speak(text, (speechLevel) => { if (speech === this.speech) this.update({ speechLevel }); }); }
    catch (e) { if (speech === this.speech) this.update({ error: (e as Error).message }); }
    finally {
      if (speech === this.speech) { this.spokenAt = Date.now(); this.update({ speaking: false, speechLevel: 0, ...(this.pending && this.streamed ? { agentCaption: spokenReply(this.streamed) } : {}) }); }
    }
  }
  private timers() {
    clearTimeout(this.filler); clearTimeout(this.long);
    this.filler = setTimeout(() => { if (this.pending && !this.state.talking && !this.state.speaking) void this.say("On it…"); }, 2500);
    this.long = setTimeout(() => {
      if (!this.pending) return;
      this.update({ longWork: true });
      const text = "This needs a little longer. I'll ping you when it's ready. You can hang up; I'll keep working.";
      if (!this.state.talking) void this.say(text); else this.update({ agentCaption: text });
    }, 20_000);
  }
  private async turn(text: string) {
    text = text.trim();
    if (!text) return;
    this.interrupt();
    this.pending++;
    this.streamed = ""; this.streamRun = "";
    this.update({ userCaption: text, agentCaption: "", talking: false, waiting: true, longWork: false, error: "" });
    this.timers();
    try { await this.options.send(text); }
    catch (e) {
      this.pending = Math.max(0, this.pending - 1);
      if (!this.pending) { clearTimeout(this.filler); clearTimeout(this.long); }
      this.update({ error: `Couldn't send your voice message: ${(e as Error).message}`, waiting: this.pending > 0 });
    }
  }
  event(e: ClientEvent) {
    if (this.stopped || !this.pending) return;
    if (e.type === "run_event" && e.agentId === this.options.agentId && e.channelId === this.options.channelId && e.event.type === "text") {
      if (this.streamRun !== e.runId) { this.streamed = ""; this.streamRun = e.runId; }
      this.streamed = (this.streamed + e.event.text).slice(0, 40_000);
      if (!this.state.speaking) this.update({ agentCaption: spokenReply(this.streamed) });
    }
    if (e.type !== "message") return;
    const m = e.message;
    if (m.channelId === this.options.channelId && !m.threadId && m.author.id === "system") {
      const status = m.parts.find((p) => p.type === "status");
      if (status?.type === "status") {
        this.update({ error: status.text });
        clearTimeout(this.filler);
        if (status.text.startsWith("Not waking")) { this.pending = Math.max(0, this.pending - 1); clearTimeout(this.long); this.update({ waiting: this.pending > 0 }); }
      }
      return;
    }
    if (m.channelId !== this.options.channelId || m.threadId || m.author.kind !== "agent" || m.author.id !== this.options.agentId || this.seen.has(m.id)) return;
    this.seen.add(m.id);
    this.pending = Math.max(0, this.pending - 1);
    this.update({ waiting: this.pending > 0, longWork: false });
    if (this.pending) return;
    clearTimeout(this.filler); clearTimeout(this.long);
    const failed = m.parts.find((p) => p.type === "status" && p.text.startsWith("Run failed:"));
    if (failed?.type === "status") { this.interrupt(); this.update({ error: failed.text }); return; }
    const text = spokenReply(m.body) || "I've put the details in our chat.";
    if (this.state.talking || !this.state.ready) this.update({ agentCaption: text }); else void this.say(text);
  }
  disconnect() {
    this.capture++; clearTimeout(this.filler); clearTimeout(this.long); clearTimeout(this.micHint);
    this.listener.stop(); this.interrupt();
    this.update({ ready: false, needsMic: false, error: "Connection lost. Your agent can keep working. Reconnect to resume the call." });
  }
  stop() {
    this.stopped = true; this.capture++;
    clearTimeout(this.filler); clearTimeout(this.long); clearTimeout(this.micHint);
    this.speech++;
    this.listener.stop(); this.options.speaker.cancel();
  }
}
