import { describe, expect, it, vi } from "vitest";
import { catalogSkill } from "@wisp/core";
import { plainSkill, whatItsFor } from "../src/views/SkillsView.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const meal = catalogSkill("meal-plan")!;

describe("plainSkill", () => {
  it("uses the catalog's plain text for a library entry", () => {
    expect(plainSkill(null, meal)).toEqual({ does: meal.plain!.does, needs: meal.plain!.needs, example: meal.plain!.example });
  });
  it("uses it for an installed, unedited catalog skill", () => {
    const skill = { description: meal.description, content: meal.content, catalogId: "meal-plan" };
    expect(plainSkill(skill, meal)).toEqual({ does: meal.plain!.does, needs: meal.plain!.needs, example: meal.plain!.example });
  });
  it("falls back to the description when the installed skill was edited", () => {
    const skill = { description: "Use when planning dinners for my family.", content: meal.content + "\n- Extra rule", catalogId: "meal-plan" };
    expect(plainSkill(skill, meal)).toEqual({ does: whatItsFor(skill.description), needs: null, example: null });
  });
  it("falls back for a custom skill", () => {
    const skill = { description: "Use when asked to water the plants.", content: "# Plants", catalogId: null };
    expect(plainSkill(skill, undefined)).toEqual({ does: "When asked to water the plants.", needs: null, example: null });
    expect(plainSkill(skill, meal).needs).toBeNull();
  });
});
