import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateAgent } from "../src/views/CreateAgent.tsx";
import { useStore } from "../src/store.ts";
import { HARNESSES, type Agent } from "@warren/core";
import { HarnessLogo } from "../src/components/HarnessLogo.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

describe("add agent onboarding", () => {
  it("starts with a name and an external-agent entry point, deferring configuration", () => {
    const html = renderToStaticMarkup(
      createElement(CreateAgent, { nodes: [], onClose() {} }),
    );
    expect(html).toContain("Who’s joining?");
    expect(html).toContain("Agent name");
    expect(html).toContain("Send an invitation");
    expect(html).toContain("looking toward your pointer");
    expect(html).toContain('aria-label="Add agent steps"');
    expect(html).toMatch(/disabled=""[^>]*>Next: choose harness/);
    expect(html).not.toContain("Instructions");
    expect(html).not.toContain("Starting role");
    expect(html).not.toContain("New VM on");
    expect(html).not.toContain('aria-label="Agent harness"');
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
