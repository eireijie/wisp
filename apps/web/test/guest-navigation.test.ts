import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore, type Me } from "../src/store.ts";
import { App } from "../src/App.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn(), getToken: () => "session", setToken: vi.fn(), connectEvents: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useAppearance: () => ({}) }));
vi.mock("../src/router.ts", async (original) => ({ ...await original<typeof import("../src/router.ts")>(), useRoute: () => ({ view: "computers", computerId: "private", teach: "atlas" }) }));
vi.mock("../src/components/Sidebar.tsx", () => ({ Sidebar: () => null }));
vi.mock("../src/components/OrgRail.tsx", () => ({ OrgRail: () => null }));
vi.mock("../src/components/CommandPalette.tsx", () => ({ CommandPalette: () => null }));
vi.mock("../src/views/DashboardView.tsx", () => ({ DashboardView: () => createElement("div", null, "Dashboard fallback") }));
vi.mock("../src/views/ComputersView.tsx", () => ({ ComputersView: () => createElement("div", null, "Private screen") }));
vi.mock("../src/views/BuddyView.tsx", () => ({ BuddyView: () => null }));
vi.mock("../src/desktop.ts", () => ({ useDesktopAgents: () => {} }));
vi.mock("../src/hubUpdate.ts", () => ({ useHubUpdated: () => null }));

const initial = useStore.getInitialState();
const saved = initial.me;
afterEach(() => {
  initial.me = saved;
  vi.unstubAllGlobals();
});

function render(role: Me["role"], phone: boolean) {
  initial.me = { kind: "user", role, user: { id: "person", name: "Person", email: "me@example.com", createdAt: "now" }, workspace: { id: "workspace", name: "Lab" }, prefs: { experience: "advanced", sendWith: "enter", clock: "auto", toolCalls: "collapsed" } };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: phone }) });
  return renderToStaticMarkup(createElement(App));
}

describe("computer navigation access", () => {
  it.each([false, true])("falls back from a guest computer deep link (phone: %s)", (phone) => {
    const html = render("guest", phone);
    expect(html).toContain("Dashboard fallback");
    expect(html).not.toContain("Private screen");
    expect(html).not.toContain('href="#/computers"');
  });

  it.each(["owner", "member"] as const)("keeps the page and mobile tab for a %s", (role) => {
    const html = render(role, true);
    expect(html).toContain("Private screen");
    expect(html).toContain('href="#/computers"');
    expect(html).not.toContain("Dashboard fallback");
  });
});
