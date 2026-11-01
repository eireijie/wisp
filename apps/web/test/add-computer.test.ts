import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddComputer, DEFAULT_SIZE, capabilityKind, orgoStatus } from "../src/views/ComputersView.tsx";
import { useStore } from "../src/store.ts";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const initial = useStore.getState();
afterEach(() => {
  (useStore.getInitialState() as { me: unknown }).me = initial.me;
});

describe("add computer choices", () => {
  it("maps answers to computer kinds; chat-only creates nothing", () => {
    expect(capabilityKind("chat")).toBeNull();
    expect(capabilityKind(null)).toBeNull();
    expect(capabilityKind("vm")).toBe("vm");
    expect(capabilityKind("device")).toBe("device");
  });

  it("makes new computers medium unless a size is picked", () => {
    expect(DEFAULT_SIZE).toBe("medium");
  });

  it("treats loading and missing Orgo key as unavailable", () => {
    expect(orgoStatus(null)).toBe("checking");
    expect(orgoStatus({ configured: false })).toBe("needs-key");
    expect(orgoStatus({ configured: true })).toBe("ready");
  });

  const render = () => renderToStaticMarkup(createElement(AddComputer, { devices: [], onClose: () => {}, onCreated: () => {} }));

  it("asks what the agent should be able to do, with the cloud computer under More options", () => {
    const html = render();
    expect(html).toContain("What should the agent be able to do?");
    expect(html).toContain("Answer questions only");
    expect(html).toContain("More options");
  });
});
