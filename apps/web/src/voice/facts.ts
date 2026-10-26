import type { Agent } from "@wisp/core";
import type { CallPhase, CallState } from "./call.ts";
import { clock, phaseLabel } from "./prefs.ts";

/** What the call looks like right now, worked out from its state. */
export function callFacts({ agent, state, connected, seconds, showActivity }: { agent: Agent; state: CallState; connected: boolean; seconds: number; showActivity: boolean }) {
  const offline = agent.status === "offline";
  const phase: CallPhase = state.phase;
  const paused = !offline && connected && !state.ready && state.startedAt !== null && !state.error && !state.needsMic && !state.muted;
  const failed = !offline && (!connected || (!!state.error && !state.needsMic && !state.ready));
  const micTrouble = !offline && connected && state.needsMic;
  const label = offline ? "Asleep" : !connected ? "Reconnecting…" : micTrouble ? "Can't hear you yet" : failed ? "Couldn't connect just yet" : state.error ? "Something went wrong" : phaseLabel(phase, paused);
  const tone = micTrouble ? "warn" : failed || state.error ? "bad" : phase === "listening" || phase === "hearing" ? "listening" : "";
  const activity = showActivity && phase === "working" ? state.activity : "";
  const timer = !offline && state.startedAt !== null ? clock(seconds) : "";
  return { offline, phase, paused, failed, micTrouble, label, tone, activity, timer, seconds, connected };
}
export type CallFacts = ReturnType<typeof callFacts>;
