import { HARNESSES } from "@bubble-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, ModelConnection } from "@bubble-ai/core";
import { api } from "../api.ts";
import { askableOn, finishedSteps, firstRunAgent, makeFirstAgent, NO_NODE, welcomeScreen } from "./WelcomeView.tsx";
import { AgentStep, JOBS, nextLook, saveNamedAgent, shapeOf, suggestedName } from "./onboarding/AgentStep.tsx";
import { AIStep, checkAI, foundOn } from "./onboarding/AIStep.tsx";
import { introMessage, picksMessage, YoursStep, yoursInstructions } from "./onboarding/BubbleSetup.tsx";
import { AwayStep, awayStepWanted, awayTicks } from "./onboarding/AwayStep.tsx";
import { lookOf, pointAgentAt } from "./onboarding/firstAgent.ts";
import { TRACK } from "../components/SetupShell.tsx";
import { devicesLine, serverAddress, stepsFinished } from "../onboarding.ts";
import { loadAnswers } from "../onboardingV3.ts";
import { useStore } from "../store.ts";
import type { AccessInfo } from "../access.ts";
import type { DeviceInfo } from "../devices.ts";

vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));
// a static render reads a store's first state: read the current one, so a test can put an agent in it
vi.mock("../store.ts", async (original) => {
  const real = await original<typeof import("../store.ts")>();
  return { ...real, useStore: Object.assign((select: (s: unknown) => unknown) => select(real.useStore.getState()), real.useStore) };
});
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
beforeEach(() => mem.clear());
afterEach(() => vi.mocked(api).mockReset());
const device: DeviceInfo = { id: "mac", name: "My Mac", mine: true, online: true, agents: [], harnesses: [{ id: "codex", version: null }] };
const juno = { id: "a1", name: "Juno", handle: "juno", createdAt: "2026-11-01T00:00:00Z", settings: { role: "Keep my days on track", appearance: lookOf("#a98bf5", "classic"), createdBy: "u1" } } as unknown as Agent;

describe("the first run is three screens", () => {
  it("you, your agent, its AI", () => {
    expect([...TRACK]).toEqual(["You", "Your agent", "Its AI"]);
  });
  it("opens on Your agent, and on Its AI only once the agent exists", () => {
    expect(welcomeScreen(null, { intro: true, hasAgent: false })).toBe("agent");
    expect(welcomeScreen(null, { hasAgent: false })).toBe("agent");
    // even when Its AI was asked for: never without an agent
    expect(welcomeScreen("ai", { hasAgent: false })).toBe("agent");
    expect(welcomeScreen("ai", { intro: true, hasAgent: true })).toBe("ai");
    // coming back to finish setup with the agent made lands on its AI; "See the welcome again" starts at the agent
    expect(welcomeScreen(null, { hasAgent: true })).toBe("ai");
    expect(welcomeScreen(null, { intro: true, hasAgent: true })).toBe("agent");
    expect(welcomeScreen("agent", { hasAgent: true })).toBe("agent");
  });
  it("is about the agent it made, or the person's oldest one from another browser, never someone else's", () => {
    const mine = { ...juno, id: "a2", createdAt: "2026-11-02T00:00:00Z" };
    const theirs = { ...juno, id: "a3", createdAt: "2026-10-01T00:00:00Z", settings: { createdBy: "u2" } } as unknown as Agent;
    expect(firstRunAgent("a2", [juno, mine], "u1")?.id).toBe("a2");
    expect(firstRunAgent(null, [theirs, mine, juno], "u1")?.id).toBe("a1");
    expect(firstRunAgent(null, [theirs], "u1")).toBeUndefined();
    // one it made that was since removed is made again, not swapped for another
    expect(firstRunAgent("gone", [juno], "u1")).toBeUndefined();
  });
  it("marks the agent step done only when there is an agent", () => {
    expect(finishedSteps(false)).toEqual([]);
    // away from home is its own page now: never ticked off without being shown
    expect(finishedSteps(true)).toEqual(["address", "agent", "devices"]);
    expect(stepsFinished(false)).toEqual(["devices"]);
    expect(stepsFinished(true)).toEqual(["agent", "devices"]);
    expect(devicesLine(null)).not.toMatch(/Say hi/);
    expect(devicesLine("Juno")).toBe("Say hi to Juno from your phone too.");
  });
  it("Your agent: a name already filled in, six colours, one button", () => {
    const look = lookOf("#a59bff", "classic");
    const html = renderToStaticMarkup(createElement(AgentStep, { workspaceId: "w1", person: "Sam Rivera", device, look, onLook: () => {}, onContinue: () => {} }));
    expect(html).toContain('value="Juno"');
    expect(html).toContain('data-ob-slot="176"');
    expect((html.match(/class="ob-swatch"/g) ?? []).length).toBe(6);
    expect(html).toContain("Continue");
    expect(html).not.toMatch(/Advanced|Simple/);
  });
  it("Which AI app: every harness at once, each with its logo, and the three big ones first", () => {
    useStore.setState({ agents: [juno] });
    const html = renderToStaticMarkup(createElement(AIStep, { agentId: "a1", device, onDone: () => {} }));
    expect(html).toContain("Which AI app runs Juno?");
    for (const h of HARNESSES.filter((x) => x.protocol !== "mcp")) expect(html).toContain(`>${h.label}<`);
    expect(html.indexOf(">Claude Code<")).toBeLessThan(html.indexOf(">Gemini CLI<"));
    expect(html).toContain("Claude, ChatGPT, Grok, Gemini");
    expect(html).not.toMatch(/Something else|Step 3 of 3/);
    expect(html).toContain("Set up later");
    useStore.setState({ agents: [] });
  });
  it("suggests a name that isn't the person's own or taken, and jobs to pick from", () => {
    expect(suggestedName("Sam")).toBe("Juno");
    expect(suggestedName("Juno Park")).toBe("Atlas");
    expect(suggestedName("Sam", ["juno", "Atlas"])).toBe("Pip");
    expect(JOBS).toContain("Help with my code");
    expect(JOBS.every((j) => j.length <= 60 && !j.endsWith("."))).toBe(true);
  });
  it("a click on the ghost always gives another colour and shape", () => {
    const look = lookOf("#a98bf5", "classic");
    for (const r of [0, 0.5, 0.999]) {
      const next = nextLook(look, () => r);
      expect(next.color).not.toBe(look.color);
      expect(next.shape).not.toBe(look.shape);
    }
  });
});

