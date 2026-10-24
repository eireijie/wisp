import { describe, expect, it, vi } from "vitest";
import type { MemoryLevel } from "@warren/core";
import { accessSummary, isShared } from "../src/components/AccessDialog.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const person = (id: string, name: string, level: MemoryLevel) => ({ id, name, level });
const agent = (id: string, handle: string, level: MemoryLevel) => ({ id, handle, level });
const opts = { myId: "u1", agentName: (id: string) => (id === "a1" ? "Everyday Helper" : "Researcher") };

describe("accessSummary", () => {
  it("lists you first, then people and helpers by name", () => {
    const info = { people: [person("u2", "Alex", "read"), person("u1", "Alex", "manage"), person("u3", "Sam", "none")], agents: [agent("a1", "helper", "edit"), agent("a2", "res", "none")] };
    expect(accessSummary(info, opts)).toEqual({ read: "you, Alex, Everyday Helper", change: "you, Everyday Helper" });
  });

  it("uses plain group words when everyone / every helper is included", () => {
    const info = { people: [person("u1", "Alex", "manage"), person("u2", "Alex", "edit")], agents: [agent("a1", "helper", "edit"), agent("a2", "res", "read")] };
    expect(accessSummary(info, opts)).toEqual({ read: "everyone in the organization, all helpers", change: "everyone in the organization, Everyday Helper" });
  });

  it("follows an inherited folder rule and an override on the note", () => {
    const people = [person("u1", "Alex", "manage")];
    // the folder rule gives the helper edit, so the note inherits it
    expect(accessSummary({ people, agents: [agent("a1", "helper", "edit")] }, opts).change).toBe("you, Everyday Helper");
    // a rule set on the note drops the helper to read only
    expect(accessSummary({ people, agents: [agent("a1", "helper", "read")] }, opts)).toEqual({ read: "you, Everyday Helper", change: "you" });
    // and to no access at all
    expect(accessSummary({ people, agents: [agent("a1", "helper", "none")] }, opts)).toEqual({ read: "you", change: "you" });
  });

  it("says nobody when nobody has access, and falls back to the handle", () => {
    expect(accessSummary({ people: [person("u2", "Alex", "none")], agents: [] }, opts).read).toBe("nobody");
    expect(accessSummary({ people: [], agents: [agent("a9", "ghost", "read")] }, {}).read).toBe("ghost");
  });
});

describe("isShared", () => {
  it("matches the Shared folder and what is inside it", () => {
    expect(isShared("Shared")).toBe(true);
    expect(isShared("shared/notes/a.md")).toBe(true);
    expect(isShared("people/u1")).toBe(false);
  });
});
