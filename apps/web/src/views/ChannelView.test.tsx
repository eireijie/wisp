import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@wisp/core";
import { ChannelView } from "./ChannelView.tsx";

const h = vi.hoisted(() => ({
  state: {} as any, refs: [] as { current: any }[], index: 0,
  effects: [] as (() => any)[], layouts: [] as (() => any)[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (fn: () => any) => { h.effects.push(fn); },
  useLayoutEffect: (fn: () => any) => { h.layouts.push(fn); },
  useMemo: (fn: () => any) => fn(),
  useRef: (value: any) => h.refs[h.index++] ?? (h.refs[h.index - 1] = { current: value }),
  useState: (value: any) => [typeof value === "function" ? value() : value, vi.fn()],
}));
vi.mock("../store.ts", () => ({
  useStore: Object.assign((select: (s: any) => any) => select(h.state), { getState: () => h.state }),
  conversationKey: (channelId: string, threadId?: string) => threadId ? `${channelId}/t/${threadId}` : channelId,
  useNames: () => ({ agent: () => undefined }),
}));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
vi.mock("../features.ts", () => ({ useFeature: () => false }));

const message = (id: string) => ({ id, body: id, createdAt: "2026-01-01", author: { kind: "user", id: "me" } }) as Message;
function find(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (match(node)) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, match)).find(Boolean);
}
function component(threadId: string | null = null, messageId?: string) {
  const tree = ChannelView({ route: { view: "chat", channelId: "channel", threadId, messageId } });
  const element = find(tree, (node) => node.type?.name === (threadId ? "ThreadPanel" : "MessageList"));
  h.refs = [];
  return () => {
    h.index = 0; h.effects = []; h.layouts = [];
    return element.type(element.props);
  };
}
function viewport() {
  return { scrollHeight: 1000, scrollTop: 200, querySelectorAll: vi.fn(() => [] as any[]) };
}
beforeEach(() => {
  vi.useFakeTimers();
  h.refs = []; h.index = 0; h.effects = []; h.layouts = [];
  h.state = {
    channels: [{ id: "channel", name: "general", kind: "channel", settings: {}, pinnedIds: [] }],
    messages: { channel: [message("latest")] }, threads: {}, roots: {}, removedRoots: {}, live: {}, replyCounts: {},
    hasEarlier: { channel: true }, loadingMessages: {}, loadErrors: {},
    loadEarlier: vi.fn(async () => {}), loadChannel: vi.fn(async () => {}), loadThread: vi.fn(async () => {}),
  };
});
afterEach(() => vi.useRealTimers());

describe("conversation history controls", () => {
  it("preserves the visible scroll position when older messages are prepended", async () => {
    const render = component();
    let tree = render();
    const el = viewport(); h.refs[0].current = el;
    h.layouts.forEach((layout) => layout());
    el.scrollTop = 200;
    h.state.loadEarlier.mockImplementation(async () => { h.state.messages.channel = [message("older"), ...h.state.messages.channel]; });
    const control = find(tree, (node) => node.type === "button" && node.props.children === "Show earlier messages");
    control.props.onClick();
    await Promise.resolve();
    expect(h.state.loadEarlier).toHaveBeenCalledWith("channel", undefined);
    el.scrollHeight = 1300;
    tree = render();
    h.layouts.forEach((layout) => layout());
    expect(el.scrollTop).toBe(500);
  });

  it("loads earlier pages for a selected message and briefly highlights it", async () => {
    const render = component(null, "target");
    render();
    const el = viewport(); h.refs[0].current = el;
    const row = { dataset: { messageId: "target" }, scrollIntoView: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } };
    h.state.loadEarlier.mockImplementation(async () => { h.state.messages.channel = [message("target"), ...h.state.messages.channel]; });
    h.effects[0]();
    await Promise.resolve();
    expect(h.state.loadEarlier).toHaveBeenCalledOnce();
    el.querySelectorAll.mockReturnValue([row]);
    render(); h.layouts.forEach((layout) => layout()); h.effects[0]();
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(row.classList.add).toHaveBeenCalledWith("bg-accent-soft");
    await vi.advanceTimersByTimeAsync(2000);
    expect(row.classList.remove).toHaveBeenCalledWith("bg-accent-soft");
    render(); h.effects[0]();
    expect(h.state.loadEarlier).toHaveBeenCalledOnce();
  });

  it("caps automatic history searches at ten pages", async () => {
    const render = component(null, "missing");
    render(); h.refs[0].current = viewport();
    h.state.loadEarlier.mockImplementation(async () => { h.state.messages.channel = [message(`older${h.state.loadEarlier.mock.calls.length}`), ...h.state.messages.channel]; });
    for (let i = 0; i < 12; i++) {
      render(); h.layouts.forEach((layout) => layout()); h.effects[0]();
      await Promise.resolve();
    }
    expect(h.state.loadEarlier).toHaveBeenCalledTimes(10);
  });

  it.each([null, "thread"])("shows an initial load error and retries its conversation (%s)", (threadId) => {
    h.state.messages = {}; h.state.hasEarlier = {};
    h.state.loadErrors[threadId ? "channel/t/thread" : "channel"] = { message: "Offline", earlier: false };
    const render = component(threadId);
    const tree = render();
    expect(find(tree, (node) => node.props?.role === "alert")).toBeTruthy();
    const retry = find(tree, (node) => node.type === "button" && node.props.children === "Try again");
    retry.props.onClick();
    if (threadId) expect(h.state.loadThread).toHaveBeenCalledWith("channel", "thread");
    else expect(h.state.loadChannel).toHaveBeenCalledWith("channel");
  });

  it("marks a deleted thread root and removes its composer", () => {
    h.state.roots.thread = message("thread"); h.state.removedRoots.thread = true;
    const tree = component("thread")();
    expect(find(tree, (node) => node.props?.role === "status")?.props.children).toBe("This message was deleted.");
    expect(find(tree, (node) => node.type?.name === "Composer")).toBeUndefined();
  });
});
