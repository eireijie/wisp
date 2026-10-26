import { describe, expect, it } from "vitest";
import type { HarnessSettings } from "@wisp/core";
import { signInFor } from "../src/views/needs-sign-in.ts";

const tool = (harness: string, signedIn: boolean | null): HarnessSettings => ({ harness, accounts: [{ isDefault: true, signedIn }] }) as unknown as HarnessSettings;

describe("which AI tool needs signing in", () => {
  it("finds an AI whose account isn't signed in, and only once the list has it", () => {
    expect(signInFor([], "kimi")).toBeNull();
    const fresh = [tool("kimi", false)];
    expect(signInFor(fresh, "kimi")?.harness).toBe("kimi");
    expect(signInFor([tool("kimi", true)], "kimi")).toBeNull();
    expect(signInFor(fresh, "codex")).toBeNull();
  });
});
