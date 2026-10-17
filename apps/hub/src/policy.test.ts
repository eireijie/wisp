import { describe, expect, it } from "vitest";
import { ASK_BEFORE, ASK_BEFORE_DEFAULT, agentPolicy } from "./policy.ts";
import type { Hub } from "./hub.ts";

const hubWith = (saved?: string) => ({ store: { setting: (_w: string, k: string) => (k === "agents.askBefore" ? saved : undefined) } }) as unknown as Hub;
const ask = (saved?: string) => agentPolicy(hubWith(saved), "w1").askBefore;

describe("agentPolicy askBefore", () => {
  it("default covers every ASK_BEFORE entry", () => {
    expect([...ASK_BEFORE_DEFAULT].sort()).toEqual([...ASK_BEFORE].sort());
    expect(ASK_BEFORE).toHaveLength(6);
  });
  it("uses all six when nothing is saved", () => {
    expect([...ask(undefined)].sort()).toEqual([...ASK_BEFORE].sort());
  });
  it("respects a saved list, including an empty one", () => {
    expect(ask('["send"]')).toEqual(["send"]);
    expect(ask("[]")).toEqual([]);
  });
  it("drops unknown entries", () => {
    expect(ask('["send","bogus",1]')).toEqual(["send"]);
  });
  it("falls back to the default on invalid JSON", () => {
    expect([...ask("{nope")].sort()).toEqual([...ASK_BEFORE].sort());
  });
  it("returns a fresh array so callers cannot change the default", () => {
    const a = ask(undefined);
    a.pop();
    expect(ask(undefined)).toHaveLength(6);
    expect(ASK_BEFORE_DEFAULT).toHaveLength(6);
  });
});
