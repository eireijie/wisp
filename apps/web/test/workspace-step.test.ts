import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerPicker } from "../src/views/CreateAgent.tsx";
import { useStore } from "../src/store.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

const node = { id: "n1", name: "my-mac", online: true, mine: true, capabilities: { vm: { ok: true }, screen: { ok: true } } };
const render = () =>
  renderToStaticMarkup(
    createElement(ComputerPicker, { value: { kind: "later" }, onChange() {}, node: node as never, nodes: [node as never] }),
  );

describe("computer picker", () => {
  it("asks where it should work and keeps the headless option under More options", () => {
    const html = render();
    expect(html).toContain("Where should it work?");
    expect(html).toContain("Its own desktop on my-mac");
    expect(html).toContain("My own screen");
    expect(html).toContain("Decide later");
    expect(html).toContain("More options");
    expect(html).not.toContain("Choose later");
    expect(html).not.toContain("Run it headless");
  });
});
