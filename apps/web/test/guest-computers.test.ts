import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore, type Me } from "../src/store.ts";
import { Rail } from "../src/components/Rail.tsx";
import { ComputersView } from "../src/views/ComputersView.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn() }));
vi.mock("../src/App.tsx", () => ({ logout: vi.fn() }));
vi.mock("../src/components/OrgSwitcher.tsx", () => ({ OrgSwitcher: () => null, useOrgs: () => ({ orgs: [], current: null, homeId: null }) }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useAppearance: () => ({ resolvedMode: "light", mode: "light", setMode: vi.fn(), toggleMode: vi.fn() }) }));
vi.mock("../src/onboarding.ts", () => ({
  useOnboarding: () => ({ done: {} }),
  useDismissed: () => false,
  setupProgress: () => ({ progress: 6, steps: 6, complete: true }),
}));

const initial = useStore.getInitialState();
const saved = { me: initial.me, computers: initial.computers };
afterEach(() => Object.assign(initial, saved));

function role(role: Me["role"]) {
  initial.me = { kind: "user", role, user: { id: "person", name: "Person", email: "me@example.com", createdAt: "now" }, workspace: { id: "workspace", name: "Lab" }, prefs: { experience: "advanced", sendWith: "enter", clock: "auto", toolCalls: "collapsed" } };
}

describe("guest computer UI", () => {
  it.each(["guest", "member", "owner"] as const)("shows computer navigation only to members and owners (%s)", (viewer) => {
    role(viewer);
    const html = renderToStaticMarkup(createElement(Rail, { route: { view: "dashboard" } }));
    expect(html.includes('href="#/computers"')).toBe(viewer !== "guest");
    // everyone gets the other places on the rail
    for (const place of ["Inbox", "Chats", "Agents"]) expect(html).toContain(place);
  });

  it.each([null, "private-screen"])("hides the computers page from guests, including a cached detail (%s)", (computerId) => {
    role("guest");
    initial.computers = [{ id: "private-screen", name: "Secret computer" } as typeof initial.computers[number]];
    expect(renderToStaticMarkup(createElement(ComputersView, { computerId, teach: null }))).toBe("");
  });

  it("keeps the computer page available to members", () => {
    role("member");
    expect(renderToStaticMarkup(createElement(ComputersView, { computerId: null, teach: null }))).toContain("Computers");
  });
});
