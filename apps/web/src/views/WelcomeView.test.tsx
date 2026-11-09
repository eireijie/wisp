import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@wisp/core";
import { api } from "../api.ts";
import { advanceTailscale, AgentCreated, HarnessChoice, makeFirstAgent, NO_NODE, serverAddress, SETUP_LABELS, TailscaleScreen, tailscaleProblem } from "./WelcomeView.tsx";
import type { AccessInfo } from "../access.ts";
import type { DeviceInfo } from "../devices.ts";


vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
const view = vi.hoisted(() => ({ advanced: false, computers: [] as unknown[] }));
vi.mock("../computerMode.ts", () => ({ useComputerMode: () => ({ advanced: view.advanced, sharedComputerId: null, loaded: true }) }));
vi.mock("../store.ts", async (original) => {
  const real = await original<typeof import("../store.ts")>();
  return { ...real, useStore: Object.assign((select: (s: unknown) => unknown) => select({ ...real.useStore.getState(), computers: view.computers }), real.useStore) };
});
afterEach(() => vi.mocked(api).mockReset());
const device: DeviceInfo = { id: "mac", name: "My Mac", mine: true, online: true, agents: [], harnesses: [{ id: "codex", version: null }] };

describe("Wisp setup after the account", () => {
  it("goes outside your home, address, agent, devices", () => {
    expect(Object.keys(SETUP_LABELS)).toEqual(["anywhere", "address", "agent", "devices"]);
  });
  describe("server address", () => {
    const home = { origin: "http://localhost:4747", protocol: "http:", hostname: "localhost" };
    const info = (over: Partial<AccessInfo>) => ({ publicUrl: null, lan: ["http://192.168.1.20:4747"], tailscale: { funnel: false }, ...over }) as AccessInfo;
    it("is the Tailscale address once it's on, and says who can reach it", () => {
      const a = serverAddress(info({ publicUrl: "https://mac.example.ts.net" }), home);
      expect(a?.url).toBe("https://mac.example.ts.net");
      expect(a?.note).toContain("Any device on your Tailscale");
    });
    it("is the home address when staying at home, and says so", () => {
      const a = serverAddress(info({}), home);
      expect(a?.url).toBe("http://192.168.1.20:4747");
      expect(a?.note).toContain("home network");
    });
    it("is the page's own address on a cloud server", () => {
      expect(serverAddress(null, { origin: "https://wisp.example.com", protocol: "https:", hostname: "wisp.example.com" })?.url).toBe("https://wisp.example.com");
    });
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
      expect.objectContaining({ handle: "atlas-2", nodeId: "mac", useDefaults: true, settings: {} }),
    );
  });
  it("saves the look you gave your agent", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "agent" });
    const appearance = { shape: "tall", color: "#e771ff", color2: "#ffd87c", eyes: "dots", mouth: "smile", cheeks: false, hat: "crown", accessory: "none", motion: "float" } as const;
    await makeFirstAgent(device, "codex", "Atlas", [], [], appearance);
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/agents", expect.objectContaining({ settings: { appearance } }));
  });
  it("lets Wisp place an installed harness (the shared computer), without moving its sign-in", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "agent" });
    const ready = { ...device, capabilities: { vm: { ok: true } } } as DeviceInfo;
    await makeFirstAgent(ready, "codex", "Atlas", [], []);
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/agents", expect.objectContaining({ nodeId: "mac", useDefaults: true }));
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
  it("recognises the device's missing Node.js message, and nothing else", () => {
    expect(NO_NODE.test("Node.js isn't installed on this computer, and Kimi is installed with it. Install Node.js from https://nodejs.org, then try again.")).toBe(true);
    expect(NO_NODE.test("npm can't write its global folder on Mac (permission denied). Install it there yourself: npm install -g kimi")).toBe(false);
    expect(NO_NODE.test("npm install -g kimi failed:\nnetwork")).toBe(false);
  });
  it("installs again on retry once Node.js is there", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Node.js isn't installed on this computer, and Kimi is installed with it."));
    await expect(makeFirstAgent(device, "kimi", "Atlas", [], [])).rejects.toThrow("Node.js");
    vi.mocked(api).mockReset().mockResolvedValue({});
    await makeFirstAgent(device, "kimi", "Atlas", [], []);
    expect(api).toHaveBeenNthCalledWith(1, "POST", "/api/nodes/mac/install", { harness: "kimi" });
  });
});

