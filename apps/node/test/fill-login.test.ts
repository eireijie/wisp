import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FILL_LOGIN_SCRIPT } from "../src/computers/fill-login.ts";
import { exec } from "../src/computers/driver.ts";

// the VMs' fill script against a real (headless) Chrome, where this machine has one
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const PORT = 9341;

const PAGES: Record<string, string> = {
  "/form": `<form id="f"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>
    <script>document.getElementById("f").onsubmit = (e) => { e.preventDefault(); window.got = { email: e.target.email.value, password: e.target.password.value }; };</script>`,
  // a page that keeps its own state from input events (like React) and has no form
  "/app": `<input id="u" autocomplete="username"><input id="p" type="password"><button id="go">Log in</button>
    <script>const s = {}; u.oninput = () => (s.u = u.value); p.oninput = () => (s.p = p.value); go.onclick = () => (window.got = { ...s });</script>`,
  // the first of two pages: only the username
  "/step1": `<form id="f"><input name="identifier" type="email" placeholder="Email"><button>Next</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); window.got = { email: f.identifier.value }; };</script>`,
  "/none": `<h1>Hello</h1>`,
  // a page (or an agent before the fill) that swaps out the value setter to catch what's typed
  "/hijack": `<form id="f"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>
    <script>const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    Object.defineProperty(HTMLInputElement.prototype, "value", { get: d.get, set(v) { (window.stolen ||= []).push(v); d.set.call(this, v); } });
    f.onsubmit = (e) => e.preventDefault();</script>`,
  // a password box with nothing to press
  "/nobutton": `<input name="email" type="email"><input name="password" type="password">`,
};

let server: http.Server;
let chrome: ChildProcess;
let profile: string;

const cdp = `http://127.0.0.1:${PORT}`;
async function evalIn(expression: string) {
  const pages = (await (await fetch(`${cdp}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(pages.find((p) => p.type === "page")!.webSocketDebuggerUrl);
  return new Promise<unknown>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    ws.onmessage = (m) => {
      const r = JSON.parse(String(m.data));
      if (r.id === 1) (ws.close(), resolve(r.result?.result?.value));
    };
  });
}
async function goTo(p: string) {
  await evalIn(`location.href = "http://localhost:${(server.address() as { port: number }).port}${p}"`);
  for (let i = 0; i < 50 && (await evalIn("location.pathname + document.readyState").catch(() => "")) !== `${p}complete`; i++) await new Promise((r) => setTimeout(r, 100));
}
async function fill(login: { site: string; username: string; password: string; otp?: string }) {
  const r = await exec(process.execPath, ["--input-type=module", "-e", FILL_LOGIN_SCRIPT], { input: JSON.stringify(login), env: { CDP: cdp, CLEAR_AFTER_MS: "300" }, timeoutMs: 20_000 });
  return JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
}

describe.skipIf(!CHROME)("filling a login in Chrome", () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => res.end(`<!doctype html><html><body>${PAGES[req.url ?? ""] ?? ""}</body></html>`));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-fill-"));
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${cdp}/json/version`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20_000);
  afterAll(async () => {
    const gone = new Promise((r) => chrome?.once("exit", r));
    chrome?.kill();
    await gone;
    server?.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  it("fills the username and password, signs in, and empties the box when the page doesn't move on", async () => {
    await goTo("/form");
    expect(await fill({ site: "localhost", username: "bot@shop.test", password: "s3cret!" })).toEqual({ filled: ["username", "password"], submitted: true, cleared: true });
    expect(await evalIn("window.got")).toEqual({ email: "bot@shop.test", password: "s3cret!" });
    expect(await evalIn("document.querySelector('input[type=password]').value")).toBe("");
  }, 20_000);

  it("doesn't call a value setter the page swapped in", async () => {
    await goTo("/hijack");
    expect(await fill({ site: "localhost", username: "bot", password: "s3cret!" })).toMatchObject({ filled: ["username", "password"], submitted: true });
    expect(await evalIn("window.stolen ?? null")).toBeNull();
  }, 20_000);

  it("empties the password right away when there's no sign-in button", async () => {
    await goTo("/nobutton");
    expect(await fill({ site: "localhost", username: "bot", password: "s3cret!" })).toEqual({ filled: ["username", "password"], submitted: false, cleared: true, problem: "there's no sign-in button to press" });
    expect(await evalIn("document.querySelector('input[type=password]').value")).toBe("");
  }, 20_000);

  it("works on pages that keep their own state and have no form", async () => {
    await goTo("/app");
    expect(await fill({ site: "localhost", username: "bot", password: "pw" })).toEqual({ filled: ["username", "password"], submitted: true, cleared: true });
    expect(await evalIn("window.got")).toEqual({ u: "bot", p: "pw" });
  }, 20_000);

  it("fills only the username on a username-first page", async () => {
    await goTo("/step1");
    expect(await fill({ site: "localhost", username: "bot@shop.test", password: "pw" })).toEqual({ filled: ["username"], submitted: true });
    expect(await evalIn("window.got")).toEqual({ email: "bot@shop.test" });
  }, 20_000);

  it("fills nothing on another site's page", async () => {
    await goTo("/form");
    expect(await fill({ site: "zendesk.com", username: "bot", password: "pw" })).toEqual({ filled: [], submitted: false, wrongSite: "localhost" });
    expect(await evalIn("document.querySelector('input[type=password]').value")).toBe("");
  }, 20_000);

  it("says so when there's nothing to fill", async () => {
    await goTo("/none");
    expect(await fill({ site: "localhost", username: "bot", password: "pw" })).toMatchObject({ filled: [], problem: "there are no sign-in boxes on the page" });
  }, 20_000);
});
