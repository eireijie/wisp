import { describe, expect, it } from "vitest";
import type { Message } from "@wisp/core";
import { chatName, startsChat } from "./chatFormat.ts";

const msg = (id: string, conversationId?: string): Message => ({ id, channelId: "c", threadId: null, author: { kind: "user", id: "u" }, body: "", parts: [], hop: 0, createdAt: "2026-11-01T09:00:00Z", ...(conversationId ? { conversationId } : {}) });

describe("startsChat", () => {
  it("marks the first message of a chat", () => {
    expect(startsChat(undefined, msg("a", "a"))).toBe(true);
    expect(startsChat(msg("a", "a"), msg("b", "b"))).toBe(true);
  });

  it("not inside a chat, nor at the top of a page that begins mid-chat", () => {
    expect(startsChat(msg("a", "a"), msg("b", "a"))).toBe(false);
    expect(startsChat(undefined, msg("b", "a"))).toBe(false);
  });

  it("never for threads or messages from an older hub", () => {
    expect(startsChat(msg("a"), msg("b"))).toBe(false);
    expect(startsChat(msg("a"), msg("b", "b"))).toBe(false);
  });
});

describe("chatName", () => {
  const time = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  it("names today's, yesterday's and older chats", () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 14);
    expect(chatName(today.toISOString(), time)).toBe("the 9:14 chat");
    const yesterday = new Date(today.getTime() - 86_400_000);
    expect(chatName(yesterday.toISOString(), time)).toBe("yesterday's 9:14 chat");
    const old = new Date(today.getTime() - 10 * 86_400_000);
    expect(chatName(old.toISOString(), time)).toMatch(/^the .+ chat$/);
  });
});
