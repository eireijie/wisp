import { describe, expect, it } from "vitest";
import { setDraft, takeDraft } from "../src/draft.ts";

describe("draft handoff", () => {
  it("hands the words to that chat once", () => {
    setDraft("ch1", "Plan dinners");
    expect(takeDraft("ch2")).toBeUndefined();
    expect(takeDraft("ch1")).toBe("Plan dinners");
    expect(takeDraft("ch1")).toBeUndefined();
  });
});
