import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("never takes a piece of a link as the code (Claude Code's sign-in link is full of \"code\")", () => {
    // what `claude auth login` really prints: a link to open, then it waits for a pasted code
    const claude = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=19RssOz1P5Z48SUsKO0JJoqkCUH-U0lNqyi9gZStE0s&code_challenge_method=S256&state=iRQhHCchw9eXQlsft2AJFoHwj8qYUxU53hOaGZi2PKg\nPaste code here if prompted > ";
    const found = findLink(claude);
    expect(found.code).toBeUndefined();
    expect(found.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&.*state=iRQhHCchw9eXQlsft2AJFoHwj8qYUxU53hOaGZi2PKg$/);
    // a link with an upper-case "code" piece in it isn't a code either
    expect(findLink("Open https://x.example/oauth?code=AB12CD34EF&redirect=%2FCODE%2FCALLBACK1 and paste the code").code).toBeUndefined();
  });

  it("reads Codex's device sign-in as it really prints it (colors, code on the line under the word)", () => {
    const codex = "\nWelcome to Codex [v\u001b[90m0.162.1\u001b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94m7O27-5PWBT\u001b[0m\n";
    const clean = codex.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    expect(findLink(clean)).toEqual({ url: "https://auth.openai.com/codex/device", code: "7O27-5PWBT" });
  });

  it("reads other device sign-ins: a code after \"code:\", one only in the link, and a plain one", () => {
    expect(findLink("Please visit https://www.kimi.com/device and enter the code: KQ7M-2XRP")).toEqual({ url: "https://www.kimi.com/device", code: "KQ7M-2XRP" });
    expect(findLink("Open https://accounts.x.ai/oauth2/device?user_code=HXQ4P9TR to sign in")).toEqual({ url: "https://accounts.x.ai/oauth2/device?user_code=HXQ4P9TR", code: "HXQ4P9TR" });
    expect(findLink("Your code is 5JX9QK2M\nGo to https://cursor.com/login")).toEqual({ url: "https://cursor.com/login", code: "5JX9QK2M" });
    // words and numbers near "code" aren't codes
    expect(findLink("Waiting for the code (expires in 900 seconds)…").code).toBeUndefined();
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-scratch-"));
    const logins = new ModelLogins(() => {}, root);
    logins.start("ml_1", "anthropic", "claude-code", process.execPath);
    const dirs = logins.scratch;
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(dirs[0])).toBe(true);
    logins.stopAll();
    expect(fs.existsSync(dirs[0])).toBe(false);
    expect(logins.scratch).toEqual([]);
  });

  it("removes a scratch folder a crash left behind, with the sign-in in it, when the device starts again", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-scratch-"));
    const left = path.join(root, "login-crashed", "auth.json");
    fs.mkdirSync(path.dirname(left));
    fs.writeFileSync(left, '{"tokens":{"refresh_token":"left-behind"}}');
    new ModelLogins(() => {}, root);
    expect(fs.existsSync(left)).toBe(false);
  });

  it("keeps scratch folders inside its own root, not the shared temp folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-scratch-"));
    const logins = new ModelLogins(() => {}, root);
    logins.start("ml_2", "anthropic", "claude-code", process.execPath);
    expect(logins.scratch[0].startsWith(root + path.sep)).toBe(true);
    logins.stopAll();
  });
});
