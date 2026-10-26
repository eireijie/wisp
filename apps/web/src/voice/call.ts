import type { ClientEvent, Message } from "@wisp/core";
import type { ListenCallbacks, VoiceListener, VoiceSpeaker } from "./providers.ts";
import { activityPhrase } from "../components/agentActivity.ts";
import { isSpeechEcho, spokenReply } from "./text.ts";

/** What the call is doing right now, for the screen to show. One value, never a combination. */
export type CallPhase = "connecting" | "muted" | "listening" | "hearing" | "thinking" | "working" | "speaking" | "error";
export function callPhase(s: Pick<CallState, "ready" | "muted" | "speaking" | "talking" | "waiting" | "error" | "needsMic" | "activity">): CallPhase {
  if (s.error || s.needsMic) return "error";
  if (!s.ready) return s.muted ? "muted" : "connecting";
  if (s.muted) return "muted";
  if (s.speaking) return "speaking";
  if (s.talking) return "hearing";
  if (s.waiting) return s.activity ? "working" : "thinking";
  return "listening";
}

/** "Reading main.ts", "Searching the web": a short line for the tool the agent just started. */
export function toolLine(name: string, input?: unknown): string {
  const now = activityPhrase(name);
  const text = now.charAt(0).toUpperCase() + now.slice(1);
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : typeof i.path === "string" ? i.path : "";
  const file = path.split(/[\\/]/).filter(Boolean).at(-1);
  if (file && /^(reading|editing) files$/.test(now)) return `${now.startsWith("r") ? "Reading" : "Editing"} ${file}`.slice(0, 80);
  return text;
}

export interface CallState {
  ready: boolean; muted: boolean; speaking: boolean; talking: boolean; waiting: boolean;
  needsMic: boolean; startedAt: number | null;
  micLevel: number; speechLevel: number; userCaption: string; agentCaption: string; error: string; longWork: boolean;
  /** a short line for the tool the agent is using, empty when it is just thinking */
  activity: string; phase: CallPhase;
}
export const INITIAL_CALL: CallState = { ready: false, muted: false, speaking: false, talking: false, waiting: false, needsMic: false, startedAt: null, micLevel: 0, speechLevel: 0, userCaption: "", agentCaption: "", error: "", longWork: false, activity: "", phase: "connecting" };

