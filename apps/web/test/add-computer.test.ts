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

  const render = (experience: "simple" | "advanced") => {
    // zustand renders the initial state on the server, so set it there
    (useStore.getInitialState() as { me: unknown }).me = { prefs: { experience } };
    return renderToStaticMarkup(createElement(AddComputer, { devices: [], onClose: () => {}, onCreated: () => {} }));
  };

  it("asks the question in Simple mode only", () => {
    expect(render("simple")).toContain("What should the helper be able to do?");
    expect(render("simple")).toContain("Answer questions only");
    expect(render("advanced")).not.toContain("What should the helper be able to do?");
    expect(render("advanced")).toContain("A VM on one of your devices");
  });
});
