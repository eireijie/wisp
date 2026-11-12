import { describe, expect, it, vi } from "vitest";
vi.mock("../components/ui.tsx", () => ({ agentColor: () => "" }));
import type { Actor, Message } from "@wisp/core";
import { repoName } from "./data.ts";
import { harnessStyle, stepLine, termFromEvent, termFromMessages, workingText } from "./terminal.ts";

const base = { channelId: "c", threadId: "t", hop: 0, createdAt: "2026-11-09T00:00:00Z" };
const names: Record<string, string> = { u: "you", lead: "Atlas", a: "Ivy" };
const nameOf = (a: Actor) => names[a.id] ?? "someone";

describe("an agent's work as its CLI's terminal", () => {
  it("draws each step in that harness's own marks, without the login shell around commands", () => {
    const codex = harnessStyle("codex");
    expect(stepLine(codex, "shell", { command: `/bin/zsh -lc "npm test -- \\"cart\\""` })).toEqual({ kind: "run", text: '• Ran npm test -- "cart"' });
    expect(stepLine(codex, "apply_patch", { path: "api/payments.ts" }).text).toBe("• Edited api/payments.ts");
    const claude = harnessStyle("claude-code");
    expect(stepLine(claude, "Bash", { command: ["bash", "-lc", "ls -la"] })).toEqual({ kind: "run", text: "⏺ Bash(ls -la)" });
    expect(stepLine(claude, "Read", { file_path: "src/cart.ts" }).text).toBe("⏺ Read(src/cart.ts)");
    expect(stepLine(harnessStyle("gemini"), "ReadFile", { path: "notes.md" }).text).toBe("✦ ReadFile notes.md");
    expect(stepLine(harnessStyle("hermes"), "mcp__wisp__memory_read", { path: "me/SOUL.md" }).text).toBe("● Memory read  me/SOUL.md");
  });

  it("shows what a command printed, not the result's JSON, and how it failed", () => {
    const claude = harnessStyle("claude-code");
    const out = termFromEvent(claude, "r", 1, { type: "tool_result", name: "Bash", output: { command: "npm test", exit_code: 1, output: "41 passed\n1 failed" } });
    expect(out.map((l) => l.text)).toEqual(["  ⎿  41 passed", "  ⎿  1 failed", "  ⎿  exit 1"]);
    const long = termFromEvent(harnessStyle("codex"), "r", 2, { type: "tool_result", name: "shell", output: "a\nb\nc\nd\ne" });
    expect(long.map((l) => l.text)).toEqual(["  └ a", "  └ b", "  └ … 3 more lines"]);
    expect(termFromEvent(claude, "r", 3, { type: "tool_result", name: "Read", output: "file text" })).toEqual([]);
  });

  it("shows the prompts it was given, who from, and what it sent on", () => {
    const codex = harnessStyle("codex");
    const lines = termFromMessages(
      [
        { ...base, id: "m0", author: { kind: "user", id: "u" }, body: "@lead launch it", parts: [], to: [{ kind: "agent", id: "lead" }] },
        { ...base, id: "m1", author: { kind: "agent", id: "lead" }, body: "@a New task **Payments**\n\nStripe intents", parts: [], to: [{ kind: "agent", id: "a" }] },
        { ...base, id: "m2", author: { kind: "agent", id: "a" }, body: "Done: **SAVE10** works", parts: [{ type: "tool_call", name: "Read", input: { path: "cart.js" } }], to: [{ kind: "agent", id: "lead" }] },
        { ...base, id: "m3", author: { kind: "agent", id: "a" }, body: "", parts: [{ type: "status", text: "Run failed: signed out" }] },
      ] as Message[],
      "a",
      codex,
      nameOf,
    );
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ["prompt", "› [from Atlas] Payments"],
      ["step", "• Read cart.js"],
      ["text", "→ Atlas: Done: SAVE10 works"],
      ["error", "Run failed: signed out"],
    ]);
    // a prompt from another agent can be followed back to it
    expect(lines[0].from).toBe("lead");
  });

  it("says what it's on, the way its CLI does", () => {
    expect(workingText(harnessStyle("codex"), "Running a command", 12)).toBe("◦ Running a command (12s • esc to interrupt)");
    expect(workingText(harnessStyle("claude-code"), "Thinking", 3)).toBe("✻ Thinking (3s • esc to interrupt)");
  });

  it("names a repo the short way", () => {
    expect(repoName("https://github.com/eireijie/shop.git")).toBe("eireijie/shop");
    expect(repoName("git@github.com:eireijie/shop.git")).toBe("eireijie/shop");
    expect(repoName("/Users/me/code/shop")).toBe("code/shop");
  });
});