/** Owns one call. No browser or React dependency, so late callbacks and interruptions are testable. */
export class VoiceCall {
  state = { ...INITIAL_CALL };
  private listener: VoiceListener;
  private stopped = false;
  private pending = 0;
  private capture = 0;
  private streamed = "";
  private streamRun = "";
  /** the first sentence of the reply, spoken while the agent is still working */
  private early = "";
  private speech = 0;
  private spoken = "";
  private spokenAt = 0;
  private filler?: ReturnType<typeof setTimeout>;
  private long?: ReturnType<typeof setTimeout>;
  private micHint?: ReturnType<typeof setTimeout>;
  private seen = new Set<string>();
  private lastSeen: string | null = null;
  private lastSeenAt = "";
  constructor(private options: {
    agentId: string; channelId: string; cloudListening: boolean;
    listener(callbacks: ListenCallbacks): VoiceListener;
    speaker: VoiceSpeaker;
    send(text: string): Promise<unknown>;
    update(state: CallState): void;
    messages?(): Message[];
    refresh?(): Promise<void>;
  }) {
    this.markSeen(this.conversation().at(-1));
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
    const next = { ...this.state, ...patch };
    if (!next.waiting && next.activity) next.activity = "";
    this.state = { ...next, phase: callPhase(next) };
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
      if (this.pending) await this.options.refresh?.();
      if (capture !== this.capture || this.stopped) return;
      await this.listener.start();
      if (capture === this.capture && !this.state.error) {
        this.update({ ready: true, needsMic: false, startedAt: this.state.startedAt ?? Date.now() });
        this.reconcile();
      }
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
  private earlySpeech?: Promise<void>;
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
  /** Speak a finished reply, skipping the part already said while it streamed. */
  private async sayReply(text: string) {
    const early = this.early; this.early = "";
    const rest = early && text.startsWith(early) ? text.slice(early.length).trim() : text;
    if (!rest) return;
    // let the early sentence finish, unless the person talked over it or hung up meanwhile
    const earlySpeech = this.earlySpeech; this.earlySpeech = undefined;
    if (early && earlySpeech) {
      const speech = this.speech;
      await earlySpeech;
      if (speech !== this.speech) return;
    }
    void this.say(rest);
  }
  private timers() {
    clearTimeout(this.filler); clearTimeout(this.long);
    this.filler = setTimeout(() => { if (this.pending && !this.early && !this.state.talking && !this.state.speaking) void this.say("On it…"); }, 2500);
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
    this.streamed = ""; this.streamRun = ""; this.early = "";
    this.update({ userCaption: text, agentCaption: "", activity: "", talking: false, waiting: true, longWork: false, error: "" });
    this.timers();
    try { await this.options.send(text); }
    catch (e) {
      this.pending = Math.max(0, this.pending - 1);
      if (!this.pending) { clearTimeout(this.filler); clearTimeout(this.long); }
      this.update({ error: `Couldn't send your voice message: ${(e as Error).message}`, waiting: this.pending > 0 });
    }
  }
  private conversation() {
    return (this.options.messages?.() ?? []).filter((m) => m.channelId === this.options.channelId && !m.threadId);
  }
  private markSeen(m: Message | undefined) {
    if (m) { this.lastSeen = m.id; this.lastSeenAt = m.createdAt; }
  }
  private reconcile() {
    const messages = this.conversation();
    const index = messages.findIndex((m) => m.id === this.lastSeen);
    const fresh = index >= 0 ? messages.slice(index + 1) : messages.filter((m) => m.createdAt >= this.lastSeenAt);
    const replies = fresh.filter((m) => m.author.kind === "agent" && m.author.id === this.options.agentId && !this.seen.has(m.id));
    const pending = this.pending;
    this.pending = Math.max(0, pending - replies.length);
    const lastAgent = messages.map((m) => m.author.kind === "agent" && m.author.id === this.options.agentId).lastIndexOf(true);
    const lastPerson = messages.map((m) => m.author.kind === "user" && m.author.id !== "system").lastIndexOf(true);
    if (lastAgent > lastPerson) this.pending = 0;
    replies.forEach((m) => this.seen.add(m.id));
    this.markSeen(messages.at(-1));
    this.update({ waiting: this.pending > 0, longWork: false });
    if (this.pending) this.timers();
    else { clearTimeout(this.filler); clearTimeout(this.long); }
    const newest = replies.at(-1);
    if (pending && newest) {
      const failed = newest.parts.find((p) => p.type === "status" && p.text.startsWith("Run failed:"));
      if (failed?.type === "status") this.update({ error: failed.text });
      else this.sayReply(spokenReply(newest.body) || "I've put the details in our chat.");
    }
  }
  event(e: ClientEvent) {
    if (this.stopped || !this.state.ready) return;
    if (e.type === "message" && e.message.channelId === this.options.channelId && !e.message.threadId) this.markSeen(e.message);
    if (!this.pending) return;
    if (e.type === "run_event" && e.agentId === this.options.agentId && e.channelId === this.options.channelId && !e.threadId) {
      const ev = e.event;
      if (ev.type === "tool_call") this.update({ activity: toolLine(ev.name, ev.input) });
      else if (ev.type === "tool_result") this.update({ activity: "" });
      else if (ev.type === "text") {
        if (this.streamRun !== e.runId) { this.streamed = ""; this.streamRun = e.runId; }
        this.streamed = (this.streamed + ev.text).slice(0, 40_000);
        const excerpt = spokenReply(this.streamed);
        // Talk as soon as the first sentence is whole instead of waiting for the full reply.
        const first = this.early ? "" : excerpt.match(/^.{8,}?[.!?]+(?=\s)/)?.[0] ?? "";
        if (first && !this.state.talking && !this.state.speaking) { this.early = first; this.earlySpeech = this.say(first); }
        else if (!this.state.speaking) this.update({ agentCaption: excerpt, activity: "" });
      }
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
    if (this.state.talking || !this.state.ready) this.update({ agentCaption: text }); else this.sayReply(text);
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
