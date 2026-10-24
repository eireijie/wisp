import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EasiestWay } from "./WelcomeView.tsx";

const desktop = vi.hoisted(() => ({ platform: "darwin", device: false }));
vi.mock("../desktop.ts", () => ({ useDesktopInfo: () => ({ inDesktop: true, info: { platform: desktop.platform, device: desktop.device }, connect: vi.fn() }) }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
vi.mock("../access.ts", async (original) => ({ ...await original<typeof import("../access.ts")>(), useAccess: () => null, shareOrigin: () => "https://hub" }));

describe("desktop onboarding wording", () => {
  it.each([["darwin", "Mac"], ["win32", "PC"], ["linux", "computer"], ["", "computer"]])("uses %s platform information", (platform, label) => {
    desktop.platform = platform;
    desktop.device = false;
    const html = renderToStaticMarkup(createElement(EasiestWay, { name: "device", token: "token", connected: false }));
    expect(html).toContain(`This ${label} is being connected automatically`);
    expect(html).toContain(`The Wisp app has not connected this ${label} yet.`);
    expect(html).toContain(`Connect this ${label}`);
  });

  it.each([["darwin", "Mac"], ["win32", "PC"], ["linux", "computer"]])("offers the other-device command when this %s device is already connected", (platform, label) => {
    desktop.platform = platform;
    desktop.device = true;
    const html = renderToStaticMarkup(createElement(EasiestWay, { name: "another-device", token: "other-token", connected: false }));
    expect(html).toContain(`This ${label} is already connected`);
    expect(html).not.toContain(`Connect this ${label}`);
    expect(html).not.toContain("It can take a few seconds");
    expect(html).toMatch(/<details open=""/);
    expect(html).toContain("Connect another computer with a command");
    expect(html).toContain("--token other-token");
    expect(html).toContain("another-device");
  });
});
