import { describe, expect, it } from "vitest";
import { agentReadiness, type DeviceInfo } from "../src/devices.ts";

const dev = (o: Partial<DeviceInfo> = {}): DeviceInfo => ({ id: "n1", name: "my-mac", online: true, agents: [], ...o });
const agent = (o: { nodeId?: string | null; harness?: string } = {}) => ({ nodeId: "n1", harness: "gemini", ...o }) as Parameters<typeof agentReadiness>[0];

describe("agentReadiness", () => {
  it("is ready when its device is online and has the harness", () => {
    expect(agentReadiness(agent(), [dev({ harnesses: [{ id: "gemini", version: "1" }] })])).toEqual({ ready: true, problem: null });
  });
  it("says there is no device yet", () => {
    expect(agentReadiness(agent({ nodeId: null }), [dev()])).toEqual({ ready: false, problem: "No device yet" });
  });
  it("names an offline or paused device", () => {
    expect(agentReadiness(agent(), [dev({ online: false })])).toEqual({ ready: false, problem: "my-mac is offline" });
    expect(agentReadiness(agent(), [dev({ paused: true })])).toEqual({ ready: false, problem: "my-mac is paused" });
  });
  it("names a harness the device reported without", () => {
    expect(agentReadiness(agent(), [dev({ harnesses: [{ id: "codex", version: null }] })])).toEqual({ ready: false, problem: "Gemini CLI isn't installed on my-mac" });
  });
  it("labels device-declared ACP harnesses", () => {
    const r = agentReadiness(agent({ harness: "acp:my-bot" }), [dev({ harnesses: [{ id: "codex", version: null }] })]);
    expect(r.problem).toBe("my-bot isn't installed on my-mac");
  });
  it("never flags what it doesn't know", () => {
    expect(agentReadiness(agent(), null).ready).toBe(true);
    expect(agentReadiness(agent(), [dev({ id: "other", online: false })]).ready).toBe(true);
    expect(agentReadiness(agent(), [dev()]).ready).toBe(true);
    expect(agentReadiness(agent(), [dev({ harnesses: [] })]).ready).toBe(true);
  });
  it("skips the harness check for harnesses that can run in a VM or connect themselves", () => {
    const others = [{ id: "gemini", version: null }];
    expect(agentReadiness(agent({ harness: "claude-code" }), [dev({ harnesses: others })]).ready).toBe(true);
    expect(agentReadiness(agent({ harness: "custom", nodeId: null }), [dev()]).ready).toBe(true);
  });
});
