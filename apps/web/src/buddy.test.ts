import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@wisp/core";
import { buddyNotice, buddyNoticeWithRoot } from "./buddy.ts";

const state = {
  me: { user: { id: "person" } }, channels: [{ id: "team", kind: "channel", joined: true, notify: "default" }],
  messages: {}, roots: {}, approvals: {},
} as unknown as Parameters<typeof buddyNotice>[1];
const message = (patch: Partial<Message> = {}): Message => ({ id: "reply", channelId: "team", threadId: "root", author: { kind: "agent", id: "other" }, body: "Done", parts: [], hop: 0, createdAt: "2026-10-23T12:00:00Z", ...patch });
const root = message({ id: "root", threadId: null, author: { kind: "user", id: "person" }, createdAt: "2026-10-21T12:00:00Z" });
afterEach(() => vi.unstubAllGlobals());

describe("buddy thread notifications", () => {
  it("loads a missing root so replies from other agents reach the person who started the thread", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ messages: [root] })));
    vi.stubGlobal("fetch", fetch);
    const notice = await buddyNoticeWithRoot({ type: "message", message: message() }, state, "lead");
    expect(notice).toMatchObject({ agentId: "other", text: "Done", route: "#/c/team/t/root" });
    expect(fetch.mock.calls[0][0]).toBe("/api/channels/team/messages?thread=root&limit=200");
  });

  it("pages past a busy thread and uses the store's root cache when available", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: Array.from({ length: 200 }, (_, i) => message({ id: `reply-${i}` })) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [root] })));
    vi.stubGlobal("fetch", fetch);
    expect(await buddyNoticeWithRoot({ type: "message", message: message() }, state, "lead")).not.toBeNull();
    expect(fetch.mock.calls[1][0]).toContain("before=2026-10-23T12%3A00%3A00Z");
    fetch.mockClear();
    expect(await buddyNoticeWithRoot({ type: "message", message: message() }, { ...state, roots: { root } }, "lead")).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses muted DMs and selected-agent replies before fetching history", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const kind of ["dm", "channel"] as const) {
      const muted = { ...state, channels: [{ ...state.channels[0], kind, notify: "mute" as const }] };
      expect(await buddyNoticeWithRoot({ type: "message", message: message() }, muted, "other")).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
