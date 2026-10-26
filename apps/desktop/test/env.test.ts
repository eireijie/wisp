import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { envVar } = createRequire(import.meta.url)("../src/env.cjs");

describe("desktop environment compatibility", () => {
  it("uses legacy values only when the public name is unset, including explicitly empty values", () => {
    expect(envVar("NODE_DIR", { WARREN_NODE_DIR: "/old" })).toBe("/old");
    expect(envVar("NODE_DIR", { WISP_NODE_DIR: "/new", WARREN_NODE_DIR: "/old" })).toBe("/new");
    expect(envVar("NODE_DIR", { WISP_NODE_DIR: "", WARREN_NODE_DIR: "/old" })).toBe("");
    expect(envVar("NODE_DIR", {})).toBeUndefined();
  });
});
