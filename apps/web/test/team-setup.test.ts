import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TEAM_TEMPLATES } from "@warren/core";
import { TeamBuilder } from "../src/components/TeamBuilder.tsx";
import { blankSlot, deviceFor, slotProblem, slotsFor, withLead } from "../src/teamSetup.ts";
import { useStore } from "../src/store.ts";
import type { DeviceInfo } from "../src/devices.ts";

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
});
