import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Approval, Message } from "@warren/core";
import { api } from "./api.ts";
import { useStore, type DiscussionInfo, type LiveRun } from "./store.ts";

vi.mock("./api.ts", () => ({ api: vi.fn() }));
vi.mock("./notifications.ts", () => ({ notifyOn: vi.fn() }));
vi.mock("./components/ui.tsx", () => ({ agentColor: () => "" }));
vi.mock("./orgs.ts", () => ({ listOrgs: async () => [] }));

const initial = useStore.getState();
const message = (id: string, threadId: string | null = null) => ({ id, channelId: "channel", threadId, body: id } as Message);
const run: LiveRun = { runId: "run", agentId: "agent", channelId: "channel", threadId: null, threadPath: [], text: "", tools: [], last: null, usedComputer: false };
const event = (event: AgentEvent) => useStore.getState().handle({ type: "run_event", runId: "run", agentId: "agent", channelId: "channel", event }, false);

beforeEach(() => { vi.mocked(api).mockReset(); });
afterEach(() => useStore.setState(initial, true));

describe("thread loading", () => {
  it("caches a returned root outside the channel cache and keeps only replies in the thread", async () => {
    const root = message("root", "outer");
    const reply = message("reply", "root");
    vi.mocked(api).mockResolvedValue({ messages: [root, reply], replyCounts: { root: 1 } });
    await useStore.getState().loadThread("channel", "root");
    expect(useStore.getState().roots.root).toEqual(root);
    expect(useStore.getState().threads.root).toEqual([reply]);
    expect(useStore.getState().messages.channel).toBeUndefined();
    expect(useStore.getState().replyCounts.root).toBe(1);
  });
});

describe("reconnect", () => {
  it("refreshes loaded collections and empty threads, replaces stale secondary data, and clears live runs", async () => {
    const approval = { id: "approval", status: "approved" } as Approval;
    const discussion = { id: "discussion", status: "done", progress: [] } as unknown as DiscussionInfo;
    vi.mocked(api).mockImplementation(async (_method, path) => {
      if (path.includes("/messages?")) return { messages: [], replyCounts: {} };
      if (path === "/api/approvals") return [approval];
      if (path === "/api/discussions") return [discussion];
      if (path === "/api/me" || path === "/api/settings/lead") return null;
      return [];
    });
    await useStore.getState().loadThread("channel", "empty-root");
    useStore.setState({
      activeChannel: "channel", live: { run }, sections: [{ id: "stale" }] as never,
      approvals: { approval: { ...approval, status: "pending" }, removed: { id: "removed" } as Approval },
      discussions: { discussion: { ...discussion, status: "running" } },
    });
    vi.mocked(api).mockClear();
    useStore.getState().setConnected(true);
    await vi.waitFor(() => expect(useStore.getState().discussions.discussion.status).toBe("done"));
    const paths = vi.mocked(api).mock.calls.map((call) => call[1]);
    for (const path of ["/api/channels/channel/messages?limit=100", "/api/channels/channel/messages?thread=empty-root&limit=200", "/api/agents", "/api/channels", "/api/sections", "/api/computers", "/api/settings/lead", "/api/me", "/api/members", "/api/approvals", "/api/discussions"])
      expect(paths).toContain(path);
    expect(useStore.getState().approvals).toEqual({ approval });
    expect(useStore.getState().sections).toEqual([]);
    expect(useStore.getState().live).toEqual({});
    for (const key of ["routinesVersion", "backgroundVersion", "changesVersion", "tasksVersion", "memoryVersion"] as const)
      expect(useStore.getState()[key]).toBe(initial[key] + 1);
    vi.mocked(api).mockClear();
    useStore.getState().setConnected(true);
    expect(api).not.toHaveBeenCalled();
    useStore.getState().setConnected(false);
    expect(api).not.toHaveBeenCalled();
  });

  it("tolerates failed reconnect refreshes", async () => {
    vi.mocked(api).mockRejectedValue(new Error("offline"));
    useStore.setState({ activeChannel: "channel", threadChannels: { root: "channel" }, live: { run } });
    useStore.getState().setConnected(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().live).toEqual({});
  });
});

describe("live events", () => {
  it.each([
    [{ type: "status", text: "Thinking" }, "Thinking"],
    [{ type: "notice", text: "Connection unavailable" }, "Connection unavailable"],
    [{ type: "error", message: "Run failed" }, "Error: Run failed"],
    [{ type: "tool_result", name: "read", output: { found: true } }, 'read: {"found":true}'],
    [{ type: "tool_result", name: "read", output: "Contents" }, "read: Contents"],
    [{ type: "usage", model: "model", contextUsed: 10, contextWindow: 100, inputTokens: 20, outputTokens: 5, cachedInputTokens: 2, effort: "high" }, "Usage:"],
  ] as [AgentEvent, string][])("makes %j visible through the existing text renderer", (ev, expected) => {
    event(ev);
    expect(useStore.getState().live.run.text).toContain(expected);
  });

  it("preserves text deltas, tool calls and computer activity alongside other events", () => {
    event({ type: "text", text: "Hello" });
    event({ type: "text", text: " world" });
    event({ type: "tool_call", name: "computer_click", input: { x: 1 } });
    event({ type: "notice", text: "Still working" });
    event({ type: "text", text: "More" });
    expect(useStore.getState().live.run).toMatchObject({ text: "Hello world\nStill working\nMore", tools: ["computer_click"], last: { name: "computer_click", input: { x: 1 } }, usedComputer: true });
  });
});