describe("the agent exists from Your agent on", () => {
  const shape = shapeOf(" Juno ", "Keep my days on track", lookOf("#3cc0a6", "round"), "Sam Rivera");
  it("is made when Your agent is continued, holding its hello until its AI is chosen", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "a1" });
    const id = await saveNamedAgent({ workspaceId: "w1", existing: undefined, shape, harness: "claude-code", device, agents: [{ id: "x", handle: "juno" }] });
    expect(id).toBe("a1");
    expect(api).toHaveBeenCalledExactlyOnceWith(
      "POST",
      "/api/agents",
      expect.objectContaining({ name: "Juno", handle: "juno-2", harness: "claude-code", nodeId: "mac", useDefaults: true, greet: "later", settings: { appearance: shape.appearance, role: "Keep my days on track" } }),
    );
    expect(vi.mocked(api).mock.calls[0][2]).toMatchObject({ instructions: expect.stringContaining("You are Juno, Sam's agent in Bubble AI.") });
    // remembered, so Its AI and a reload are about this agent
    expect(loadAnswers("w1").agentId).toBe("a1");
  });
  it("is made with no computer connected yet, and installs nothing", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "a1" });
    await saveNamedAgent({ workspaceId: "w1", existing: undefined, shape, harness: "claude-code", device: undefined, agents: [] });
    expect(api).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[0][2]).not.toHaveProperty("nodeId");
  });
  it("doesn't move on, or remember an agent, when the hub won't make one", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("handle taken"));
    await expect(saveNamedAgent({ workspaceId: "w1", existing: undefined, shape, harness: "claude-code", device, agents: [] })).rejects.toThrow("handle taken");
    expect(loadAnswers("w1").agentId).toBeUndefined();
  });
  it("going back and changing the name or look updates the agent that was made", async () => {
    vi.mocked(api).mockResolvedValue({});
    const next = shapeOf("Atlas", "Help with my code", lookOf("#f2a04a", "tall"), "Sam");
    expect(await saveNamedAgent({ workspaceId: "w1", existing: juno, shape: next, harness: "claude-code", device, agents: [juno, { id: "x", handle: "atlas" }] })).toBe("a1");
    expect(api).toHaveBeenCalledExactlyOnceWith("PATCH", "/api/agents/a1", expect.objectContaining({ name: "Atlas", handle: "atlas-2", settings: { appearance: next.appearance, role: "Help with my code" } }));
  });
  it("changes nothing when nothing was changed", async () => {
    const same = shapeOf("Juno", "Keep my days on track", lookOf("#a98bf5", "classic"), "Sam");
    expect(await saveNamedAgent({ workspaceId: "w1", existing: juno, shape: same, harness: "claude-code", device, agents: [juno] })).toBe("a1");
    expect(api).not.toHaveBeenCalled();
  });
  it("Its AI points that same agent at what was chosen, installing a harness the device doesn't have", async () => {
    vi.mocked(api).mockResolvedValue({});
    await pointAgentAt({ id: "a1", name: "Juno", nodeId: "mac" }, device, "codex", "mc_1", []);
    expect(api).toHaveBeenCalledExactlyOnceWith("PATCH", "/api/agents/a1", { harness: "codex", settings: { connectionId: "mc_1" } });
    vi.mocked(api).mockClear();
    await pointAgentAt({ id: "a1", name: "Juno", nodeId: null }, device, "kimi", null, []);
    expect(api).toHaveBeenNthCalledWith(1, "POST", "/api/nodes/mac/install", { harness: "kimi" });
    expect(api).toHaveBeenLastCalledWith("PATCH", "/api/agents/a1", { harness: "kimi", nodeId: "mac", settings: { connectionId: null } });
  });
  it("gives it a computer of its own for an AI that only runs inside one", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "vm1" }).mockResolvedValueOnce({});
    const vmOnly = { ...device, harnesses: [], capabilities: { vm: { ok: true } } } as unknown as DeviceInfo;
    await pointAgentAt({ id: "a1", name: "Juno", nodeId: "mac" }, vmOnly, "hermes", "mc_1", []);
    expect(api).toHaveBeenNthCalledWith(1, "POST", "/api/computers", expect.objectContaining({ kind: "vm", nodeId: "mac" }));
    expect(api).toHaveBeenLastCalledWith("PATCH", "/api/agents/a1", { harness: "hermes", nodeId: "mac", computerId: "vm1", settings: { runIn: "computer", connectionId: "mc_1" } });
  });
});

