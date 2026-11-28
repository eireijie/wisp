import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore } from "../src/store.ts";
import { Rail, sidebarGroups } from "../src/components/Rail.tsx";
import { SIDEBAR } from "../src/sidebarWidth.ts";
import type { Chat } from "../src/components/ChatList.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn() }));
vi.mock("../src/App.tsx", () => ({ logout: vi.fn() }));
vi.mock("../src/components/OrgSwitcher.tsx", () => ({ OrgSwitcher: () => null, OrgList: () => null, NewOrgDialog: () => null, useOrgs: () => ({ orgs: [], current: null, homeId: null }) }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false, useAppearance: () => ({ resolvedMode: "light", mode: "light", setMode: vi.fn(), toggleMode: vi.fn() }) }));
vi.mock("../src/onboarding.ts", () => ({
  useOnboarding: () => ({ done: {} }),
  useDismissed: () => false,
  setupProgress: () => ({ progress: 6, steps: 6, complete: true }),
  useReadyChecklist: () => ({ items: [], left: 0, started: false, workspaceId: "" }),
}));

const chat = (key: string, kind: "dm" | "team", extra: Partial<Chat> = {}): Chat => ({ key, kind, channel: null, agent: null, name: key, at: 0, unread: 0, pinned: false, muted: false, sectionId: null, ...extra });

describe("sidebar groups", () => {
  it("puts pinned first, then agents and teams in no section as one list, then your sections", () => {
    const groups = sidebarGroups(
      [chat("ledger", "dm", { pinned: true, sectionId: "work" }), chat("iris", "dm"), chat("launch", "team"), chat("mason", "dm", { sectionId: "work" }), chat("old", "team", { sectionId: "gone" })],
      [{ id: "work", name: "Work" } as never],
    );
    expect(groups.map((g) => [g.label, g.chats.map((c) => c.key)])).toEqual([
      ["Pinned", ["ledger"]],
      // agents and teams together, in the order they came in (newest first); a chat in a deleted section falls back here
      ["Agents and teams", ["iris", "launch", "old"]],
      ["Work", ["mason"]],
    ]);
  });

  it("gives only Pinned and your own sections a header", () => {
    const groups = sidebarGroups([chat("ledger", "dm", { pinned: true }), chat("iris", "dm"), chat("mason", "dm", { sectionId: "work" })], [{ id: "work", name: "Work" } as never]);
    expect(groups.map((g) => [g.id, !g.plain])).toEqual([["pinned", true], ["chats", false], ["work", true]]);
    expect(groups[2].section?.name).toBe("Work");
  });

  it("leaves out Pinned and the plain list when empty, and keeps a section you made", () => {
    expect(sidebarGroups([chat("iris", "dm")], []).map((g) => g.id)).toEqual(["chats"]);
    expect(sidebarGroups([chat("iris", "dm", { sectionId: "work" })], [{ id: "work", name: "Work" } as never, { id: "later", name: "Later" } as never]).map((g) => [g.label, g.chats.length])).toEqual([["Work", 1], ["Later", 0]]);
  });
});

