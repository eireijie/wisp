import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@wisp/core";
import { api } from "../api.ts";
import { HarnessChoice, makeFirstAgent, ReadyChecklist, SETUP_LABELS } from "./WelcomeView.tsx";
import type { DeviceInfo } from "../devices.ts";

vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
afterEach(() => vi.mocked(api).mockReset());
const device: DeviceInfo = { id: "mac", name: "My Mac", mine: true, online: true, agents: [], harnesses: [{ id: "codex", version: null }] };

describe("four-step Wisp setup", () => {
  it("has exactly four steps and no experience question", () => {
    expect(Object.keys(SETUP_LABELS)).toEqual(["ready", "agent", "anywhere", "devices"]);
  });
  it.each([
    ["darwin", "Mac"],
    ["win32", "PC"],
    ["linux", "computer"],
  ])("shows live readiness for %s", (platform, label) => {
    const html = renderToStaticMarkup(createElement(ReadyChecklist, { platform, devices: [device] }));
    expect(html).toContain(`Wisp is running on this ${label}`);
    expect(html).toContain("Found Codex");
    expect(html).toContain("About 2 min, you can keep going.");
    expect(html).not.toContain("Warren");
  });
  it("uses a plain line icon and an accessible harness selection", () => {
    const html = renderToStaticMarkup(createElement(HarnessChoice, { title: "Codex", body: "Signed in", selected: true, onClick() {} }));
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("<svg");
    expect(html).toContain("Signed in");
  });
  it("keeps an installed harness on the device with its existing sign-in and a free handle", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "agent" });
    await makeFirstAgent(device, "codex", "Atlas", [{ handle: "atlas" } as Agent], []);
    expect(api).toHaveBeenCalledExactlyOnceWith(
      "POST",
      "/api/agents",
      expect.objectContaining({ handle: "atlas-2", nodeId: "mac", computerId: null, settings: { headless: true } }),
    );
  });
  it("gives an installed harness a computer without moving its sign-in", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "vm" }).mockResolvedValueOnce({ id: "agent" });
    const ready = { ...device, capabilities: { vm: { ok: true } } } as DeviceInfo;
    await makeFirstAgent(ready, "codex", "Atlas", [], []);
    expect(api).toHaveBeenNthCalledWith(1, "POST", "/api/computers", expect.objectContaining({ kind: "vm" }));
    expect(api).toHaveBeenNthCalledWith(2, "POST", "/api/agents", expect.objectContaining({ computerId: "vm", settings: { runIn: "device" } }));
  });
  it("installs a missing npm harness before creating its agent", async () => {
    vi.mocked(api).mockResolvedValue({});
    await makeFirstAgent(device, "kimi", "Atlas", [], []);
    expect(api).toHaveBeenNthCalledWith(1, "POST", "/api/nodes/mac/install", { harness: "kimi" });
    expect(api).toHaveBeenNthCalledWith(3, "POST", "/api/agents", expect.objectContaining({ harness: "kimi" }));
  });
  it("uses the harness inside a prepared computer without an unsupported device install", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "vm" }).mockResolvedValueOnce({ id: "agent" });
    const ready = { ...device, capabilities: { vm: { ok: true } } } as DeviceInfo;
    await makeFirstAgent(ready, "hermes", "Atlas", [], []);
    expect(api).toHaveBeenNthCalledWith(1, "POST", "/api/computers", expect.objectContaining({ kind: "vm" }));
    expect(api).toHaveBeenNthCalledWith(2, "POST", "/api/agents", expect.objectContaining({ computerId: "vm", settings: { runIn: "computer" } }));
  });
  it("doesn't create a half-configured agent after installation fails", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Install failed"));
    await expect(makeFirstAgent(device, "kimi", "Atlas", [], [])).rejects.toThrow("Install failed");
    expect(api).toHaveBeenCalledTimes(1);
  });
});