describe("the agent's made", () => {
  const agent = { id: "a1", name: "Atlas", handle: "atlas", harness: "codex", computerId: "c1", settings: {} } as unknown as Agent;
  const show = (advanced: boolean) => {
    view.advanced = advanced;
    view.computers = [{ id: "c1", kind: "vm", name: "Shared computer", nodeId: "mac", config: { shared: true }, agents: ["a1"] }];
    return renderToStaticMarkup(createElement(AgentCreated, { agent, device: "This Mac", onNext() {} }));
  };
  it("says plainly it works on the shared computer, and which device only in Advanced", () => {
    expect(show(false)).toContain("Uses Codex, on the shared computer.");
    expect(show(false)).not.toContain("This Mac");
    expect(show(true)).toContain("Uses Codex, on This Mac.");
  });
});

describe("Tailscale screen never sits silently", () => {
  const ts = (over: Record<string, unknown>) => ({ publicUrl: null, lan: [], download: "https://tailscale.com/download", hubPlatform: "darwin", tailscale: { state: "running", dnsName: null, serving: false, funnel: false, error: null, authUrl: null, ...over } }) as unknown as AccessInfo;
  const show = (info: AccessInfo | null, problem: string | null) =>
    renderToStaticMarkup(createElement(TailscaleScreen, { info, authUrl: info?.tailscale.authUrl, problem, onRetry: () => {}, onSkip: () => {} }));
  it("shows the error state's message with Try again and the way out", () => {
    const info = ts({ state: "error", error: "Tailscale is installed but not running. Open the Tailscale app." });
    const problem = tailscaleProblem({ info, failed: false });
    expect(problem).toBe("Tailscale is installed but not running. Open the Tailscale app.");
    const html = show(info, problem);
    expect(html).toContain("not running");
    expect(html).toContain("Try again");
    expect(html).toContain("Only at home for now");
  });
  it("has a message even when the error state carries none", () => {
    expect(tailscaleProblem({ info: ts({ state: "error" }), failed: false })).toMatch(/didn't answer/);
  });
  it("clears by itself once Tailscale recovers", () => {
    expect(tailscaleProblem({ info: ts({ state: "needs-login" }), failed: false })).toBeNull();
    expect(show(ts({ state: "needs-login", authUrl: "https://login.tailscale.com/a/x" }), null)).not.toContain("Try again");
  });
  it("says it is connecting, then asks to try again if it never finishes", () => {
    const info = ts({ state: "starting" });
    expect(tailscaleProblem({ info, failed: false })).toBeNull();
    expect(show(info, null)).toContain("Tailscale is connecting");
    const slow = tailscaleProblem({ info, failed: false, slow: true });
    expect(slow).toMatch(/taking a while/);
    expect(show(info, slow)).toContain("Try again");
  });
  it("reports a failed check of this computer, even with no status yet", () => {
    const problem = tailscaleProblem({ info: null, failed: true });
    expect(show(null, problem)).toContain("Try again");
  });
  it("shows a serve or HTTPS failure that arrives with a running state", () => {
    const text = "Tailscale Serve is off for your tailnet. Turn it on, then try again: https://login.tailscale.com/f/serve?node=abc";
    expect(tailscaleProblem({ info: ts({ error: text }), failed: false })).toBe(text);
  });
  it("is not silent when sign-in gives no page", async () => {
    const login = vi.fn().mockResolvedValue(ts({ state: "needs-login", authUrl: null }));
    const r = await advanceTailscale("needs-login", false, { login, enable: vi.fn() });
    expect(r.problem).toMatch(/sign-in page/);
  });
  it("opens the sign-in page it is given", async () => {
    const login = vi.fn().mockResolvedValue(ts({ state: "needs-login", authUrl: "https://login.tailscale.com/a/x" }));
    expect(await advanceTailscale("needs-login", false, { login, enable: vi.fn() })).toEqual({ loginUrl: "https://login.tailscale.com/a/x" });
  });
  it("is not silent when enabling resolves false, and moves on when it resolves true", async () => {
    const enable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await advanceTailscale("running", true, { login: vi.fn(), enable })).problem).toMatch(/isn't ready/);
    expect(await advanceTailscale("stopped", true, { login: vi.fn(), enable })).toEqual({ done: true });
  });
  it("turns a thrown failure into a message", async () => {
    const enable = vi.fn().mockRejectedValue(new Error("HTTPS certificates are off for your tailnet."));
    expect((await advanceTailscale("running", true, { login: vi.fn(), enable })).problem).toContain("HTTPS certificates");
  });
  it("does nothing for states it does not push", async () => {
    expect(await advanceTailscale("error", false, { login: vi.fn(), enable: vi.fn() })).toEqual({});
  });
});
