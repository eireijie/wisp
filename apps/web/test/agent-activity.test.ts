import { describe, expect, it, vi } from "vitest";
import { accessScope, runStatusLabel, runTitle } from "../src/views/AgentSettings.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

describe("runTitle", () => {
  it("gives no title when there's no message (a hidden DM or a background check)", () => {
    expect(runTitle(null)).toBe("");
    expect(runTitle("")).toBe("");
    expect(runTitle("  \n ")).toBe("");
  });
  it("reads known hub message shapes", () => {
    expect(runTitle("@agent New task **Write a note**\n\nPut it in the vault.")).toBe("Task: Write a note");
    expect(runTitle("@agent Run the routine **Bin day**, because it is Monday")).toBe("Routine: Bin day");
    expect(runTitle("@agent Run the routine **Bin day**.")).toBe("Routine: Bin day");
    expect(runTitle("@agent I just showed you how to **file invoices**. Learn it now.")).toBe("Learning: file invoices");
  });
  it("cleans other messages", () => {
    expect(runTitle("@agent @sam   what is **up** with `this`?\nsecond line")).toBe("what is up with this?");
    expect(runTitle("\n\n_hello_ there")).toBe("hello there");
    expect(runTitle("snake_case stays")).toBe("snake_case stays");
  });
  it("truncates to 80 characters", () => {
    const t = runTitle("@a " + "x".repeat(200));
    expect(t).toBe("x".repeat(80) + "…");
  });
});

describe("runStatusLabel", () => {
  it("uses plain words", () => {
    expect(runStatusLabel("queued")).toBe("Waiting to start");
    expect(runStatusLabel("running")).toBe("Working");
    expect(runStatusLabel("done")).toBe("Done");
    expect(runStatusLabel("failed")).toBe("Didn't finish");
    expect(runStatusLabel("cancelled")).toBe("Stopped");
    expect(runStatusLabel("paused")).toBe("Paused");
  });
});

describe("accessScope", () => {
  const at = (computer: "shared" | "own" | null, advanced = false) => ({ device: "Mac" as string | undefined, computer, handle: "nova", advanced });
  it("states what each level asks for, not a guarantee", () => {
    expect(accessScope("read-only", "Nova", at(null))).toBe("Nova reads files and asks before changing any.");
    expect(accessScope("edit", "Nova", at(null))).toContain("its own folder on Mac");
    expect(accessScope("full", "Nova", at(null))).toContain("if Mac allows full access");
    expect(accessScope("full", "Nova", { ...at(null), device: undefined })).toContain("no device yet");
  });
  it("says where an agent on a computer really works, with paths and caveats only in Advanced", () => {
    const simple = accessScope("edit", "Nova", at("shared"));
    expect(simple).toContain("its own folder on the shared computer");
    expect(simple).not.toContain("~/");
    expect(simple).not.toContain("strictly");
    expect(accessScope("edit", "Nova", at("shared", true))).toContain("~/files/nova");
    expect(accessScope("edit", "Nova", at("own"))).toContain("its computer's files");
    expect(accessScope("edit", "Nova", at(null, true))).toContain("~/.wisp/agents/nova");
  });
});
