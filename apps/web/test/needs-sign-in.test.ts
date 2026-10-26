import { describe, expect, it } from "vitest";
import type { HarnessSettings } from "@wisp/core";
import { needsSignIn } from "../src/views/needs-sign-in.ts";

const tool = (harness: string, signedIn: boolean | null): HarnessSettings => ({ harness, accounts: [{ isDefault: true, signedIn }] }) as unknown as HarnessSettings;

describe("which AI tool needs signing in", () => {
  it("finds an AI whose account isn't signed in, and only once the list has it", () => {
    expect(needsSignIn([], "kimi")).toBeNull();
    const fresh = [tool("kimi", false)];
    expect(needsSignIn(fresh, "kimi")?.harness).toBe("kimi");
    expect(needsSignIn([tool("kimi", true)], "kimi")).toBeNull();
    expect(needsSignIn(fresh, "codex")).toBeNull();
  });
});
