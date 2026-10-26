import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent, Message } from "@wisp/core";
import { VoiceCall } from "../src/voice/call.ts";
import { spokenReply, isSpeechEcho, voiceIndex } from "../src/voice/text.ts";
import type { ListenCallbacks } from "../src/voice/providers.ts";
import { href, parseRoute } from "../src/router.ts";

afterEach(() => vi.useRealTimers());
function fixture(messages: Message[] = [], refresh?: () => Promise<void>) {
  vi.useFakeTimers();
  let cb!: ListenCallbacks;
  const listener = { start: vi.fn(async () => {}), stop: vi.fn() };
  let finish = () => {};
  const speaker = { speak: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), cancel: vi.fn(() => finish()) };
  const send = vi.fn(async (_text: string) => {}), update = vi.fn();
  const call = new VoiceCall({ agentId: "ghost", channelId: "dm", cloudListening: false, listener: (callbacks) => { cb = callbacks; return listener; }, speaker, send, update, messages: () => messages, refresh });
  return { call, listener, speaker, send, update, cb, messages };
}
const reply = (id = "reply", body = "Hello there. How can I help?\n\nFull details."): ClientEvent => ({ type: "message", message: { id, channelId: "dm", threadId: null, author: { kind: "agent", id: "ghost" }, body, parts: [], hop: 1, createdAt: new Date().toISOString() } });

describe("spoken excerpts", () => {
  it("skips code, tables and links and reads at most two sentences from the first prose paragraph", () => {
    expect(spokenReply('```ts\nconsole.log("no")\n```\n\n| A | B |\n|---|---|\n\n**Done.** All ready! Third sentence.\n\nAnother paragraph.')).toBe("Done. All ready!");
    expect(spokenReply('See [the link](https://example.com) and https://example.com.\n\nDetails')).not.toContain("http");
    expect(spokenReply('~~~python\nprint("secret")')).toBe("");
    expect(spokenReply("word ".repeat(200)).length).toBeLessThanOrEqual(480);
  });
  it("recognizes speaker echo without suppressing new words", () => {
    expect(isSpeechEcho("Hello, there", "Hello there. How can I help?")).toBe(true);
    expect(isSpeechEcho("Wait, change the title", "Hello there.")).toBe(false);
    expect(voiceIndex("atlas", 10)).toBe(voiceIndex("atlas", 10));
  });
});

