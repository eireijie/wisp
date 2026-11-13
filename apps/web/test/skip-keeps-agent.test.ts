import { describe, expect, it, vi } from "vitest";
import { skipKeepingAgent } from "../src/views/WelcomeView.tsx";
import type { Agent } from "@wisp/core";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const device = { id: "n1", name: "Mac" } as never;
const base = { device, harness: "codex", name: " Atlas ", agents: [], computers: [], look: {} as never };

describe("Skip for now on the agent step", () => {
  it("makes the agent the person named instead of dropping it", async () => {
    const make = vi.fn().mockResolvedValue({ id: "a1", name: "Atlas" } as Agent);
    const r = await skipKeepingAgent({ ...base, make });
    expect(r.kept?.id).toBe("a1");
    expect(make).toHaveBeenCalledWith(device, "codex", "Atlas", [], [], base.look, undefined);
  });
  it("keeps the model connection the person signed in with", async () => {
    const make = vi.fn().mockResolvedValue({ id: "a1", name: "Atlas" } as Agent);
    await skipKeepingAgent({ ...base, connectionId: "mc_1", make });
    expect(make).toHaveBeenCalledWith(device, "codex", "Atlas", [], [], base.look, "mc_1");
  });
  it("has nothing to keep without a computer or a name", async () => {
    const make = vi.fn();
    expect(await skipKeepingAgent({ ...base, device: undefined, make })).toEqual({ kept: null, reason: "nothing-to-keep" });
    expect(await skipKeepingAgent({ ...base, name: "  ", make })).toEqual({ kept: null, reason: "nothing-to-keep" });
    expect(make).not.toHaveBeenCalled();
  });
  it("says what went wrong instead of swallowing it", async () => {
    const r = await skipKeepingAgent({ ...base, make: vi.fn().mockRejectedValue(new Error("no room")) });
    expect(r).toEqual({ kept: null, reason: "failed", message: "no room" });
  });
});
