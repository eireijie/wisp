import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateAgent } from "../src/views/CreateAgent.tsx";
import { useStore } from "../src/store.ts";
import { HARNESSES, type Agent } from "@wisp/core";
import { HarnessLogo } from "../src/components/HarnessLogo.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

describe("add agent onboarding", () => {
  it("is one screen: ghost, name, job, instructions, AI and computer, with Advanced and Bring it in", () => {
    const html = renderToStaticMarkup(
      createElement(CreateAgent, { nodes: [], onClose() {} }),
    );
    expect(html).toContain("New agent");
    expect(html).toContain("looking toward your pointer");
    expect(html).toContain("Shuffle");
    expect(html).toContain("Edit look");
    expect(html).toContain("What it does");
    // templates live on their own page now, not in this form
    expect(html).not.toContain("Start from");
    expect(html).toContain("Instructions");
    expect(html).toContain("AI and computer");
    expect(html).toContain("Use my defaults");
    expect(html).toContain("Customize");
    expect(html).toContain("Advanced");
    expect(html).toContain("Already running somewhere? Bring it in");
    // nothing to create until it has a name
    expect(html).toMatch(/disabled=""[^>]*>(<!-- -->)?Create agent/);
    // no emoji tiles for roles
    for (const t of ["🧭", "📥"]) expect(html).not.toContain(t);
  });

  it("can open before any device or agent is connected", () => {
    useStore.setState({ agents: [], computers: [] });
    expect(() =>
      renderToStaticMarkup(
        createElement(CreateAgent, { nodes: [], onClose() {} }),
      ),
    ).not.toThrow();
  });

  it("provides a source logo for each named built-in harness", () => {
    for (const h of HARNESSES.filter((h) => h.id !== "custom")) {
      const html = renderToStaticMarkup(
        createElement(HarnessLogo, { harness: h.id as Agent["harness"] }),
      );
      expect(html, h.id).toContain("/harnesses/");
    }
  });
});
