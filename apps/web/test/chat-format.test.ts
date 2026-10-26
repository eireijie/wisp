import { describe, expect, it } from "vitest";
import type { Message } from "@wisp/core";
import { isGrouped, needsStamp, snippetOf, stampLabel, toolLine } from "../src/chatFormat.ts";

const msg = (over: Partial<Message> & { at?: string }): Message => ({ id: "m", channelId: "c", threadId: null, author: { kind: "user", id: "u" }, body: "hi", parts: [], hop: 0, createdAt: over.at ?? "2026-10-24T21:30:00.000Z", ...over }) as Message;

const hhmm = (d: Date) => `${d.getHours()}:00`;

describe("how a conversation reads", () => {
  it("shows a time label after 30 quiet minutes or on a new day, not between neighbors", () => {
    const a = msg({ at: "2026-10-24T21:30:00.000Z" });
    expect(needsStamp(undefined, a)).toBe(true);
    expect(needsStamp(a, msg({ at: "2026-10-24T21:45:00.000Z" }))).toBe(false);
    expect(needsStamp(a, msg({ at: "2026-10-24T22:05:00.000Z" }))).toBe(true);
  });

  it("labels today and yesterday, then the date", () => {
    const now = new Date();
    expect(stampLabel(now.toISOString(), hhmm)).toMatch(/^Today \d/);
    expect(stampLabel(new Date(now.getTime() - 86_400_000).toISOString(), hhmm)).toMatch(/^Yesterday \d/);
    expect(stampLabel("2020-03-04T12:00:00.000Z", hhmm)).toMatch(/^Mar 4, /);
  });

  it("groups one author's messages within five minutes, never a system line", () => {
    const a = msg({});
    expect(isGrouped(a, msg({ at: "2026-10-24T21:33:00.000Z" }))).toBe(true);
    expect(isGrouped(a, msg({ at: "2026-10-24T21:40:00.000Z" }))).toBe(false);
    expect(isGrouped(a, msg({ author: { kind: "agent", id: "n" } }))).toBe(false);
    expect(isGrouped(msg({ author: { kind: "user", id: "system" } }), msg({ author: { kind: "user", id: "system" } }))).toBe(false);
  });

  it("quotes a few words of a message, or says it's an attachment", () => {
    expect(snippetOf(msg({ body: "  Plan's   ready:\n3 steps " }))).toBe("Plan's ready: 3 steps");
    expect(snippetOf(msg({ body: "x".repeat(200) }))).toHaveLength(141);
    expect(snippetOf(msg({ body: "", parts: [{ type: "file", fileId: "f", name: "a.png" }] }))).toBe("Attachment");
  });

  it("says what a tool call did in a line", () => {
    expect(toolLine("Read", { file_path: "/repo/RELEASE-CHECKLIST.md" })).toBe("Read RELEASE-CHECKLIST.md");
    expect(toolLine("Write", { file_path: "notes/release.md" })).toBe("Wrote release.md");
    expect(toolLine("mcp__wisp__memory_remember", {})).toBe("memory_remember");
  });
});
