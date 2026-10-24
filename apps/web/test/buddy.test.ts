import { describe, expect, it, vi } from "vitest";
import type { Approval, Message } from "@wisp/core";
import { buddyNotice, completedTasks, firstLine, unlessMuted, type BuddyTask } from "../src/buddy.ts";
import { href, parseRoute } from "../src/router.ts";
import { connectEvents } from "../src/api.ts";

const state = {
  me: { user: { id: "person" } },
  channels: [{ id: "dm", kind: "dm", joined: true }, { id: "team", kind: "channel", joined: true }],
  messages: {}, approvals: {},
} as unknown as Parameters<typeof buddyNotice>[1];
const message = (patch: Partial<Message> = {}): Message => ({ id: "m", channelId: "dm", threadId: null, author: { kind: "agent", id: "other" }, body: "Your report is ready.\nMore details", parts: [], hop: 0, createdAt: "", ...patch });

describe("desk buddy events", () => {
  it("doesn't reopen a disposed event stream after a disconnect", () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    class Socket {
      onclose?: () => void;
      constructor() { sockets.push(this); }
      close() { this.onclose?.(); }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("location", { protocol: "http:", host: "hub" });
    try {
      const dispose = connectEvents(() => {}, () => {});
      sockets[0].close();
      dispose();
      vi.runAllTimers();
      expect(sockets).toHaveLength(1);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it("has a dedicated route and keeps bubbles to a short first line", () => {
    expect(parseRoute(href({ view: "buddy" }))).toEqual({ view: "buddy" });
    expect(firstLine("\n Hello\r\nthere")).toBe("Hello");
    expect(firstLine("x".repeat(100))).toHaveLength(80);
  });

  it("attributes another agent's DM and opens the right thread", () => {
    expect(buddyNotice({ type: "message", message: message({ threadId: "thread" }) }, state, "lead"))
      .toMatchObject({ agentId: "other", text: "Your report is ready.", route: "#/c/dm/t/thread", mood: "done" });
    expect(buddyNotice({ type: "message", message: message({ author: { kind: "user", id: "person" } }) }, state)).toBeNull();
  });

  it("ignores unrelated agent chatter and surfaces the selected agent's work", () => {
    const e = { type: "message" as const, message: message({ channelId: "team" }) };
    expect(buddyNotice(e, state, "lead")).toBeNull();
    expect(buddyNotice(e, state, "other")?.route).toBe("#/c/team");
  });

  it("shows pending approvals once and doesn't replace them with their message", () => {
    const approval = { id: "ok", channelId: "dm", threadId: "thread", agentId: "other", status: "pending", summary: "Send the draft?" } as Approval;
    expect(buddyNotice({ type: "approval", approval }, state))
      .toMatchObject({ mood: "waiting", route: "#/c/dm/t/thread", text: "Send the draft?" });
    expect(buddyNotice({ type: "approval", approval }, { ...state, approvals: { ok: approval } })).toBeNull();
    expect(buddyNotice({ type: "approval", approval: { ...approval, status: "approved" } }, state)).toBeNull();
    expect(buddyNotice({ type: "message", message: message({ parts: [{ type: "approval", approvalId: "ok" }] }) }, state)).toBeNull();
  });

  it("only announces new completions of the person's tasks", () => {
    const task: BuddyTask = { id: "task", title: "Report", status: "running", from: { kind: "user", id: "person" }, toAgentId: "other", channelId: "dm", threadId: "thread", result: null };
    const previous = new Map<string, string>();
    expect(completedTasks([{ ...task, status: "done" }], previous, "person")).toEqual([]);
    completedTasks([task], previous, "person");
    expect(completedTasks([{ ...task, status: "done" }], previous, "person")).toMatchObject([{ mood: "done", route: "#/c/dm/t/thread", text: "Finished: Report" }]);
    expect(completedTasks([{ ...task, status: "done" }], previous, "person")).toEqual([]);
    completedTasks([task], previous, "person");
    expect(completedTasks([{ ...task, status: "done", from: { kind: "user", id: "someone-else" } }], previous, "person")).toEqual([]);
  });
  it("follows muting and unmuting after the buddy loaded its channels", async () => {
    const e = { type: "message", message: message() } as const;
    const n = buddyNotice(e, state);
    expect(n).not.toBeNull();
    // muted elsewhere after the buddy loaded the channel
    expect(await unlessMuted(n, e, async () => [{ id: "dm", notify: "mute" }])).toBeNull();
    // unmuted again: the buddy's own copy still says muted, which must not stop the fresh check
    const stale = { ...state, channels: [{ id: "dm", kind: "dm", joined: true, notify: "mute" }] } as unknown as typeof state;
    expect(buddyNotice(e, stale)).toBeNull();
    const ignoring = buddyNotice(e, stale, undefined, { ignoreMute: true });
    expect(await unlessMuted(ignoring, e, async () => [{ id: "dm", notify: "all" }])).toEqual(n);
    // the hub is unreachable for a moment: still say something arrived
    expect(await unlessMuted(n, e, async () => { throw new Error("offline"); })).toEqual(n);
  });
});
