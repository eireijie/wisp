import { describe, expect, it } from "vitest";
import { CONVERSATION_GAP_MS, conversationFor, splitConversations } from "../src/conversations.ts";

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 9, 0) + min * 60_000).toISOString();

describe("conversationFor", () => {
  it("starts a chat when there's nothing before", () => {
    expect(conversationFor(undefined, { id: "m1", createdAt: at(0) })).toBe("m1");
  });

  it("keeps the chat going while it isn't quiet", () => {
    expect(conversationFor({ id: "m1", createdAt: at(0), authorId: "u", conversationId: "m1" }, { id: "m2", createdAt: at(149) })).toBe("m1");
  });

  it("starts a new chat after the quiet break", () => {
    expect(CONVERSATION_GAP_MS).toBe(150 * 60_000);
    expect(conversationFor({ id: "m1", createdAt: at(0), authorId: "u", conversationId: "m1" }, { id: "m2", createdAt: at(150) })).toBe("m2");
  });

  it("uses the latest message's own id when it has no chat yet", () => {
    expect(conversationFor({ id: "m1", createdAt: at(0), authorId: "u" }, { id: "m2", createdAt: at(5) })).toBe("m1");
  });
});

describe("splitConversations", () => {
  it("splits at each quiet break, measured from the last message, not the chat's start", () => {
    const ids = splitConversations([
      { id: "a", createdAt: at(0), authorId: "u" },
      { id: "b", createdAt: at(100), authorId: "agent" },
      { id: "c", createdAt: at(200), authorId: "u" },
      { id: "d", createdAt: at(400), authorId: "u" },
    ]);
    expect([...ids.values()]).toEqual(["a", "a", "a", "d"]);
  });

  it("doesn't let Wisp's notices start or extend a chat", () => {
    const ids = splitConversations([
      { id: "a", createdAt: at(0), authorId: "u" },
      { id: "s", createdAt: at(140), authorId: "system" },
      { id: "b", createdAt: at(200), authorId: "u" },
      { id: "s2", createdAt: at(210), authorId: "system" },
    ]);
    expect(Object.fromEntries(ids)).toEqual({ a: "a", s: "a", b: "b", s2: "b" });
  });

  it("gives a notice before anyone wrote its own chat", () => {
    expect(Object.fromEntries(splitConversations([{ id: "s", createdAt: at(0), authorId: "system" }]))).toEqual({ s: "s" });
  });
});
