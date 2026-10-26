import { describe, expect, it } from "vitest";
import { skillFile } from "@wisp/core";
import { readSkillFile, readSkillLink, skillLink } from "../src/skillShare.ts";

const skill = { name: "Weekly report — Fridays", description: "Use when asked for a Friday update.", content: "# Weekly report\n\n1. Read the chats.\n2. Write five lines. ✓\n", tags: ["reports", "weekly"] };

describe("sharing a skill", () => {
  it("round-trips through a link, including non-ASCII text", () => {
    const link = skillLink(skill);
    expect(link.startsWith("wisp-skill:")).toBe(true);
    expect(link).not.toMatch(/\s/);
    expect(readSkillLink(`Here you go: ${link} (from Sam)`)).toEqual(skill);
  });

  it("does not take other text for a link", () => {
    expect(readSkillLink("https://example.com")).toBeNull();
    expect(readSkillLink("wisp-skill:not-base64!!")).toBeNull();
    expect(readSkillLink(`wisp-skill:${btoa(JSON.stringify({ n: "", c: "x" }))}`)).toBeNull();
  });

  it("reads a SKILL.md Wisp wrote", () => {
    const file = skillFile({ slug: "weekly-report", name: "Weekly report", description: "Use when asked for a Friday update.", content: "# Weekly report\n\nWrite it.\n" });
    expect(readSkillFile(file, "weekly-report.md")).toMatchObject({ name: "Weekly report", description: "Use when asked for a Friday update.", content: "# Weekly report\n\nWrite it." });
  });

  it("reads a SKILL.md from a harness, and a bare markdown file", () => {
    expect(readSkillFile("---\nname: pdf-tools\ndescription: Work with PDFs\n---\nUse them.\n")).toMatchObject({ name: "PDF tools", description: "Work with PDFs", content: "Use them." });
    expect(readSkillFile("# Standup summary\n\nOne paragraph.", "notes.md")).toMatchObject({ name: "Standup summary", description: "" });
    expect(readSkillFile("Just words.", "my-skill/SKILL.md").name).toBe("My skill");
  });
});
