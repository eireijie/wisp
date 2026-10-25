import { describe, expect, it } from "vitest";
import { HARNESSES } from "@wisp/core";

describe("harness choice", () => {
  it("explains every harness", () => {
    for (const h of HARNESSES) {
      expect(h.blurb, h.id).toBeTruthy();
      expect(h.account, h.id).toBeTruthy();
    }
  });
});