describe("a failed sign-in does not finish", () => {
  const io = (answers: (method: string, path: string) => unknown) => ({ api: vi.fn(async (m: string, p: string) => answers(m, p)) as never, wait: async () => {}, now: () => 0 });
  const o = { agentId: "a1", harness: "claude-code", connectionId: "mc_1", deviceName: "My Mac" };
  it("says the AI isn't signed in, in one line, and is not ready", async () => {
    const r = await checkAI(o, () => true, () => {}, io(() => ({ signedIn: false })));
    expect(r).toEqual({ ok: false, problem: "Claude Code isn't signed in on My Mac yet." });
  });
  it("is not ready when its first real run can't sign in, and asks to sign in again", async () => {
    const r = await checkAI(o, () => true, () => {}, io((m) => (m === "GET" ? { signedIn: true } : { status: "signin" })));
    expect(r).toEqual({ ok: false, problem: "Claude Code needs signing in again.", resign: "claude-code" });
  });
  it("is not ready when it never starts", async () => {
    let t = 0;
    const r = await checkAI(o, () => true, () => {}, { api: vi.fn(async () => ({ signedIn: null })) as never, wait: async () => void (t += 60_000), now: () => t });
    expect(r).toEqual({ ok: false, problem: "Claude Code took too long to start." });
  });
  it("is ready only once its hello has been said", async () => {
    const stages: string[] = [];
    let greets = 0;
    const r = await checkAI(o, () => true, (s) => stages.push(s), io((m) => (m === "GET" ? { signedIn: true } : { status: ++greets < 3 ? "writing" : "sent" })));
    expect(r).toEqual({ ok: true });
    expect(stages).toEqual(["signin", "hello"]);
    expect(greets).toBe(3);
  });
  it("says nothing once nobody is waiting", async () => {
    expect(await checkAI(o, () => false, () => {}, io(() => ({ signedIn: true })))).toBeNull();
  });
});

