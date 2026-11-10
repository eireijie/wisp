import { describe, expect, it, vi } from "vitest";
vi.mock("../components/ui.tsx", () => ({ agentColor: () => "" }));
import { linesFromEvent, linesFromMessages, repoName, toolLine } from "./data.ts";

describe("an agent's steps as terminal lines", () => {
  it("names the file or command, without the login shell around it", () => {
    expect(toolLine("Read", { file_path: "src/cart.ts" })).toEqual({ kind: "read", text: "● Read  src/cart.ts" });
    expect(toolLine("Edit", { file_path: "src/cart.ts" }).kind).toBe("edit");
    expect(toolLine("shell", { command: `/bin/zsh -lc "npm test -- \\"cart\\""` })).toEqual({ kind: "run", text: '● Shell  npm test -- "cart"' });
    expect(toolLine("shell", { command: ["bash", "-lc", "ls -la"] }).text).toBe("● Shell  ls -la");
    expect(toolLine("Wisp.task_update", {}).text).toBe("● Task update");
    expect(toolLine("mcp__wisp__memory_read", { path: "me/SOUL.md" }).text).toBe("● Memory read  me/SOUL.md");
  });

  it("shows what a command printed, not the result's JSON, and how it failed", () => {
    const out = linesFromEvent("r", 1, { type: "tool_result", name: "shell", output: { command: "npm test", exit_code: 1, output: "41 passed\n1 failed" } });
    expect(out.map((l) => l.text)).toEqual(["  41 passed", "  1 failed", "  exit 1"]);
    const long = linesFromEvent("r", 2, { type: "tool_result", name: "Bash", output: "a\nb\nc\nd\ne" });
    expect(long.map((l) => l.text)).toEqual(["  a", "  b", "  … 3 more lines"]);
    expect(linesFromEvent("r", 3, { type: "tool_result", name: "Read", output: "file text" })).toEqual([]);
  });

  it("keeps only the agent's own messages, with failures in red", () => {
    const base = { channelId: "c", threadId: "t", hop: 0, createdAt: "2026-11-09T00:00:00Z" };
    const lines = linesFromMessages(
      [
        { ...base, id: "m1", author: { kind: "user", id: "u" }, body: "do it", parts: [] },
        { ...base, id: "m2", author: { kind: "agent", id: "a" }, body: "Done: **SAVE10** works", parts: [{ type: "tool_call", name: "Read", input: { path: "cart.js" } }] },
        { ...base, id: "m3", author: { kind: "agent", id: "a" }, body: "", parts: [{ type: "status", text: "Run failed: signed out" }] },
      ],
      "a",
    );
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ["read", "● Read  cart.js"],
      ["text", "Done: SAVE10 works"],
      ["error", "Run failed: signed out"],
    ]);
  });

  it("names a repo the short way", () => {
    expect(repoName("https://github.com/eireijie/shop.git")).toBe("eireijie/shop");
    expect(repoName("git@github.com:eireijie/shop.git")).toBe("eireijie/shop");
    expect(repoName("/Users/me/code/shop")).toBe("code/shop");
  });
});
