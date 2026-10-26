import { describe, expect, it } from "vitest";
import type { Agent } from "@wisp/core";
import { callFacts } from "../src/voice/facts.ts";
import { INITIAL_CALL, callPhase, type CallState } from "../src/voice/call.ts";
import { clock, phaseLabel } from "../src/voice/prefs.ts";

const agent = { id: "a", name: "Ghosty", handle: "ghosty", status: "online", settings: {} } as unknown as Agent;
const live = (patch: Partial<CallState>): CallState => { const s = { ...INITIAL_CALL, ready: true, startedAt: 1000, ...patch }; return { ...s, phase: callPhase(s) }; };
const facts = (state: CallState, extra: { connected?: boolean; showActivity?: boolean; offline?: boolean } = {}) =>
  callFacts({ agent: extra.offline ? ({ ...agent, status: "offline" } as Agent) : agent, state, connected: extra.connected ?? true, seconds: 26, showActivity: extra.showActivity ?? true });

describe("the call's look", () => {
  it("names each phase and formats the timer", () => {
    expect(phaseLabel("connecting", false)).toBe("Calling…");
    expect(phaseLabel("hearing", false)).toBe("Listening");
    expect(phaseLabel("working", false)).toBe("Working");
    expect(phaseLabel("listening", true)).toBe("Paused");
    expect(clock(26)).toBe("0:26");
    expect(clock(605)).toBe("10:05");
  });
  it("shows the activity line only while working and when the person wants it", () => {
    const working = live({ waiting: true, activity: "Reading main.ts" });
    expect(facts(working)).toMatchObject({ phase: "working", label: "Working", activity: "Reading main.ts", timer: "0:26" });
    expect(facts(working, { showActivity: false }).activity).toBe("");
    expect(facts(live({ waiting: true })).phase).toBe("thinking");
  });
  it("tells a lost microphone, a paused call and a failed connection apart", () => {
    expect(facts(live({ ready: false, needsMic: true }))).toMatchObject({ micTrouble: true, label: "Can't hear you yet" });
    expect(facts(live({ ready: false }))).toMatchObject({ paused: true, label: "Paused" });
    expect(facts(live({ ready: false, startedAt: null, error: "No key" }))).toMatchObject({ failed: true, timer: "" });
    expect(facts(live({}), { connected: false })).toMatchObject({ failed: true, label: "Reconnecting…" });
    expect(facts(INITIAL_CALL)).toMatchObject({ phase: "connecting", label: "Calling…", timer: "" });
    expect(facts(live({}), { offline: true })).toMatchObject({ offline: true, timer: "", failed: false });
  });
});