describe("what's already signed in", () => {
  const conn = (over: Partial<ModelConnection>) => ({ id: "mc1", provider: "anthropic", kind: "oauth", harnesses: ["claude-code"], mine: true, lastError: null, ...over }) as ModelConnection;
  it("prefers a connection Bubble AI keeps, then a harness signed in on the computer", () => {
    expect(foundOn(device, [conn({})])).toEqual({ harness: "claude-code", connectionId: "mc1" });
    const signedIn = { ...device, harnesses: [{ id: "codex", version: null, accounts: { default: true } }] } as DeviceInfo;
    expect(foundOn(signedIn, [])).toEqual({ harness: "codex", connectionId: null, share: true });
    expect(foundOn(device, [])).toBeNull();
    expect(foundOn(undefined, [])).toBeNull();
  });
  it("finds each AI's own sign-in, so ChatGPT uses Codex's even when Claude Code is signed in too", () => {
    const both = { ...device, harnesses: [{ id: "claude-code", version: null, accounts: { default: true } }, { id: "codex", version: null, accounts: { default: true } }] } as DeviceInfo;
    expect(foundOn(both, [])).toEqual({ harness: "claude-code", connectionId: null });
    expect(foundOn(both, [], "codex")).toEqual({ harness: "codex", connectionId: null, share: true });
    expect(foundOn(both, [conn({})], "codex")).toEqual({ harness: "codex", connectionId: null, share: true });
    expect(foundOn(device, [], "codex")).toBeNull();
  });
  it("offers to ask Claude Code or Codex only on your own computer, where they're installed, connected ones first", () => {
    const mac = { ...device, harnesses: [{ id: "claude-code", version: null }, { id: "codex", version: null }, { id: "hermes", version: null }] } as DeviceInfo;
    expect(askableOn(mac, [{ harness: "codex", connectionId: "mc2" }])).toEqual([
      { harness: "codex", nodeId: "mac", device: "My Mac" },
      { harness: "claude-code", nodeId: "mac", device: "My Mac" },
    ]);
    expect(askableOn({ ...mac, harnesses: [{ id: "hermes", version: null }] } as DeviceInfo, [])).toEqual([]);
    expect(askableOn({ ...mac, mine: false }, [{ harness: "claude-code", connectionId: "mc1" }])).toEqual([]);
  });
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

describe("making an agent on a device", () => {
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
  it("lets Bubble AI place an installed harness (the shared computer), without moving its sign-in", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "agent" });
    const ready = { ...device, capabilities: { vm: { ok: true } } } as DeviceInfo;
    await makeFirstAgent(ready, "codex", "Atlas", [], []);
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/agents", expect.objectContaining({ nodeId: "mac", useDefaults: true }));
  });
  it("puts the agent on the model connection Bubble AI keeps, so its first message needs no other sign-in", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "agent" });
    await makeFirstAgent(device, "codex", "Atlas", [], [], undefined, "mc_1");
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/agents", expect.objectContaining({ useDefaults: true, settings: { connectionId: "mc_1" } }));
  });
  it("gives an agent in its own computer the connection too", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "vm1" }).mockResolvedValueOnce({ id: "agent" });
    const vmOnly = { ...device, harnesses: [], capabilities: { vm: { ok: true } } } as unknown as DeviceInfo;
    await makeFirstAgent(vmOnly, "hermes", "Atlas", [], [], undefined, "mc_1");
    expect(api).toHaveBeenLastCalledWith("POST", "/api/agents", expect.objectContaining({ computerId: "vm1", settings: { runIn: "computer", connectionId: "mc_1" } }));
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

describe("Introduce yourself: your first message", () => {
  it("is written from the picks, in the person's own voice, and ends with the talk style and check-ins", () => {
    expect(introMessage("Juno", "Sam Lee", ["days", "msgs"], "I work weekends and I’m training for a half marathon", "friendly", "morning")).toBe(
      "Hi Juno, I'm Sam. I'd like help keeping my days on track and staying on top of my messages. About me: I work weekends and I’m training for a half marathon. Keep it friendly, and check in each morning.",
    );
    expect(introMessage("Juno", "Sam", ["money"], "", "short", "evening")).toBe("Hi Juno, I'm Sam. I'd like help keeping an eye on money and bills. Keep it short, and check in each evening.");
    expect(introMessage("Juno", "", [], "", "thorough", "needed")).toBe("Hi Juno. I'm not sure yet what I'd like help with. Be thorough, and only check in when it matters.");
  });
  it("shows that message on the right as yours, and the button sends it to the agent", () => {
    const html = renderToStaticMarkup(
      createElement(YoursStep, { name: "Juno", person: "Sam", goals: ["days"], onGoals: () => {}, about: "", onAbout: () => {}, talk: "friendly", onTalk: () => {}, when: "morning", onWhen: () => {}, onNext: () => {} }),
    );
    expect(html).toContain("Introduce yourself to Juno");
    expect(html).toContain("Tap what fits. It becomes your first message.");
    for (const t of ["I’d like help with", "About me", "Talk to me", "Check in"]) expect(html).toContain(t);
    expect(html).toMatch(/class="bubble me[^"]*" data-testid="intro-message">Hi Juno, I&#x27;m Sam\. I&#x27;d like help keeping my days on track\. Keep it friendly, and check in each morning\.</);
    expect(html).toContain("Send to Juno");
    expect(html).not.toContain("Make it yours");
  });
});

