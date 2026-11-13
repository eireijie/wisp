import { describe, expect, it } from "vitest";
import { looksSecret, memoryPrompt, parseMemoryAnswer, MEMORY_HEADINGS } from "../src/memory-import.ts";

describe("memoryPrompt", () => {
  it("asks for every heading and adds the one-time link only when there is one", () => {
    const plain = memoryPrompt();
    for (const h of MEMORY_HEADINGS) expect(plain).toContain(`## ${h}:`);
    expect(plain).toContain("reply with it and I'll paste it into Wisp");
    expect(plain).not.toContain("one-time link");
    expect(memoryPrompt("https://wisp.example/m/abc")).toContain("https://wisp.example/m/abc (it works once)");
  });
});

describe("parseMemoryAnswer", () => {
  const answer = [
    "Here's everything:",
    "## About me: name, work",
    "- Name: Sam, builds a home automation app (memory)",
    "- Timezone is Europe/Lisbon (unsure).",
    "",
    "## Projects",
    "1. Wisp: agents workspace, repo ~/kodi, next step is onboarding",
    "* Garden sensor (unsure)",
    "**Tools and accounts**",
    "- GitHub, Linear",
    "- api key: sk-ant-api03-abcdefghijklmnop",
    "- Card 4242 4242 4242 4242",
    "### Something else",
    "- A loose fact",
    "- A loose fact",
  ].join("\n");
  const parsed = parseMemoryAnswer(answer);

  it("groups lines by heading and strips list markers", () => {
    expect(parsed.lines.map((l) => [l.heading, l.text])).toEqual([
      ["Other", "Here's everything:"],
      ["About me", "Name: Sam, builds a home automation app (memory)"],
      ["About me", "Timezone is Europe/Lisbon."],
      ["Projects", "Wisp: agents workspace, repo ~/kodi, next step is onboarding"],
      ["Projects", "Garden sensor"],
      ["Tools and accounts", "GitHub, Linear"],
      ["Other", "A loose fact"],
    ]);
  });

  it("marks (unsure) lines so they start unticked", () => {
    expect(parsed.lines.filter((l) => l.unsure).map((l) => l.text)).toEqual(["Timezone is Europe/Lisbon.", "Garden sensor"]);
  });

  it("drops lines that look like secrets and counts them", () => {
    expect(parsed.dropped).toBe(2);
    expect(parsed.lines.some((l) => /sk-ant|4242/.test(l.text))).toBe(false);
  });
});

describe("looksSecret", () => {
  it("catches keys, tokens and card numbers but not links or plain facts", () => {
    expect(looksSecret("ghp_abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksSecret("password is hunter2")).toBe(true);
    expect(looksSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true);
    expect(looksSecret("Repo: https://github.com/someone/a-very-long-repository-name-that-goes-on-and-on")).toBe(false);
    expect(looksSecret("Prefers short answers")).toBe(false);
  });
});
