import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore, type ChannelInfo, type Me } from "../src/store.ts";
import { ChatList } from "../src/components/ChatList.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const initial = useStore.getInitialState();
const saved = { me: initial.me, channels: initial.channels, sections: initial.sections, agents: initial.agents };
afterEach(() => Object.assign(initial, saved));

const me = { kind: "user", role: "owner", user: { id: "u1", name: "Yug Patel", email: "yug@example.com", createdAt: "now" }, workspace: { id: "w", name: "Meadows" }, prefs: { sendWith: "enter", clock: "auto", toolCalls: "collapsed", experience: "advanced" } } as unknown as Me;
const agent = (id: string, name: string) => ({ id, handle: name.toLowerCase(), name, harness: "codex", model: null, nodeId: null, computerId: null, settings: {}, status: "online", createdAt: "2026-01-01T00:00:00Z", workspaceId: "w" }) as never;
const channel = (over: Partial<ChannelInfo>): ChannelInfo =>
  ({ id: "c", workspaceId: "w", name: "x", kind: "channel", topic: "", sectionId: null, private: false, archivedAt: null, settings: { defaultAgentId: null, replyInThread: true, instructions: "", team: null }, createdAt: "2026-01-01T00:00:00Z", joined: true, memberCount: 1, unread: 0, lastReadAt: null, notify: "default", starred: false, pinnedIds: [], last: null, ...over }) as ChannelInfo;

function render() {
  return renderToStaticMarkup(createElement(ChatList, { route: { view: "chats" } }));
}

describe("chats list", () => {
  it("is one flat list of agents and teams, newest first, with pinned chats on top and sections below", () => {
    Object.assign(initial, {
      me,
      agents: [agent("a1", "Ghosty"), agent("a2", "Nova")],
      sections: [{ id: "s1", name: "Launch", emoji: "", position: 0 }],
      channels: [
        channel({ id: "dm1", name: "dm:u1:a1", kind: "dm", last: { at: "2026-10-23T10:00:00Z", body: "older", author: { kind: "agent", id: "a1" } } }),
        channel({ id: "t1", name: "release-crew", last: { at: "2026-10-24T10:00:00Z", body: "newer", author: { kind: "user", id: "u1" } } }),
        channel({ id: "t2", name: "general", starred: true, last: { at: "2026-10-01T10:00:00Z", body: "pinned and old", author: { kind: "user", id: "u1" } } }),
        channel({ id: "t3", name: "launch-crew", sectionId: "s1", last: { at: "2026-10-22T10:00:00Z", body: "filed away", author: { kind: "user", id: "u1" } } }),
      ],
    });
    const html = render();
    const at = (s: string) => html.indexOf(s);
    // pinned first, then by recency
    expect(at("general")).toBeLessThan(at("release-crew"));
    expect(at("release-crew")).toBeLessThan(at("Ghosty"));
    // an agent with no chat yet still has a row, after the ones with messages
    expect(at("Ghosty")).toBeLessThan(at("Nova"));
    // sections follow the main list
    expect(at("Nova")).toBeLessThan(at("Launch"));
    expect(at("Launch")).toBeLessThan(at("launch-crew"));
    // previews say who spoke in a team, and "You" for you
    expect(html).toContain("You: newer");
    expect(html).toContain("older");
    // the + menu is there, and nothing says Channels or Starred
    expect(html).toContain("New chat, agent or team");
    expect(html).not.toMatch(/Channels|Starred/);
  });
});
