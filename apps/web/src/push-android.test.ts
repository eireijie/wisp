import { afterEach, describe, expect, it, vi } from "vitest";
import { androidPush, parseState } from "./push-android.ts";

vi.mock("./api.ts", () => ({ api: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("push in the Android app", () => {
  it("is only on when the app exposes its push bridge", () => {
    vi.stubGlobal("window", {});
    expect(androidPush()).toBe(false);
    vi.stubGlobal("window", { WispAndroid: { signedOut() {} } });
    expect(androidPush()).toBe(false);
    vi.stubGlobal("window", { WispAndroid: { pushState: () => "{}" } });
    expect(androidPush()).toBe(true);
  });

  it("reads the phone's push state, and treats nonsense as off", () => {
    expect(parseState('{"available":true,"permission":true,"registered":true}')).toEqual({ allowed: true, registered: true });
    expect(parseState('{"permission":false}')).toEqual({ allowed: false, registered: false });
    expect(parseState("nope")).toEqual({ allowed: false, registered: false });
    expect(parseState(undefined)).toEqual({ allowed: false, registered: false });
  });
});