describe("docked sidebar", () => {
  const initial = useStore.getInitialState();
  const saved = { me: initial.me, agents: initial.agents, approvals: initial.approvals, channels: initial.channels };
  afterEach(() => {
    Object.assign(initial, saved);
    vi.unstubAllGlobals();
  });

  // nothing pinned (round 16: the hub pins someone's first agent; sidebarLayout.test.ts, first-agent-pin.test.ts)
  const pins: { sidebar?: { pins: string[]; sections: [] } } = { sidebar: { pins: [], sections: [] } };
  function render(stored: unknown) {
    const data = new Map<string, string>(stored ? [["wisp.sidebar2", JSON.stringify(stored)]] : []);
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
    initial.me = { kind: "user", role: "owner", user: { id: "person", name: "Sam Rivera", email: "me@example.com", createdAt: "now" }, workspace: { id: "workspace", name: "Home" }, prefs: { experience: "advanced", sendWith: "enter", clock: "auto", toolCalls: "collapsed", ...pins } };
    // Iris has a computer, so she is not waiting on the person (an agent with none counts under Needs you)
    initial.agents = [{ id: "a1", name: "Iris", status: "idle", nodeId: "n1", harness: "claude-code" } as (typeof initial.agents)[number]];
    return renderToStaticMarkup(createElement(Rail, { route: { view: "dashboard" } }));
  }

  it("opens at the remembered width: your initials and + on top, the list, five places at the foot, a resize edge", () => {
    const html = render({ width: 360, collapsed: false });
    expect(html).toContain("width:360px");
    expect(html).toContain('role="separator"');
    expect(html).toContain(">Iris<");
    // round 11: your initials open settings, and the + menu sits beside them
    expect(html).toMatch(/aria-label="You and settings"[^>]*>[^]*?<span>SR<\/span>/);
    expect(html).toContain('aria-label="New agent, team or chat"');
    // the five places, icon-only, in the strip at the foot (a guest gets fewer: guest-computers.test.ts)
    const places = html.slice(html.indexOf('aria-label="Places"'));
    for (const place of ["Chats", "Computers", "Memory", "Marketplace", "More"]) expect(places).toMatch(new RegExp(`aria-label="${place}[",]`));
    expect(places).toContain('href="#/computers" aria-label="Computers"');
    expect(places).toContain('data-tour="vault"');
    expect(places).toContain('href="#/marketplace" aria-label="Marketplace"');
    // no search box, no account button, no Connect apps pill
    for (const gone of ['aria-label="Search"', 'aria-label="Account, settings and help"', ">Connect apps<", "Connect apps"]) expect(html).not.toContain(gone);
    // no All / Your turn filter and no Needs you row (round 4): a blue dot on the chat says it
    expect(html).not.toContain(">All<");
    expect(html).not.toContain(">Your turn<");
    expect(html).not.toContain("data-needs-row");
  });

  it("holds only agents and teams: no workspace header, nothing else drawn in it", () => {
    const html = render({ width: 360, collapsed: false });
    for (const gone of ["Collapse sidebar", "All chats and search", "Inbox", ">Agents<", ">Teams<", "Finish setup", "Apps, skills and mods", "Settings, memory, usage", ">Home<", "switch workspace", "No chats yet"]) expect(html).not.toContain(gone);
  });

  it("gives a row its name, the newest message under it and one dot when unread, with no count", () => {
    initial.channels = [{ id: "c1", kind: "dm", name: "dm:person:a1", unread: 3, notify: "default", starred: false, sectionId: null, last: { at: "2026-11-22T10:00:00Z", body: "My pick is Immich.", author: { kind: "agent", id: "a1" } } } as unknown as (typeof initial.channels)[number]];
    const html = render({ width: 360, collapsed: false });
    expect(html).toMatch(/href="#\/[^"]*c1"/);
    expect(html).toContain('aria-label="Iris, 3 unread"');
    expect(html).toContain(">My pick is Immich.<");
    expect(html).not.toContain(">3<");
    // collapsed: the same chat as a tile, still marked
    const rail = render({ width: 360, collapsed: true });
    expect(rail).toContain('aria-label="Iris, 3 unread"');
    expect(rail).not.toContain(">My pick is Immich.<");
  });

  it("puts one blue dot on the tile of a chat that waits on you, and none on the rest", () => {
    initial.channels = [{ id: "c1", kind: "dm", name: "dm:person:a1", unread: 0, notify: "default", starred: false, sectionId: null } as unknown as (typeof initial.channels)[number]];
    const quiet = render({ width: 360, collapsed: false });
    expect(quiet).toContain('aria-label="Iris"');
    expect(quiet).not.toContain("side-tile-dot");
    expect(quiet).not.toContain("background:#0a84ff");
    initial.approvals = { ok: { id: "ok", status: "pending", channelId: "c1", agentId: "a1", summary: "Send it?" } as (typeof initial.approvals)[string] };
    // not pinned: Iris is a chat row, with one dot on her bubble
    const row = render({ width: 360, collapsed: false });
    expect(row).toContain('aria-label="Iris, needs you"');
    expect(row).not.toContain("side-tile-dot");
    expect(row.match(/side-row-dot/g)?.length).toBe(1);
    // pinned: a tile, with exactly one dot, inside Iris's own tile
    pins.sidebar = { pins: ["a:a1"], sections: [] };
    const html = render({ width: 360, collapsed: false });
    pins.sidebar = { pins: [], sections: [] };
    expect(html).toContain('aria-label="Iris, pinned, needs you"');
    expect(html.match(/side-tile-dot/g)?.length).toBe(1);
    const tile = html.slice(html.indexOf('aria-label="Iris, pinned, needs you"'));
    expect(tile.indexOf("side-tile-dot")).toBeGreaterThan(-1);
    expect(tile.indexOf("background:#0a84ff")).toBeGreaterThan(-1);
    // the narrow rail marks it too
    expect(render({ width: 360, collapsed: true })).toContain("background:#0a84ff");
    initial.approvals = {};
  });

  it("shows only pins as tiles (round 16): an unpinned agent is a chat row, a pinned one a tile under Pinned", () => {
    initial.channels = [{ id: "c1", kind: "dm", name: "dm:person:a1", unread: 0, notify: "default", starred: false, sectionId: null } as unknown as (typeof initial.channels)[number]];
    const loose = render({ width: 360, collapsed: false });
    expect(loose).not.toContain("side-tile ");
    expect(loose).not.toContain(">Pinned<");
    expect(loose).toContain('data-tour="chat-row"');
    pins.sidebar = { pins: ["a:a1"], sections: [] };
    const pinned = render({ width: 360, collapsed: false });
    pins.sidebar = { pins: [], sections: [] };
    expect(pinned).toContain(">Pinned<");
    expect(pinned).toContain('aria-label="Iris, pinned"');
    expect(pinned).not.toContain('data-tour="chat-row"');
  });

  it("collapsed is a rail of tiles (SIDEBAR.rail wide), and every place is still reachable", () => {
    const html = render({ width: 360, collapsed: true });
    expect(html).toContain(`width:${SIDEBAR.rail}px`);
    expect(html).not.toContain(">Iris<");
    // + at the top, the agent column, and your initials at the foot, which open a menu of the five places
    for (const place of ["New agent, team or chat", "Iris", "Your profile, settings and places"]) expect(html).toContain(`aria-label="${place}`);
    expect(html).toContain('aria-haspopup="menu"');
    // the full sidebar has no such menu button: the places sit in its foot instead
    expect(render({ width: 360, collapsed: false })).not.toContain("Your profile, settings and places");
  });

  it("starts at the default width with nothing saved", () => expect(render(null)).toContain(`width:${SIDEBAR.default}px`));
});
