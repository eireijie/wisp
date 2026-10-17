import { describe, expect, it, vi } from "vitest";
import { accessScope, runStatusLabel, runTitle } from "../src/views/AgentSettings.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

describe("runTitle", () => {
  it("names background checks", () => {
    expect(runTitle(null)).toBe("Background check");
    expect(runTitle("")).toBe("Background check");
    expect(runTitle("  \n ")).toBe("Background check");
  });
  it("reads known hub message shapes", () => {
    expect(runTitle("@helper New task **Write a note**\n\nPut it in the vault.")).toBe("Task: Write a note");
    expect(runTitle("@helper Run the routine **Bin day**, because it is Monday")).toBe("Routine: Bin day");
    expect(runTitle("@helper Run the routine **Bin day**.")).toBe("Routine: Bin day");
    expect(runTitle("@helper I just showed you how to **file invoices**. Learn it now.")).toBe("Learning: file invoices");
  });
  it("cleans other messages", () => {
    expect(runTitle("@helper @sam   what is **up** with `this`?\nsecond line")).toBe("what is up with this?");
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
  it("states the reach per level", () => {
    expect(accessScope("read-only", "Nova", "nova", "Mac")).toContain("can read files on Mac but can't change anything");
    expect(accessScope("edit", "Nova", "nova", "Mac")).toContain("~/.warren/agents/nova");
    expect(accessScope("full", "Nova", "nova", "Mac")).toContain("any command");
    expect(accessScope("full", "Nova", "nova", undefined)).toContain("no device yet");
  });
});