describe("Use Bubble AI away from home", () => {
  const info = (state: AccessInfo["tailscale"]["state"], extra: Partial<AccessInfo> = {}, serving = false): AccessInfo =>
    ({ publicUrl: null, lan: [], download: "https://tailscale.com/download/mac", hubPlatform: "darwin", tailscale: { state, dnsName: "sam-mac.tail3e1.ts.net.", serving, funnel: false }, ...extra }) as AccessInfo;
  const home = { protocol: "http:", hostname: "127.0.0.1" };
  it("shows for the owner of a hub at home with no away address, and never for a cloud server", () => {
    expect(awayStepWanted({ owner: true, info: info("missing"), failed: false, loc: home })).toBe(true);
    expect(awayStepWanted({ owner: true, info: null, failed: false, loc: { protocol: "http:", hostname: "192.168.1.20" } })).toBe(true);
    expect(awayStepWanted({ owner: false, info: info("missing"), failed: false, loc: home })).toBe(false);
    // an older hub with no reach API
    expect(awayStepWanted({ owner: true, info: null, failed: true, loc: home })).toBe(false);
    // already on
    expect(awayStepWanted({ owner: true, info: info("running", { publicUrl: "https://sam-mac.tail3e1.ts.net" }, true), failed: false, loc: home })).toBe(false);
    // a cloud server opened at its public IP or a domain already has an address
    expect(awayStepWanted({ owner: true, info: info("missing"), failed: false, loc: { protocol: "http:", hostname: "203.0.113.9" } })).toBe(false);
    expect(awayStepWanted({ owner: true, info: info("missing"), failed: false, loc: { protocol: "https:", hostname: "bubble.example.com" } })).toBe(false);
  });
  it("ticks each part as Tailscale reports it", () => {
    expect(awayTicks(info("missing"))).toEqual({ installed: false, signedIn: false, on: false });
    expect(awayTicks(info("needs-login"))).toEqual({ installed: true, signedIn: false, on: false });
    expect(awayTicks(info("running"))).toEqual({ installed: true, signedIn: true, on: false });
    expect(awayTicks(info("running", { publicUrl: "https://sam-mac.tail3e1.ts.net" }, true))).toEqual({ installed: true, signedIn: true, on: true });
  });
  it("has the three rows, the phone note, Continue and Only at home for now", () => {
    const html = renderToStaticMarkup(createElement(AwayStep, { onDone: () => {} }));
    for (const t of ["Use Bubble AI away from home", "Install Tailscale on this", "Sign in to Tailscale", "Turn on your address", "Put Tailscale on your phone too, with the same account.", "Only at home for now"]) expect(html).toContain(t);
    expect(html).toMatch(/<button type="button" disabled="" class="ob-primary[^"]*">Continue<\/button>/);
  });
});

describe("Introduce yourself: what the agent hears", () => {
  it("puts the picks and the about-you text in plain words", () => {
    expect(picksMessage(["days", "people"], "I'm a student and I work weekends.")).toBe("I'd like help keeping my days on track and remembering the people I care about. About me: I'm a student and I work weekends.");
    expect(picksMessage(["business"], "  ")).toBe("I'd like help running my business.");
    expect(picksMessage([], "")).toBe("I'm not sure yet what I'd like help with.");
  });
  it("puts the about-you text, the talk style and the check-ins in its instructions", () => {
    const s = yoursInstructions("Tony", "Yug Patel", ["days"], "short", "needed", "I love hiking");
    expect(s).toContain("keeping my days on track");
    expect(s).toContain('About Yug, in their words: "I love hiking."');
    expect(s).toContain("Keep messages short");
    expect(s).toContain("Only message Yug when something matters.");
  });
});
