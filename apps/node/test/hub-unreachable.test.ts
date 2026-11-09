import { describe, expect, it } from "vitest";
import { hubUnreachableMessage } from "../src/daemon.ts";

describe("hubUnreachableMessage", () => {
  it("says the device couldn't reach Wisp when the request never got an answer", () => {
    expect(hubUnreachableMessage("This Mac", "http://hub:4747", new TypeError("fetch failed"))).toMatch(/This Mac couldn't reach Wisp at http:\/\/hub:4747/);
  });
  it("says it is signed out on 401", () => {
    expect(hubUnreachableMessage("This Mac", "h", Object.assign(new Error("x"), { status: 401 }))).toMatch(/isn't signed in/);
  });
  it("reports a hub error as an error, not as 'not assigned'", () => {
    const m = hubUnreachableMessage("This Mac", "h", Object.assign(new Error("boom"), { status: 500 }));
    expect(m).toMatch(/500/);
    expect(m).not.toMatch(/assigned/);
  });
});