describe("call lifecycle", () => {
  it("offers help after four seconds without starting the call clock, then accepts permission", async () => {
    const { call, listener } = fixture();
    let allow!: () => void;
    listener.start.mockImplementationOnce(() => new Promise<void>((resolve) => { allow = resolve; }));
    const starting = call.start();
    await vi.advanceTimersByTimeAsync(3999);
    expect(call.state).toMatchObject({ ready: false, needsMic: false, startedAt: null });
    await vi.advanceTimersByTimeAsync(1);
    expect(call.state).toMatchObject({ ready: false, needsMic: true, startedAt: null });
    allow(); await starting;
    expect(call.state).toMatchObject({ ready: true, needsMic: false, startedAt: Date.now() });
    const startedAt = call.state.startedAt;
    await call.mute(true); await vi.advanceTimersByTimeAsync(1000); await call.mute(false);
    expect(call.state.startedAt).toBe(startedAt);
    call.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retries stalled capture and ignores permission arriving from the old attempt", async () => {
    const { call, listener } = fixture();
    let first!: () => void, second!: () => void;
    listener.start.mockImplementationOnce(() => new Promise<void>((resolve) => { first = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { second = resolve; }));
    const starting = call.start();
    await vi.advanceTimersByTimeAsync(4000);
    const retry = call.start();
    expect(listener.stop).toHaveBeenCalledOnce();
    first(); await starting;
    expect(call.state).toMatchObject({ ready: false, needsMic: false, startedAt: null });
    await vi.advanceTimersByTimeAsync(4000);
    expect(call.state.needsMic).toBe(true);
    call.stop(); second(); await retry;
    expect(call.state.ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("offers the same retry state immediately on denied microphone access", async () => {
    const { call, listener } = fixture();
    listener.start.mockRejectedValueOnce(new Error("Microphone access was denied."));
    await call.start();
    expect(call.state).toMatchObject({ ready: false, needsMic: true, startedAt: null, error: "Microphone access was denied." });
    expect(vi.getTimerCount()).toBe(0);
    await call.start();
    expect(call.state).toMatchObject({ ready: true, needsMic: false, error: "" });
    call.stop();
  });
  it("sends complete turns once, speaks only fresh replies from this DM, and keeps listening", async () => {
    const { call, cb, send, listener, speaker } = fixture();
    await call.start();
    call.event(reply("old"));
    expect(speaker.speak).not.toHaveBeenCalled();
    cb.partial("Hello"); cb.final("Hello there");
    expect(send).toHaveBeenCalledExactlyOnceWith("Hello there");
    const other = reply();
    if (other.type === "message") other.message.threadId = "thread";
    call.event(other);
    expect(speaker.speak).not.toHaveBeenCalled();
    call.event(reply()); call.event(reply());
    expect(speaker.speak).toHaveBeenCalledTimes(1);
    expect(speaker.speak.mock.calls[0][0]).toBe("Hello there. How can I help?");
    expect(listener.stop).not.toHaveBeenCalled();
    expect(call.state.waiting).toBe(false);
    call.stop();
  });
  it("cuts off speech on a real interruption, but filters its own echo", async () => {
    const { call, cb, speaker, send } = fixture();
    await call.start(); cb.final("Hi"); call.event(reply());
    const cancels = speaker.cancel.mock.calls.length;
    cb.partial("Hello there"); cb.final("Hello there");
    expect(speaker.cancel).toHaveBeenCalledTimes(cancels);
    expect(send).toHaveBeenCalledTimes(1);
    cb.partial("Wait, change the title");
    expect(speaker.cancel).toHaveBeenCalledTimes(cancels + 1);
    expect(call.state.speaking).toBe(false);
    cb.final("Wait, change the title");
    expect(send).toHaveBeenCalledTimes(2);
    call.stop();
  });
  it("mutes capture and ignores late callbacks; hang-up clears timers and output", async () => {
    const { call, cb, send, listener, speaker, update } = fixture();
    await call.start(); cb.final("Do some work");
    await call.mute(true);
    cb.partial("private"); cb.final("private");
    expect(send).toHaveBeenCalledTimes(1);
    expect(listener.stop).toHaveBeenCalledTimes(1);
    await call.mute(false);
    expect(listener.start).toHaveBeenCalledTimes(2);
    call.stop(); const updates = update.mock.calls.length;
    cb.final("late"); call.event(reply());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(updates);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("fills once and offers a callback after twenty seconds without ending the agent's work", async () => {
    const { call, cb, speaker } = fixture();
    await call.start(); cb.final("Work");
    await vi.advanceTimersByTimeAsync(2500);
    expect(speaker.speak.mock.calls[0][0]).toBe("On it…");
    await vi.advanceTimersByTimeAsync(17_500);
    expect(speaker.speak.mock.calls[1][0]).toContain("ping you");
    expect(call.state.longWork).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(speaker.speak).toHaveBeenCalledTimes(2);
    call.stop();
  });
  it("surfaces send and recognition failures and allows retry", async () => {
    const { call, cb, listener, send } = fixture();
    listener.start.mockImplementationOnce(async () => cb.error("Denied"));
    await call.start(); expect(call.state.ready).toBe(false);
    await call.start(); expect(call.state.ready).toBe(true);
    send.mockRejectedValueOnce(new Error("Offline"));
    cb.final("Work"); await Promise.resolve();
    expect(call.state.error).toContain("Offline");
    expect(call.state.waiting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    call.stop();
  });
  it("reconciles replies received while disconnected, speaks only the newest and clears stale pending turns", async () => {
    const old = reply("old");
    if (old.type !== "message") throw new Error("Expected message");
    const { call, cb, speaker, messages } = fixture([old.message]);
    await call.start();
    cb.final("First task"); cb.final("Second task");
    call.disconnect();
    const person: Message = { ...old.message, id: "person", author: { kind: "user", id: "me" }, body: "Second task" };
    const first = reply("first", "First answer.");
    const newest = reply("newest", "Newest answer.");
    if (first.type !== "message" || newest.type !== "message") throw new Error("Expected messages");
    messages.push(person, first.message, newest.message);
    call.event(first); call.event(newest);
    expect(speaker.speak).not.toHaveBeenCalled();
    await call.start();
    expect(speaker.speak).toHaveBeenCalledExactlyOnceWith("Newest answer.", expect.any(Function));
    expect(call.state.waiting).toBe(false);
    call.event(newest);
    expect(speaker.speak).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.state.longWork).toBe(false);
    call.stop();
  });

  it("settles coalesced turns when the agent answered after the last person, keeping later turns outstanding", async () => {
    const { call, cb, messages, speaker } = fixture();
    await call.start();
    cb.final("First"); cb.final("Second");
    call.disconnect();
    const answer = reply("answer", "Both done.");
    if (answer.type !== "message") throw new Error("Expected message");
    messages.push({ ...answer.message, id: "person", author: { kind: "user", id: "me" } }, answer.message);
    await call.start();
    expect(call.state.waiting).toBe(false);
    expect(speaker.speak).toHaveBeenCalledTimes(1);
    cb.final("Another task");
    messages.push({ ...answer.message, id: "later-person", author: { kind: "user", id: "me" } });
    call.disconnect();
    await call.start();
    expect(call.state.waiting).toBe(true);
    expect(speaker.speak).toHaveBeenCalledTimes(1);
    call.event(reply("later-answer"));
    expect(call.state.waiting).toBe(false);
    call.stop();
  });

  it("waits for reconnect history before restarting capture and reconciling", async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { call, cb, messages, speaker, listener } = fixture([], refresh);
    await call.start(); cb.final("Work"); call.disconnect();
    const starting = call.start();
    expect(refresh).toHaveBeenCalledOnce();
    expect(listener.start).toHaveBeenCalledOnce();
    const answer = reply("answer", "Finished while away.");
    if (answer.type !== "message") throw new Error("Expected message");
    messages.push(answer.message);
    finish(); await starting;
    expect(listener.start).toHaveBeenCalledTimes(2);
    expect(call.state.waiting).toBe(false);
    expect(speaker.speak).toHaveBeenCalledExactlyOnceWith("Finished while away.", expect.any(Function));
    call.stop();
  });

  it("clears coalesced pending turns even when the last agent reply was already seen", async () => {
    const { call, cb, messages } = fixture();
    await call.start(); cb.final("First"); cb.final("Second");
    const answer = reply("answer");
    if (answer.type !== "message") throw new Error("Expected message");
    messages.push({ ...answer.message, id: "person", author: { kind: "user", id: "me" } }, answer.message);
    call.event(answer);
    expect(call.state.waiting).toBe(true);
    call.disconnect(); await call.start();
    expect(call.state.waiting).toBe(false);
    call.stop();
  });

  it("pauses capture on connection loss", async () => {
    const { call, listener, speaker } = fixture();
    await call.start(); call.disconnect();
    expect(listener.stop).toHaveBeenCalled(); expect(speaker.cancel).toHaveBeenCalled();
    expect(call.state.ready).toBe(false);
    call.stop();
  });
});

it("opens a buddy call in the existing chat route", () => {
  const route = { view: "chat" as const, channelId: "dm", threadId: null, call: true };
  expect(parseRoute(href(route))).toEqual(route);
  expect(parseRoute("#/settings/voice")).toEqual({ view: "settings", page: "voice" });
});

describe("live call state", () => {
  const run = (event: unknown): ClientEvent => ({ type: "run_event", runId: "r1", agentId: "ghost", channelId: "dm", event } as ClientEvent);
  it("speaks the first sentence while the agent is still working, then only the rest", async () => {
    const { call, speaker, cb } = fixture();
    await call.start();
    cb.final("what is in main");
    expect(call.state.phase).toBe("thinking");
    call.event(run({ type: "tool_call", name: "Read", input: { file_path: "/a/b/main.ts" } }));
    expect(call.state).toMatchObject({ phase: "working", activity: "Reading main.ts" });
    call.event(run({ type: "text", text: "It exports one function. And" }));
    expect(speaker.speak).toHaveBeenCalledWith("It exports one function.", expect.any(Function));
    expect(call.state.phase).toBe("speaking");
    call.event(reply("done", "It exports one function. And it is small.\n\nMore."));
    await vi.advanceTimersByTimeAsync(0);
    expect(speaker.speak).toHaveBeenLastCalledWith("And it is small.", expect.any(Function));
    call.stop();
  });
  it("reports error as its own phase", async () => {
    const { call, cb } = fixture();
    await call.start();
    expect(call.state.phase).toBe("listening");
    cb.error("nope");
    expect(call.state.phase).toBe("error");
    call.stop();
  });
});
