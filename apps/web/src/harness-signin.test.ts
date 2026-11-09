import { describe, expect, it } from "vitest";
import { replyAfter } from "./harness-signin.ts";

describe("a harness sign-in's answer to a pasted code", () => {
  it("is what it printed after the code went in, without the prompt it asks again with", () => {
    const before = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/x\nPaste code here if prompted > ";
    expect(replyAfter(before, before)).toBe("");
    expect(replyAfter(before, `${before}Invalid code. Please make sure the full code was copied.\nPaste code here if prompted > `)).toBe("Invalid code. Please make sure the full code was copied.");
  });

  it("still finds the last line when the start of the output was trimmed away", () => {
    expect(replyAfter("old text that scrolled off", "…\nLogin failed: Request failed with status code 400\n")).toBe("Login failed: Request failed with status code 400");
  });
});
