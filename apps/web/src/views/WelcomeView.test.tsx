import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EasiestWay } from "./WelcomeView.tsx";

const desktop = vi.hoisted(() => ({ platform: "darwin" }));
vi.mock("../desktop.ts", () => ({ useDesktopInfo: () => ({ inDesktop: true, info: { platform: desktop.platform, device: false }, connect: vi.fn() }) }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
vi.mock("../access.ts", async (original) => ({ ...await original<typeof import("../access.ts")>(), useAccess: () => null, shareOrigin: () => "https://hub" }));

describe("desktop onboarding wording", () => {
  it.each([["darwin", "Mac"], ["win32", "PC"], ["linux", "computer"], ["", "computer"]])("uses %s platform information", (platform, label) => {
    desktop.platform = platform;
    const html = renderToStaticMarkup(createElement(EasiestWay, { name: "device", token: "token", connected: false }));
    expect(html).toContain(`This ${label} is being connected automatically`);
    expect(html).toContain(`The Warren app has not connected this ${label} yet.`);
    expect(html).toContain(`Connect this ${label}`);
  });
});
