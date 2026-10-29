import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { HarnessLogins, findLink, withheld } from "../../node/src/harness-login.ts";
import { ModelLogins } from "../../node/src/model-login.ts";

const waitFor = async <T>(fn: () => T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

describe("harness sign-ins", () => {
  it("finds the link and code device sign-ins print", () => {
    expect(findLink("\u001b[1mFollow these steps\u001b[0m\n1. Open https://auth.openai.com/codex/device\n2. Enter this one-time code: ABCD-1234\n")).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-1234" });
    expect(findLink("Visit https://example.com/activate?user_code=WDJB-MJHT.")).toEqual({ url: "https://example.com/activate?user_code=WDJB-MJHT", code: "WDJB-MJHT" });
    expect(findLink("Paste code here if prompted >")).toEqual({ url: undefined, code: undefined });
  });

  it("runs the sign-in with the account's folder, takes a pasted code, and reports how it ended", async () => {
    const done: string[] = [];
    const logins = new HarnessLogins((l) => done.push(l.status));
    const script = `console.log("Open https://claude.ai/oauth?x=1 then paste the code:"); process.stdin.once("data", (d) => { console.log("got " + d.toString().trim() + " in " + process.env.CLAUDE_CONFIG_DIR); process.exit(d.toString().trim() === "secret-code" ? 0 : 1); });`;
    const l = logins.start("claude-code", "work", { command: process.execPath, args: ["-e", script], env: { CLAUDE_CONFIG_DIR: "/tmp/acct" } });
    expect(l.status).toBe("running");
    await waitFor(() => logins.status(l.id).url);
    expect(logins.status(l.id).url).toBe("https://claude.ai/oauth?x=1");
    logins.input(l.id, "secret-code\n");
    const end = await waitFor(() => (logins.status(l.id).status !== "running" ? logins.status(l.id) : undefined));
    expect(end.status).toBe("done");
    expect(end.output).toContain("got secret-code in /tmp/acct");
    expect(done).toEqual(["done"]);
  });

  it("can be cancelled, and a failed one says why", async () => {
    const logins = new HarnessLogins();
    const slow = logins.start("codex", "a", { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], env: {} });
    logins.cancel(slow.id);
    expect(logins.status(slow.id)).toMatchObject({ status: "failed", error: "Cancelled." });
    const bad = logins.start("codex", "b", { command: process.execPath, args: ["-e", "console.error('Error: not allowed'); process.exit(2)"], env: {} });
    const end = await waitFor(() => (logins.status(bad.id).status !== "running" ? logins.status(bad.id) : undefined));
    expect(end).toMatchObject({ status: "failed", error: "Error: not allowed" });
    expect(() => logins.status("login_nope")).toThrow(/isn't running/);
  });

  it("keeps a printed token out of what people see, but hands it to whoever asked", async () => {
    let raw = "";
    const changes: string[] = [];
    const logins = new HarnessLogins();
    // a terminal link (OSC 8, ended with ESC \\) around the address, then the token Claude's setup-token prints
    const script = `process.stdout.write("\\u001b]8;;https://claude.com/x\\u001b\\\\https://claude.com/cai/oauth/authorize?code=true\\u001b]8;;\\u001b\\\\\\n"); setTimeout(() => { console.log("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123"); process.exit(0); }, 50);`;
    const l = logins.start("claude-code", "model-x", { command: process.execPath, args: ["-e", script], env: {} }, 60_000, { redact: /sk-ant-oat\d*-[A-Za-z0-9_-]+/, onRaw: (t) => (raw += t), onChange: (s) => changes.push(s.url ?? "") });
    const end = await waitFor(() => (logins.status(l.id).status !== "running" ? logins.status(l.id) : undefined));
    expect(end.status).toBe("done");
    expect(end.url).toBe("https://claude.com/cai/oauth/authorize?code=true");
    expect(end.output).not.toContain("sk-ant-oat01");
    expect(end.output).toContain("[saved]");
    expect(raw).toContain("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123");
    expect(changes).toEqual(["https://claude.com/cai/oauth/authorize?code=true"]);
  });

  it("keeps a token out even when it's printed across several chunks", async () => {
    const seen: string[] = [];
    const logins = new HarnessLogins();
    // the token comes in three writes, split mid-prefix and mid-secret
    const script = `const w = (t, ms) => new Promise((r) => setTimeout(() => { process.stdout.write(t); r(); }, ms)); (async () => { await w("Your token: sk-an", 30); await w("t-oat01-FIRSTHALFsecret", 60); await w("SECONDHALFsecret\\nDone\\n", 60); process.exit(0); })();`;
    const l = logins.start("claude-code", "model-split", { command: process.execPath, args: ["-e", script], env: {} }, 60_000, { redact: /sk-ant-oat\d*-[A-Za-z0-9_-]+/, redactStart: "sk-ant-oat", onChange: () => {} });
    const poll = setInterval(() => seen.push(logins.status(l.id).output), 5);
    const end = await waitFor(() => (logins.status(l.id).status !== "running" ? logins.status(l.id) : undefined));
    clearInterval(poll);
    seen.push(end.output);
    for (const o of seen) {
      expect(o).not.toContain("SECONDHALF");
      expect(o).not.toContain("FIRSTHALF");
    }
    expect(end.output).toBe("Your token: [saved]\nDone\n");
  });

  it("holds back what could be the start of a token until it's clear", () => {
    const re = /sk-ant-oat\d*-[A-Za-z0-9_-]+/;
    expect(withheld("Your token: sk-an", re, "sk-ant-oat")).toBe("Your token: ");
    expect(withheld("Your token: sk-ant-oat01-", re, "sk-ant-oat")).toBe("Your token: ");
    expect(withheld("Your token: [saved]", re, "sk-ant-oat")).toBe("Your token: [saved]");
    expect(withheld("thanks", re, "sk-ant-oat")).toBe("thanks");
  });

  it("removes sign-in scratch folders when the device stops", () => {
    const logins = new ModelLogins(() => {});
    logins.start("ml_1", "anthropic", "claude-code", process.execPath);
    const dirs = logins.scratch;
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(dirs[0])).toBe(true);
    logins.stopAll();
    expect(fs.existsSync(dirs[0])).toBe(false);
    expect(logins.scratch).toEqual([]);
  });
});
