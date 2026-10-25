import { describe, expect, it } from "vitest";
import { envVar } from "../src/env.ts";

describe("renamed environment settings", () => {
  it("prefers Wisp, falls back to Warren only when unset, and preserves empty values", () => {
    expect(envVar("DATA_DIR", { WISP_DATA_DIR: "/new", WARREN_DATA_DIR: "/old" })).toBe("/new");
    expect(envVar("DATA_DIR", { WARREN_DATA_DIR: "/old" })).toBe("/old");
    expect(envVar("DATA_DIR", { WISP_DATA_DIR: "", WARREN_DATA_DIR: "/old" })).toBe("");
    expect(envVar("DATA_DIR", {})).toBeUndefined();
  });
});
