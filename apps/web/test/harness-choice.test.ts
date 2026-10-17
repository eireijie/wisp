import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessStep, RECOMMENDED_HARNESSES, splitHarnesses } from "../src/views/CreateAgent.tsx";
import { useStore } from "../src/store.ts";
import { HARNESSES } from "@warren/core";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const initial = useStore.getState();
afterEach(() => {
  setMode("advanced");
  useStore.setState(initial, true);
});

const render = (invite = false) =>
  renderToStaticMarkup(createElement(HarnessStep, { harnesses: HARNESSES, harness: "claude-code", onPick() {}, invite, name: "Darnold" }));
// zustand renders its initial state on the server, so set the pref there
const setMode = (experience: "simple" | "advanced") => {
  (useStore.getInitialState() as { me: unknown }).me = { prefs: { experience } };
};
const goSimple = () => setMode("simple");

describe("harness choice", () => {
  it("splits recommended from the rest, keeping order and ignoring missing ids", () => {
    const list = [{ id: "goose" }, { id: "gemini" }, { id: "claude-code" }, { id: "acp:x" }];
    const { recommended, more } = splitHarnesses(list);
    expect(recommended.map((h) => h.id)).toEqual(["claude-code", "gemini"]);
    expect(more.map((h) => h.id)).toEqual(["goose", "acp:x"]);
    expect(RECOMMENDED_HARNESSES).toEqual(["claude-code", "codex", "gemini"]);
  });

  it("explains every harness", () => {
    for (const h of HARNESSES) {
      expect(h.blurb, h.id).toBeTruthy();
      expect(h.account, h.id).toBeTruthy();
    }
  });

  it("Advanced keeps the full grid", () => {
    const html = render();
    expect(html).toContain("Choose a harness");
    expect(html).toContain('aria-label="Agent harness"');
    expect(html).toContain("Goose");
  });

  it("Simple asks which AI and explains the recommended three", () => {
    goSimple();
    const html = render();
    expect(html).toContain("Which AI do you use?");
    for (const id of RECOMMENDED_HARNESSES) {
      const h = HARNESSES.find((x) => x.id === id)!;
      expect(html).toContain(h.label);
      expect(html).toContain(h.blurb!.replace(/'/g, "&#x27;"));
    }
    expect(html).toContain("I&#x27;m not sure");
    expect(html).toContain("More harnesses");
    expect(html).not.toContain("Goose");
    expect(html).not.toContain("Choose a harness");
  });

  it("Simple still shows the full grid when inviting an existing agent", () => {
    goSimple();
    const html = render(true);
    expect(html).toContain("Choose a harness");
    expect(html).toContain("Goose");
  });
});
