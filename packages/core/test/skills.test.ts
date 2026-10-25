import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, MEMORY_SKILL, SKILL_CATALOG, catalogSkill } from "../src/index.ts";

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
  });

  it("writes new skill descriptions as 'Use when'", () => {
    for (const s of SKILL_CATALOG.slice(0, 3)) expect(s.description.startsWith("Use when")).toBe(true);
  });
});

describe("built-in memory skill", () => {
  it("teaches how to file memory, and isn't in the shop", () => {
    expect(BUILTIN_SKILLS.map((s) => s.id)).toEqual(["memory"]);
    for (const must of ["memory_search", "memory_remember", "memory_write", "people/", "projects/", "topics/", "journal/YYYY-MM-DD", "type:", "source:", "related:", "[[note-name]]", "hub note", "secrets"]) expect(MEMORY_SKILL.content, must).toContain(must);
    expect(MEMORY_SKILL.description).toMatch(/^Use /);
    expect(catalogSkill("memory")).toBeUndefined();
    expect(SKILL_CATALOG.some((s) => s.id === "memory")).toBe(false);
  });
});
