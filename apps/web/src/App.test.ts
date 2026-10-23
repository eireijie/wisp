import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setToken } from "./api.ts";
import { logout } from "./App.tsx";

vi.mock("./api.ts", () => ({ api: vi.fn(), setToken: vi.fn() }));
vi.mock("./theme.ts", () => ({ motionReduced: () => false }));
vi.mock("./views/BuddyView.tsx", () => ({ BuddyView: () => null }));

beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue({});
  vi.mocked(setToken).mockReset();
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", { hash: "#/c/channel", reload: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("logout badges", () => {
  it.each(["clear", "fallback", "desktop", "unsupported", "failure"])("clears the badge before clearing authentication (%s)", async (kind) => {
    const badge = vi.fn(async () => {
      expect(setToken).not.toHaveBeenCalled();
      if (kind === "failure") throw new Error("Unsupported");
    });
    if (kind === "clear" || kind === "failure") vi.stubGlobal("navigator", { clearAppBadge: badge });
    if (kind === "fallback") vi.stubGlobal("navigator", { setAppBadge: badge });
    if (kind === "desktop") vi.stubGlobal("window", { warrenDesktop: { setBadge: badge } });
    await logout();
    if (kind !== "unsupported") expect(badge).toHaveBeenCalledOnce();
    if (kind === "fallback" || kind === "desktop") expect(badge).toHaveBeenCalledWith(0);
    expect(setToken).toHaveBeenCalledWith(null);
    expect(location.reload).toHaveBeenCalledOnce();
  });
});
