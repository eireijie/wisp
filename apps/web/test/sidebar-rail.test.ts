import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore } from "../src/store.ts";
import { Rail, sidebarGroups } from "../src/components/Rail.tsx";
import type { Chat } from "../src/components/ChatList.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn() }));
vi.mock("../src/App.tsx", () => ({ logout: vi.fn() }));
vi.mock("../src/components/OrgSwitcher.tsx", () => ({ OrgSwitcher: () => null, useOrgs: () => ({ orgs: [], current: null, homeId: null }) }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false, useAppearance: () => ({ resolvedMode: "light", mode: "light", setMode: vi.fn(), toggleMode: vi.fn() }) }));
vi.mock("../src/onboarding.ts", () => ({
  useOnboarding: () => ({ done: {} }),
  useDismissed: () => false,
  setupProgress: () => ({ progress: 6, steps: 6, complete: true }),
  useReadyChecklist: () => ({ items: [], left: 0, started: false, workspaceId: "" }),
}));

const chat = (key: string, kind: "dm" | "team", extra: Partial<Chat> = {}): Chat => ({ key, kind, channel: null, agent: null, name: key, at: 0, unread: 0, pinned: false, muted: false, sectionId: null, ...extra });

describe("sidebar groups", () => {
  it("puts pinned first, then your sections, then agents and teams", () => {
    const groups = sidebarGroups(
      [chat("ledger", "dm", { pinned: true, sectionId: "work" }), chat("iris", "dm"), chat("launch", "team"), chat("mason", "dm", { sectionId: "work" }), chat("old", "team", { sectionId: "gone" })],
      [{ id: "work", name: "Work" } as never],
    );
    expect(groups.map((g) => [g.label, g.chats.map((c) => c.key)])).toEqual([
      ["Pinned", ["ledger"]],
      ["Work", ["mason"]],
      ["Agents", ["iris"]],
      // a chat in a deleted section falls back to its kind's group
      ["Teams", ["launch", "old"]],
    ]);
  });

  it("leaves out empty groups", () => {
    expect(sidebarGroups([chat("iris", "dm")], []).map((g) => g.label)).toEqual(["Agents"]);
  });
});

describe("docked sidebar", () => {
  const initial = useStore.getInitialState();
  const saved = { me: initial.me, agents: initial.agents };
  afterEach(() => {
    Object.assign(initial, saved);
    vi.unstubAllGlobals();
  });

  function render(stored: unknown) {
    const data = new Map<string, string>(stored ? [["wisp.sidebar", JSON.stringify(stored)]] : []);
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
    initial.me = { kind: "user", role: "owner", user: { id: "person", name: "Sam Rivera", email: "me@example.com", createdAt: "now" }, workspace: { id: "workspace", name: "Home" }, prefs: { experience: "advanced", sendWith: "enter", clock: "auto", toolCalls: "collapsed" } };
    initial.agents = [{ id: "a1", name: "Iris", status: "idle" } as (typeof initial.agents)[number]];
    return renderToStaticMarkup(createElement(Rail, { route: { view: "dashboard" } }));
  }

  it("opens at the remembered width with names and a resize edge", () => {
    const html = render({ width: 320, collapsed: false });
    expect(html).toContain("width:320px");
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain(">Agents<");
    expect(html).toContain(">Iris<");
    expect(html).toContain(">Settings, memory, usage<");
  });

  it("collapsed shows icons only, and every place is still reachable", () => {
    const html = render({ width: 320, collapsed: true });
    expect(html).toContain("width:64px");
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).not.toContain(">Agents<");
    expect(html).not.toContain(">Settings, memory, usage<");
    for (const place of ["Inbox", "All chats and search", "Iris", "New agent or team", "Computers", "Apps, skills and mods", "Account and settings"]) expect(html).toContain(`aria-label="${place}`);
  });

  it("starts at 260 with nothing saved", () => expect(render(null)).toContain("width:260px"));
});
