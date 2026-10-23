import crypto from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ScreenLock, codeProblem } from "../../node/src/screen-lock.ts";

const desktop = createRequire(import.meta.url)("../src/screen-code.cjs");

describe("the desktop app's screen code", () => {
  it("follows the device's rules", () => {
    for (const [kind, code] of [["pin", "12345"], ["pin", "123456"], ["password", "short"], ["password", "12345678"], ["password", "long enough"], ["password", "x".repeat(201)]] as const)
      expect(desktop.codeProblem(kind, code)).toBe(codeProblem(kind, code));
  });

  it("needs the code typed twice", () => {
    expect(desktop.pick({ kind: "pin", code: "123456", again: "123465" })).toEqual({ error: "Those didn't match." });
    expect(desktop.pick({ kind: "pin", code: "12a456", again: "12a456" }).error).toBe("A PIN is 6 digits.");
  });

  it("saves a hash the device accepts", () => {
    const { screenCode } = desktop.pick({ kind: "password", code: "correct horse", again: "correct horse" });
    expect(screenCode.kind).toBe("password");
    expect(JSON.stringify(screenCode)).not.toContain("correct horse");
    const lock = new ScreenLock(fsTmp(), () => screenCode);
    expect(lock.check("wrong one!").ok).toBe(false);
    expect(lock.check("correct horse").ok).toBe(true);
  });
});

function fsTmp() {
  return `/tmp/warren-screen-code-${crypto.randomUUID()}`; // ScreenLock ignores a folder it can't write
}
