import { describe, expect, it, vi } from "vitest";
import { helperLine, skillFromGuide, trySuggestion, whatItsFor } from "../src/views/SkillsView.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

describe("whatItsFor", () => {
  it("takes the first sentence and rewrites the Use when lead-in", () => {
    expect(whatItsFor("Use when asked to answer a customer email. Drafts for a person.")).toBe("When asked to answer a customer email.");
    expect(whatItsFor("Use for a daily digest of email.")).toBe("For a daily digest of email.");
    expect(whatItsFor("")).toBe("");
  });
  it("truncates long text at a word boundary", () => {
    const out = whatItsFor("Use when " + "word ".repeat(50), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
});

describe("helperLine", () => {
  const agents = [
    { id: "a", name: "Everyday Agent" },
    { id: "b", name: "Coder" },
    { id: "c", name: "Writer" },
  ];
  it("says who has it", () => {
    expect(helperLine(agents, [])).toBe("No agent has this yet");
    expect(helperLine(agents, ["gone"])).toBe("No agent has this yet");
    expect(helperLine(agents, ["a"])).toBe("Everyday Agent has this");
    expect(helperLine(agents, ["a", "b"])).toBe("Everyday Agent and Coder have this");
    expect(helperLine(agents, ["a", "b", "c"])).toBe("Everyday Agent, Coder and 1 more have this");
  });
});

describe("trySuggestion", () => {
  it("names the skill and what it is for", () => {
    const t = trySuggestion({ name: "Summarize a meeting", description: "Use when given a meeting transcript to turn into notes." });
    expect(t).toContain('"Summarize a meeting"');
    expect(t).toContain("when given a meeting transcript to turn into notes.");
    expect(trySuggestion({ name: "X", description: "" })).toBe('Please use your "X" skill for this. Here is what I have: ');
  });
});

describe("skillFromGuide", () => {
  it("builds a Use when description and markdown, trimming answers", () => {
    const r = skillFromGuide({ name: " Summarize a meeting ", what: "  Write a recap.  ", when: " I paste notes ", result: "One page" });
    expect(r.description).toBe("Use when I paste notes");
    expect(r.content).toBe("# Summarize a meeting\n\n## What to do\nWrite a recap.\n\n## When to use it\nI paste notes\n\n## What a good result looks like\nOne page\n");
  });
  it("omits empty sections and keeps an existing Use when", () => {
    const r = skillFromGuide({ name: "A", what: "Do it", when: "  ", result: "" });
    expect(r.description).toBe("");
    expect(r.content).toBe("# A\n\n## What to do\nDo it\n");
    expect(skillFromGuide({ name: "A", what: "x", when: "Use when asked: now", result: "" }).description).toBe("Use when asked: now");
  });
  it("flattens newlines and colons in the one-line description", () => {
    const r = skillFromGuide({ name: "A", what: "x", when: "Asked for:\nreports\r\nweekly", result: "" });
    expect(r.description).toBe("Use when asked for: reports weekly");
    expect(r.description).not.toMatch(/\n/);
    expect(skillFromGuide({ name: "", what: "x", when: "", result: "" }).content).toContain("# New skill");
  });
});
