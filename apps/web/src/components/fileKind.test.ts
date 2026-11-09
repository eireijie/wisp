import { describe, expect, it } from "vitest";
import { fileKind } from "./fileKind.ts";
import { workingLine } from "./agentActivity.ts";

describe("opening a chat file", () => {
  it.each([
    ["notes.txt", "text"],
    ["notes.md", "text"],
    ["data.CSV", "text"],
    ["photo.JPG", "image"],
    ["shot.webp", "image"],
    ["report.pdf", "pdf"],
    ["deck.pptx", "other"],
    ["archive.zip", "other"],
    ["noext", "other"],
  ])("%s → %s", (name, kind) => expect(fileKind(name)).toBe(kind));
});

describe("a list row's busy line", () => {
  it("says what it's doing once, with no repeated words", () => {
    expect(workingLine("shell")).toBe("Running a command");
    expect(workingLine("wisp.memory_search")).toBe("Searching memory");
    expect(workingLine("some_unknown_tool")).toBe("Working");
    expect(workingLine(undefined, true)).toBe("Writing a reply");
    expect(workingLine(undefined)).toBe("Thinking");
  });
});
