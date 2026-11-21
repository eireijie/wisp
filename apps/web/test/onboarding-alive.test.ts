import { describe, expect, it, vi } from "vitest";
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));
import { emailLooksRight, passwordStrength } from "../src/views/AuthScreen.tsx";
import { knownTerms, markKnown } from "../src/components/onboarding/FirstHello.tsx";
import { gazeTarget, setGazeFocus } from "../src/ghostGaze.ts";
import { hostWasAt, resetHost } from "../src/components/onboarding/HostGhost.tsx";

describe("onboarding, alive", () => {
  it("draws the email check only on a whole address", () => {
    expect(emailLooksRight("sam@example.com")).toBe(true);
    expect(emailLooksRight(" sam@mail.example.co.uk ")).toBe(true);
    for (const bad of ["", "sam", "sam@", "sam@example", "sam@example.", "sam @example.com", "@example.com"]) expect(emailLooksRight(bad)).toBe(false);
  });

  it("fills the password meter as it gets stronger", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("short")).toBe(1);
    expect(passwordStrength("abcdefgh")).toBe(1);
    expect(passwordStrength("abcdEfgh")).toBe(2);
    expect(passwordStrength("abcdEfg1")).toBe(3);
    expect(passwordStrength("abcdEfg1!")).toBe(4);
    expect(passwordStrength("a".repeat(20))).toBe(2);
  });

  it("underlines only words its hello could only know from setup", () => {
    const terms = knownTerms([
      { group: "Work", text: "Runs the spring sale at Acme Bikes", src: "ChatGPT" },
      { group: "You", text: "Sam Rivera", src: "you" },
      { group: "Likes", text: "Short replies, things done by 9", src: "this Mac" },
    ]);
    const words = terms.map((t) => t.term);
    expect(words).toEqual(expect.arrayContaining(["acme", "bikes", "rivera"]));
    // ordinary words, the first word of a fact and anything too short stay plain
    expect(words).not.toEqual(expect.arrayContaining(["runs", "the", "sam", "short", "things"]));
    expect(terms.find((t) => t.term === "acme")?.src).toBe("ChatGPT");
  });

  it("leaves a message alone where it can't parse HTML", () => {
    expect(markKnown("<p>Hi</p>", [{ term: "hi", src: "you" }])).toBe("<p>Hi</p>");
  });

  it("looks away from a password and at a field, then back at the pointer", () => {
    // looking away turns the face hard to one side; a field to the right turns it right
    expect(gazeTarget(-400, -60, 100, true)[0]).toBeLessThan(-4);
    expect(gazeTarget(300, 0, 100)[0]).toBeGreaterThan(3);
    // setting and clearing the focus is safe without any ghosts on the page
    expect(() => (setGazeFocus("away"), setGazeFocus({ x: 10, y: 10 }), setGazeFocus(null))).not.toThrow();
  });

  it("forgets where the host stood", () => {
    resetHost();
    expect(hostWasAt()).toBeNull();
  });
});
