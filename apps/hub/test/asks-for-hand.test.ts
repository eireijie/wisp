import { describe, expect, it } from "vitest";
import { asksForHand } from "../src/hub.ts";

describe("asksForHand", () => {
  it("picks the sentence asking for a sign-in", () => {
    expect(asksForHand("I opened Zendesk. Please sign in on my computer and I'll keep going.")).toBe("Please sign in on my computer and I'll keep going.");
    expect(asksForHand("It wants a 2FA code. Can you enter the verification code?")).toBe("Can you enter the verification code?");
  });
  it("ignores ordinary answers", () => {
    expect(asksForHand("Done! I signed in and exported the report.")).toBeNull();
    expect(asksForHand("Can you tell me which file you meant?")).toBeNull();
  });
});
