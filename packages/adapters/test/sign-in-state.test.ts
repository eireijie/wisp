import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessAccounts, SIGN_IN_STATUS, claudeUsage, loginCommand, readHarnessSettings } from "../src/index.ts";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-signin-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const accounts = () => new HarnessAccounts(path.join(home, ".wisp"), { home });

describe("asking a harness whether it's signed in", () => {
  it("asks Claude Code when its files show no login, instead of leaving it unknown or signed out", async () => {
    const yes = vi.fn(async () => true);
    expect((await accounts().listChecked("claude-code", undefined, yes))[0].signedIn).toBe(true);
    expect(yes).toHaveBeenCalledWith("claude-code", "claude", {});
    expect((await accounts().listChecked("claude-code", undefined, async () => false))[0].signedIn).toBe(false);
  });
  it("doesn't ask when the files already show a login", async () => {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude/.credentials.json"), "{}");
    const probe = vi.fn(async () => false);
    expect((await accounts().listChecked("claude-code", undefined, probe))[0].signedIn).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
  it("keeps an answer for a moment, and forgets it after a sign-in", async () => {
    const a = accounts();
    const probe = vi.fn(async () => false);
    await a.listChecked("claude-code", undefined, probe);
    await a.listChecked("claude-code", undefined, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    a.forgetChecks();
    await a.listChecked("claude-code", undefined, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("reads the status commands' answers", () => {
    const claude = SIGN_IN_STATUS["claude-code"].read;
    expect(claude('{"loggedIn":true}', 0, "")).toBe(true);
    expect(claude('{"loggedIn":false,"authMethod":"none"}', 1, "")).toBe(false);
    expect(claude("", 1, "error: unknown command 'auth'")).toBeNull();
    const codex = SIGN_IN_STATUS.codex.read;
    expect(codex("Logged in using ChatGPT", 0, "")).toBe(true);
    expect(codex("", 1, "Not logged in")).toBe(false);
    expect(codex("", 2, "boom")).toBeNull();
  });
  it("counts Qwen's own sign-in, and stays unknown (never no) without one", async () => {
    expect(accounts().list("qwen")[0].signedIn).toBeNull();
    fs.mkdirSync(path.join(home, ".qwen"));
    fs.writeFileSync(path.join(home, ".qwen/oauth_creds.json"), "{}");
    expect(accounts().list("qwen")[0].signedIn).toBe(true);
  });
  it("gives every harness with a sign-in command a way to sign in, not an error", () => {
    expect(loginCommand("opencode")).toEqual({ manual: ["opencode auth login"] });
    expect(loginCommand("cursor")).toEqual({ manual: ["cursor-agent login"] });
  });
});

describe("a sign-in that expired", () => {
  const expired = (refreshToken?: string) => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: Date.now() - 60_000, ...(refreshToken ? { refreshToken } : {}) } }));
  };
  it("counts a Claude Code login that expired with nothing to renew it as signed out", () => {
    expired();
    expect(accounts().list("claude-code")[0].signedIn).toBe(false);
  });
  it("still counts an expired one that can be renewed as signed in (Claude Code renews it itself)", () => {
    expired("r");
    expect(accounts().list("claude-code")[0].signedIn).toBe(true);
  });
  it("shows signed out after a run was turned away, though the harness's status still says signed in", async () => {
    const a = accounts();
    const yes = vi.fn(async () => true);
    expect((await a.listChecked("claude-code", undefined, yes))[0].signedIn).toBe(true);
    a.markSignedOut("claude-code", "default");
    // a new HarnessAccounts too: the device restarting doesn't forget it
    expect((await accounts().listChecked("claude-code", undefined, yes))[0].signedIn).toBe(false);
    expect(a.markWorked("claude-code", "default")).toBe(true);
    expect(a.markWorked("claude-code", "default")).toBe(false);
    a.forgetChecks();
    expect((await a.listChecked("claude-code", undefined, yes))[0].signedIn).toBe(true);
  });
  it("asks again once someone signs in, through Wisp or by changing its login files", async () => {
    expired("r");
    const a = accounts();
    a.markSignedOut("claude-code", "default");
    expect((await a.listChecked("claude-code"))[0].signedIn).toBe(false);
    // signed in again in a terminal: the login file changed
    fs.utimesSync(path.join(home, ".claude/.credentials.json"), new Date(), new Date(Date.now() + 5000));
    expect((await a.listChecked("claude-code"))[0].signedIn).toBe(true);
    a.markSignedOut("claude-code", "default");
    a.forgetChecks("claude-code");
    expect((await a.listChecked("claude-code"))[0].signedIn).toBe(true);
  });
});

describe("what a signed-out harness shows", () => {
  it("never reports Claude Code's <synthetic> as a model (W-18)", () => {
    const u = claudeUsage({ message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }, null);
    expect(u?.model).toBeUndefined();
  });
  it("isn't an error when a harness was installed but never set up (W-57)", async () => {
    const s = await readHarnessSettings("hermes", { home });
    expect(s.error).toBeUndefined();
    expect(s.model).toBeNull();
  });
});
