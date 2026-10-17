import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TEAM_TEMPLATES } from "@warren/core";
import { TeamBuilder, createSlotAgents } from "../src/components/TeamBuilder.tsx";
import { blankSlot, deviceFor, harnessNote, slotProblem, slotsFor, withLead } from "../src/teamSetup.ts";
import { useStore } from "../src/store.ts";
import type { DeviceInfo } from "../src/devices.ts";
import { api } from "../src/api.ts";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

const build = TEAM_TEMPLATES.find((t) => t.id === "build")!;

describe("team setup", () => {
  it("fills roles with agents you already have on the suggested harness, once each", () => {
    const slots = slotsFor(build, [
      { id: "a1", harness: "codex" },
      { id: "a2", harness: "codex" },
      { id: "a3", harness: "claude-code" },
    ]);
    expect(slots.map((s) => [s.role, s.pick])).toEqual([
      ["Lead & builder", "new"],
      ["Backend", "a1"],
      ["Frontend & design", "new"],
      ["Reviewer", "a3"],
    ]);
    expect(slots[0]).toMatchObject({ lead: true, harness: "hermes", suggested: "hermes" });
    expect(slotsFor(null, [])).toEqual([]);
  });

  it("asks for a name per role, one role per agent, and a device for new agents", () => {
    const [a, b] = slotsFor(build, []);
    expect(slotProblem([{ ...a, pick: "x" }, { ...b, pick: "x" }], true)).toMatch(/only fill one role|only one role/);
    expect(slotProblem([{ ...a, role: " " }], true)).toMatch(/needs a name/);
    expect(slotProblem([a], false)).toMatch(/Connect a device/);
    expect(slotProblem([a, b], true)).toBeNull();
    expect(slotProblem([], false)).toBeNull();
  });

  it("always has exactly one lead", () => {
    const slots = [blankSlot(), blankSlot(), blankSlot()];
    expect(withLead(slots).map((s) => s.lead)).toEqual([true, false, false]);
    expect(withLead([slots[0], { ...slots[1], lead: true }, slots[2]]).map((s) => s.lead)).toEqual([false, true, false]);
  });

  it("puts a new agent on an online device that has its harness", () => {
    const d = (id: string, online: boolean, harnesses: string[]): DeviceInfo => ({ id, name: id, mine: true, online, agents: [], harnesses: harnesses.map((h) => ({ id: h, version: null })) });
    const devices = [d("off", false, ["kimi"]), d("mac", true, ["codex"]), d("box", true, ["kimi"])];
    expect(deviceFor("kimi", devices)?.id).toBe("box");
    expect(deviceFor("hermes", devices)?.id).toBe("mac");
    expect(deviceFor("kimi", [])).toBeUndefined();
  });

  it("offers the templates and a blank start", () => {
    const html = renderToStaticMarkup(createElement(TeamBuilder, { onClose() {} }));
    for (const label of ["Blank", "Build team", "Research team", "Solo + reviewer", "Create team"]) expect(html).toContain(label);
  });

  it("leaves the harness to the person when no device has the suggested one", () => {
    const box: DeviceInfo = { id: "n1", name: "box", mine: true, online: true, agents: [], harnesses: [{ id: "codex", version: null }] };
    const slots = slotsFor(build, [], [box]);
    expect(slots.map((s) => s.harness)).toEqual(["", "codex", "", ""]);
    expect(slotProblem([slots[0]], true)).toMatch(/Pick a harness/);
    expect(harnessNote("kimi", [box])).toBe("(not installed on box)");
    expect(harnessNote("codex", [box])).toBeNull();
    expect(harnessNote("kimi", [])).toBeNull();
  });

  it("gives each new agent its own VM on its device, and runs VM harnesses inside it", async () => {
    const calls: [string, string, any][] = [];
    let n = 0;
    vi.mocked(api).mockImplementation((async (method: string, url: string, body?: any) => {
      calls.push([method, url, body]);
      if (method === "POST" && url === "/api/computers") return { id: `vm${++n}` };
      if (url === "/api/agents") return { id: `agt${n}` };
      return [];
    }) as any);
    const box: DeviceInfo = { id: "n1", name: "box", mine: true, online: true, agents: [], harnesses: [{ id: "codex", version: null }, { id: "kimi", version: null }], capabilities: { vm: { ok: true } } as any };
    useStore.setState({ computers: [{ id: "old", kind: "vm", nodeId: "n1" } as any] });
    const [lead, , fe] = slotsFor(build, [], [box]);
    const slots = [{ ...lead, harness: "codex" }, { ...fe, harness: "kimi" }];
    await createSlotAgents(slots, [], [box], () => {});
    const vms = calls.filter((c) => c[0] === "POST" && c[1] === "/api/computers");
    expect(vms.map((c) => c[2])).toMatchObject([{ kind: "vm", nodeId: "n1" }, { kind: "vm", nodeId: "n1" }]);
    const made = calls.filter((c) => c[1] === "/api/agents").map((c) => c[2]);
    expect(made[0]).toMatchObject({ harness: "codex", nodeId: "n1", computerId: "vm1", settings: { runIn: "computer" } });
    expect(made[1]).toMatchObject({ harness: "kimi", computerId: "vm2", settings: {} });
  });

  it("starts without a computer when the device can't run VMs", async () => {
    const calls: [string, string, any][] = [];
    vi.mocked(api).mockImplementation((async (m: string, url: string, body?: any) => (calls.push([m, url, body]), url === "/api/agents" ? { id: "a" } : [])) as any);
    const box: DeviceInfo = { id: "n1", name: "box", mine: true, online: true, agents: [], harnesses: [{ id: "codex", version: null }], capabilities: { vm: { ok: false } } as any };
    useStore.setState({ computers: [] });
    await createSlotAgents([{ ...blankSlot(), role: "x", harness: "codex" }], [], [box], () => {});
    expect(calls.some((c) => c[0] === "POST" && c[1] === "/api/computers")).toBe(false);
    expect(calls.find((c) => c[1] === "/api/agents")![2]).toMatchObject({ computerId: null, settings: {} });
  });
});
