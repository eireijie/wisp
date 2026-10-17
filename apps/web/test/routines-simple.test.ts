import { describe, expect, it, vi } from "vitest";
vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

import { routineName, routineProblem, routineSteps } from "../src/views/AgentComputer.tsx";

describe("routineSteps", () => {
  it("puts the goal first and keeps written steps", () => {
    expect(routineSteps(" Send dinner ideas ", "1. Check fridge")).toBe("Goal: Send dinner ideas\n\n1. Check fridge");
  });
  it("tells the helper to work out missing steps", () => {
    expect(routineSteps("Send dinner ideas", "  ")).toMatch(/^Goal: Send dinner ideas\n\nNo steps were written/);
  });
  it("leaves steps alone without a goal", () => {
    expect(routineSteps("", "1. a")).toBe("1. a");
  });
});

describe("routineName", () => {
  it("prefers the given name", () => expect(routineName(" Dinner ", "x")).toBe("Dinner"));
  it("uses the first sentence of the result", () => expect(routineName("", "Send me dinner ideas. Include a list.")).toBe("Send me dinner ideas"));
  it("shortens long results at a word", () => {
    const n = routineName("", "Send me three dinner ideas with a shopping list every single week");
    expect(n.length).toBeLessThanOrEqual(51);
    expect(n.endsWith("…")).toBe(true);
    expect(n).not.toMatch(/\s…$/);
  });
  it("is empty when there is nothing", () => expect(routineName("", "  ")).toBe(""));
});

describe("routineProblem", () => {
  it("needs a result in Simple", () => expect(routineProblem(true, "", "")).toBeTruthy());
  it("derives the name in Simple", () => expect(routineProblem(true, "", "Do it")).toBeNull());
  it("needs a name in Advanced", () => expect(routineProblem(false, " ", "")).toBeTruthy());
});
