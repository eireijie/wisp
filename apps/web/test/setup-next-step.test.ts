import { describe, expect, it, vi } from "vitest";
import { setupNextStep } from "../src/components/AgentPanel.tsx";
import type { DeviceInfo } from "../src/devices.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const dev = (o: Partial<DeviceInfo> = {}): DeviceInfo => ({ id: "n1", name: "my-mac", online: true, agents: [], harnesses: [{ id: "claude-code", version: "1" }], ...o });
const agent = (o: Record<string, unknown> = {}) => ({ id: "a1", name: "Ada", nodeId: "n1", harness: "claude-code", ...o }) as Parameters<typeof setupNextStep>[0];

describe("setupNextStep", () => {
  it("is null when ready", () => expect(setupNextStep(agent(), [dev()])).toBeNull());
  it("is null for an mcp harness", () => expect(setupNextStep(agent({ harness: "custom", nodeId: null }), [])).toBeNull());
  it("asks for a device", () =>
    expect(setupNextStep(agent({ nodeId: null }), [dev()])).toEqual({ text: "Choose the computer that runs Ada.", href: "#/agents/a1/device", action: "Choose a device" }));
  it("explains offline", () =>
    expect(setupNextStep(agent(), [dev({ online: false })])).toEqual({ text: "Open Warren on my-mac so it reconnects. Messages wait until then.", href: "#/nodes", action: "See devices" }));
  it("explains paused", () =>
    expect(setupNextStep(agent(), [dev({ paused: true })])).toEqual({ text: "my-mac is paused. Resume it on that computer.", href: "#/nodes", action: "See devices" }));
  it("points to install", () => {
    const s = setupNextStep(agent({ harness: "acp:foo" }), [dev({ harnesses: [{ id: "codex", version: null }] })]);
    expect(s?.text).toBe("Install foo on my-mac.");
    expect(s).toMatchObject({ href: "#/settings/runtimes", action: "Install it" });
  });
});
