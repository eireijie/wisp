import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerPicker } from "../src/views/CreateAgent.tsx";
import { useStore } from "../src/store.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const initial = useStore.getState();
const setMode = (experience: "simple" | "advanced") => {
  (useStore.getInitialState() as { me: unknown }).me = { prefs: { experience } };
};
afterEach(() => {
  setMode("advanced");
  useStore.setState(initial, true);
});

const node = { id: "n1", name: "my-mac", online: true, mine: true, capabilities: { vm: { ok: true }, screen: { ok: true } } };
const render = () =>
  renderToStaticMarkup(
    createElement(ComputerPicker, { value: { kind: "later" }, onChange() {}, node: node as never, nodes: [node as never] }),
  );

describe("computer picker", () => {
  it("Advanced keeps the technical wording", () => {
    const html = render();
    expect(html).toContain("Computer");
    expect(html).toContain("New VM on my-mac");
    expect(html).toContain("Choose later");
    expect(html).toContain("Run it headless");
  });
  it("Simple asks where it should work and hides the headless option", () => {
    setMode("simple");
    const html = render();
    expect(html).toContain("Where should it work?");
    expect(html).toContain("Its own desktop on my-mac");
    expect(html).toContain("My own screen");
    expect(html).toContain("Decide later");
    expect(html).not.toContain("Choose later");
    expect(html).not.toContain("Run it headless");
  });
});
