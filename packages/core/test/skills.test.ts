import { describe, expect, it } from "vitest";
import { SKILL_CATALOG, everydaySkills } from "../src/index.ts";

const banned = ["memory_search", "vault", "SKILL.md", "Markdown", "`"];

describe("skill catalog plain-language text", () => {
  it("gives every skill a plain explanation without jargon", () => {
    for (const s of SKILL_CATALOG) {
      expect(s.plain, s.id).toBeDefined();
      for (const k of ["does", "needs", "example"] as const) {
        const text = s.plain![k];
        expect(text.trim().length, `${s.id}.${k}`).toBeGreaterThan(0);
        for (const b of banned) expect(text, `${s.id}.${k} has ${b}`).not.toContain(b);
      }
    }
  });

  it("has unique ids", () => {
    const ids = SKILL_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts the everyday skills first", () => {
    const first = SKILL_CATALOG.slice(0, 3).map((s) => s.id);
    expect(first).toEqual(["meal-plan", "summarize-document", "polite-message"]);
    const ids = everydaySkills().map((s) => s.id);
    for (const id of first) expect(ids).toContain(id);
  });

  it("writes new skill descriptions as 'Use when'", () => {
    for (const s of SKILL_CATALOG.slice(0, 3)) expect(s.description.startsWith("Use when")).toBe(true);
  });
});
