import { describe, expect, it, vi } from "vitest";
import { cleanPreview, messageKind, messageLocation, noteLocation } from "../src/components/CommandPalette.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const lookup = { people: { usr_yN7fNNXTN6NP: "Sam Lee" }, agents: { agt_Ab3dEf9Gh1: "maya" }, teams: { team_Zx81Qw2Er3: "Support" } };

describe("cleanPreview", () => {
  it("strips Markdown markers", () => {
    expect(cleanPreview("## Dinner\n- **likes** _pasta_ and `rice`\n> see [the menu](https://x.co/a) ![pic](a.png)")).toBe("Dinner likes pasta and rice see the menu pic");
  });
  it("strips code fences, tables and html", () => {
    expect(cleanPreview("Intro\n```\nsecret code\n```\n| a | b |\n|---|---|\n<b>bold</b> end")).toBe("Intro a b bold end");
  });
  it("removes search markers and keeps ellipses tidy", () => {
    expect(cleanPreview("…likes **pasta** for dinner…")).toBe("…likes pasta for dinner…");
  });
  it("removes ids and vault paths but keeps snake_case words", () => {
    const out = cleanPreview("Saved to people/usr_yN7fNNXTN6NP/preferences.md by agt_Ab3dEf9Gh1 for tsk_9Kd82hQ1x; use user_preferences");
    expect(out).not.toMatch(/usr_|agt_|tsk_|people\//);
    expect(out).toContain("user_preferences");
  });
  it("drops internal task instructions and bracketed meta lines", () => {
    const out = cleanPreview("[system]\nWrite the menu\n\nThis is task `tsk_9Kd82hQ1x`.\n\nWhen finished, report back with the task result (warren tool `task_update`, status done).");
    expect(out).toBe("Write the menu");
  });
  it("collapses whitespace and caps length with an ellipsis", () => {
    expect(cleanPreview("a\n\n  b   c")).toBe("a b c");
    const long = cleanPreview("word ".repeat(100), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("noteLocation", () => {
  it("shared notes", () => {
    expect(noteLocation("shared/dinner-preferences.md", "Dinner preferences", lookup)).toBe("Memory › Shared › Dinner preferences");
  });
  it("people notes use the person's name", () => {
    expect(noteLocation("people/usr_yN7fNNXTN6NP/preferences.md", "Preferences", lookup)).toBe("Memory › Sam Lee › Preferences");
  });
  it("agent notes use the handle", () => {
    expect(noteLocation("agents/agt_Ab3dEf9Gh1/notes.md", "", lookup)).toBe("Memory › @maya › Notes");
  });
  it("unknown ids never leak", () => {
    const out = noteLocation("people/usr_unknown12345/x_y.md", "", lookup);
    expect(out).toBe("Memory › A person › X y");
    expect(noteLocation("agents/agt_zzzzzzzzzz/a.md", "A", lookup)).toBe("Memory › An agent › A");
  });
  it("teams and groups", () => {
    expect(noteLocation("teams/team_Zx81Qw2Er3/plan.md", "Launch plan", lookup)).toBe("Memory › Support › Launch plan");
    expect(noteLocation("groups/family.md", "Family", lookup)).toBe("Memory › Groups › Family");
  });
});

describe("messageKind and messageLocation", () => {
  it("detects tasks, routines and plain messages", () => {
    expect(messageKind({ parts: [{ type: "task", taskId: "t" }] })).toBe("Task");
    expect(messageKind({ parts: [{ type: "routine", routineId: "r" }] })).toBe("Routine");
    expect(messageKind({ parts: [{ type: "status", text: "x" }] })).toBe("Message");
    expect(messageKind({ parts: [] })).toBe("Message");
  });
  it("names where a message lives", () => {
    expect(messageLocation("general", {})).toBe("#general");
    expect(messageLocation("dm:usr_a:agt_Ab3dEf9Gh1", lookup.agents)).toBe("DM with @maya");
    expect(messageLocation("dm:usr_a:agt_gone", lookup.agents)).toBe("Direct message");
  });
});
