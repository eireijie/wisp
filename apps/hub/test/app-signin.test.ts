import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { normalizeTokens } from "../src/app-signin.ts";
import * as relay from "../../../site/functions/_relay.ts";

/**
 * One-click sign-in through Bubble AI's app with Google, GitHub and Slack, run end to end through the
 * real relay code (site/functions/_relay.ts) with the companies faked.
 */

const RELAY = "https://relay.test";
const relayEnv: relay.Env = { GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "g-secret", GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret" };
const seen: { url: string; form: URLSearchParams }[] = [];

/** The companies' token endpoints. */
const company: typeof fetch = async (input, init) => {
  const url = String(input);
  const form = new URLSearchParams(String(init?.body ?? ""));
  seen.push({ url, form });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === relay.TOKEN_URL.google) {
    if (form.get("client_secret") !== "g-secret") return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code" && form.get("code") === "good" && form.get("code_verifier")) return json(200, { access_token: "g-at1", refresh_token: "g-rt1", expires_in: 60, token_type: "Bearer", scope: "gmail.readonly calendar.readonly" });
    if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "g-rt1") return json(200, { access_token: "g-at2", expires_in: 3600, token_type: "Bearer" });
    return json(400, { error: "invalid_grant" });
  }
  if (url === relay.TOKEN_URL.github) return json(200, form.get("code") === "good" ? { access_token: "gh-at", token_type: "bearer", scope: "repo" } : { error: "bad_verification_code" });
  return json(404, {});
};

/** What the hub reaches: the relay (running its real code) and nothing else. */
const hubFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === `${RELAY}/api/oauth/apps`) return new Response(JSON.stringify(relay.apps(relayEnv)), { headers: { "content-type": "application/json" } });
  if (url === `${RELAY}/api/oauth/token`) return relay.token(new Request(url, init as RequestInit), relayEnv, company);
  throw new Error(`the hub called ${url}`);
};

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let agentId: string;
const before = process.env.BUBBLE_SIGNIN_RELAY;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T; cookie: string }> {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  // the browser that starts a sign-in keeps this cookie and sends it back with the callback
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T, cookie };
}

/** The browser that started the sign-in coming back. */
const sameBrowser = (url: string, cookie: string) => fetch(url, { redirect: "manual", headers: { cookie } });

beforeAll(async () => {
  process.env.BUBBLE_SIGNIN_RELAY = RELAY;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-app-signin-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  hub.connectors.auth.fetchFn = hubFetch;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await (await fetch(base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json()).token;
  const { node } = (await api("POST", "/api/nodes", { name: "box" })).data;
  agentId = (await api("POST", "/api/agents", { handle: "dot", name: "Dot", harness: "claude-code", nodeId: node.id })).data.id;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
  if (before === undefined) delete process.env.BUBBLE_SIGNIN_RELAY;
  else process.env.BUBBLE_SIGNIN_RELAY = before;
});

describe("which apps can sign in from here", () => {
  it("offers Sign in where it works and says why where it doesn't", async () => {
    const here = (await api("GET", `/api/connectors/sign-in?origin=${encodeURIComponent(base)}`)).data;
    expect(here.gmail).toMatchObject({ signIn: true, key: false, reads: "Reads and searches your email" });
    expect(here.github).toMatchObject({ signIn: true, key: true });
    // the relay has no Slack app yet
    expect(here.slack.signIn).toBe(false);
    expect(here.slack.reason).toMatch(/Signing in with Slack is coming soon/);
    // MCP sign-ins come back to this computer fine
    expect(here.notion.signIn).toBe(true);
    expect(here.vercel.signIn).toBe(true);

    const lan = (await api("GET", `/api/connectors/sign-in?origin=${encodeURIComponent("http://192.168.1.5:8787")}`)).data;
    expect(lan.notion).toMatchObject({ signIn: false, key: true });
    expect(lan.notion.reason).toMatch(/a plain http address on your home network/);
    expect(lan.vercel.reason).toMatch(/on this computer/);
    // Google goes through the relay, so the hub's own address doesn't matter
    expect(lan.gmail.signIn).toBe(true);
    const https = (await api("GET", `/api/connectors/sign-in?origin=${encodeURIComponent("https://wisp.example.ts.net")}`)).data;
    expect(https.notion.signIn).toBe(true);
    expect(https.vercel.signIn).toBe(false);
  });

  it("won't start an MCP sign-in that can't come back", async () => {
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["notion"], origin: "http://192.168.1.5:8787" });
    expect(r.status).toBe(409);
    expect((await api<any[]>("GET", "/api/connectors")).data.some((c) => c.catalogId === "notion")).toBe(false);
  });
});

describe("signing in with Google through the relay", () => {
  it("connects Gmail and Calendar with one sign-in, keeps the tokens on the hub, and refreshes them", async () => {
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["gmail", "gcal"], origin: base, returnTo: "close", agentIds: [agentId] });
    expect(r.status).toBe(200);
    expect(r.data.connectors.map((c: any) => [c.name, c.url])).toEqual([
      ["Gmail", "https://gmailmcp.googleapis.com/mcp/v1"],
      ["Google Calendar", "https://calendarmcp.googleapis.com/mcp/v1"],
    ]);
    const to = new URL(r.data.url);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("client_id")).toBe("g-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${RELAY}/oauth/callback`);
    // read-only scopes, both apps in one go
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("access_type")).toBe("offline");
    const state = to.searchParams.get("state")!;
    expect(relay.hubFromState(state)?.origin).toBe(base);
    // the sign-in link holds no secret
    expect(r.data.url).not.toContain("g-secret");

    // Google sends the browser to the relay, which sends it straight on to a hub on this computer
    const atRelay = relay.callback(new Request(`${RELAY}/oauth/callback?code=good&state=${encodeURIComponent(state)}&scope=x`));
    expect(atRelay.status).toBe(302);
    const next = atRelay.headers.get("location")!;
    expect(next).toBe(`${base}/api/connectors/app/callback?code=good&state=${encodeURIComponent(state)}`);

    // the sign-in was started in this browser: it finishes without asking
    expect(r.cookie).toMatch(/^wisp_signin_[0-9a-f]{16}=/);
    const back = await sameBrowser(next, r.cookie);
    expect(back.status).toBe(200);
    expect(back.headers.get("set-cookie")).toContain("Max-Age=0");
    const page = await back.text();
    expect(page).toContain("Signed in to Gmail and Google Calendar");
    expect(page).not.toContain("g-at1");

    const [gmail, gcal] = r.data.connectors;
    for (const c of [gmail, gcal]) expect((await api("GET", `/api/connectors/${c.id}`)).data.auth).toEqual({ required: true, signedIn: true, error: null });
    // the relay added the secret, and the hub's verifier went with the code
    const exchange = seen.find((s) => s.form.get("grant_type") === "authorization_code")!;
    expect(exchange.form.get("client_secret")).toBe("g-secret");
    expect(exchange.form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // agents get the token with their run; people never see it
    const specs = hub.connectors.specsFor(agentId);
    expect(specs.map((s) => [s.name, s.headers])).toEqual([
      ["gmail", { Authorization: "Bearer g-at1" }],
      ["google-calendar", { Authorization: "Bearer g-at1" }],
    ]);
    expect(JSON.stringify((await api("GET", "/api/connectors")).data)).not.toContain("g-at1");

    // it runs out within 5 minutes: refreshed through the relay before the next run
    await hub.connectors.prepare(agentId);
    expect(hub.connectors.specsFor(agentId)[0].headers).toEqual({ Authorization: "Bearer g-at2" });
    expect(seen.filter((s) => s.form.get("grant_type") === "refresh_token")).toHaveLength(2);

    // a used or made-up state goes nowhere
    const again = await sameBrowser(next, r.cookie);
    expect(decodeURIComponent(again.headers.get("location")!)).toContain("expired");

    // signing in to Gmail again reuses the connector
    const re = await api("POST", "/api/connectors/connect", { catalogIds: ["gmail"], origin: base });
    expect(re.data.connectors[0].id).toBe(gmail.id);
  });

  it("keeps the sign-in when a refresh fails for a while, and ends it only when the company says no", async () => {
    const gmail = (await api<any[]>("GET", "/api/connectors")).data.find((c) => c.catalogId === "gmail");
    const db = (hub.connectors.auth as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    const runOut = () => db.prepare("UPDATE connector_auth SET expires_at = ? WHERE connector_id = ?").run(new Date(Date.now() - 1000).toISOString(), gmail.id);
    runOut();
    hub.connectors.auth.fetchFn = async () => {
      throw new Error("relay unreachable");
    };
    try {
      await hub.connectors.auth.fresh(gmail.id, gmail.url);
    } finally {
      hub.connectors.auth.fetchFn = hubFetch;
    }
    expect(hub.connectors.auth.accessToken(gmail.id)).toBe("g-at2");
    expect((await api("GET", `/api/connectors/${gmail.id}`)).data.auth.error).toMatch(/^Couldn't renew the sign-in yet/);

    // Google refuses the refresh token: signed out, with the reason
    db.prepare("UPDATE connector_auth SET tokens_json = ? WHERE connector_id = ?").run(JSON.stringify({ access_token: "g-at2", refresh_token: "revoked" }), gmail.id);
    runOut();
    await hub.connectors.auth.fresh(gmail.id, gmail.url);
    expect(hub.connectors.auth.accessToken(gmail.id)).toBeNull();
    expect((await api("GET", `/api/connectors/${gmail.id}`)).data.auth).toMatchObject({ signedIn: false, error: expect.stringMatching(/^Signed out: Google said no/) });
  });

  it("notes a cancelled sign-in on the connector", async () => {
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["github"], origin: base, returnTo: "#/onboarding" });
    const state = new URL(r.data.url).searchParams.get("state")!;
    const back = await fetch(`${base}/api/connectors/app/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(back.headers.get("location")).toBe(`/?signin=${encodeURIComponent("Sign-in was cancelled.")}#/onboarding`);
    const conn = (await api("GET", `/api/connectors/${r.data.connectors[0].id}`)).data;
    expect(conn.auth).toEqual({ required: true, signedIn: false, error: "Sign-in was cancelled." });
    // GitHub's server is asked to stay read-only
    expect(conn.headers).toEqual({ "X-MCP-Readonly": "true" });
  });

  it("signs in to GitHub from the Connected apps page again, through the same app", async () => {
    const conn = (await api<any[]>("GET", "/api/connectors")).data.find((c) => c.catalogId === "github");
    const r = await api("POST", `/api/connectors/${conn.id}/signin`, { origin: base });
    const to = new URL(r.data.url);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("repo read:org read:user notifications");
    const next = relay.callback(new Request(`${RELAY}/oauth/callback?code=good&state=${encodeURIComponent(to.searchParams.get("state")!)}`)).headers.get("location")!;
    const back = await sameBrowser(next, r.cookie);
    expect(back.headers.get("location")).toBe("/?signin=ok#/connectors");
    expect(hub.connectors.auth.accessToken(conn.id)).toBe("gh-at");
  });

  it("asks a different browser before finishing, so a passed-on sign-in link can't quietly connect someone else's account", async () => {
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["gdrive"], origin: base });
    const state = new URL(r.data.url).searchParams.get("state")!;
    const next = `${base}/api/connectors/app/callback?code=good&state=${encodeURIComponent(state)}`;
    const elsewhere = await fetch(next, { redirect: "manual" });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await elsewhere.text();
    expect(html).toContain("Me started this sign-in for Google Drive in Bubble AI");
    expect(html).toContain("Continue only if you started it");
    expect(hub.connectors.auth.accessToken(r.data.connectors[0].id)).toBeNull();
    // a wrong cookie is no better than none
    expect((await sameBrowser(next, `${r.cookie.split("=")[0]}=nope`)).status).toBe(200);
    expect(hub.connectors.auth.accessToken(r.data.connectors[0].id)).toBeNull();
    // Continue finishes it
    const go = await fetch(`${next}&confirm=1`, { redirect: "manual" });
    expect(go.headers.get("location")).toBe("/?signin=ok#/connectors");
    expect(hub.connectors.auth.accessToken(r.data.connectors[0].id)).toBe("g-at1");
  });

  it("Cancel on the confirm page cancels the sign-in", async () => {
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["gdrive"], origin: base });
    const state = new URL(r.data.url).searchParams.get("state")!;
    const html = await (await fetch(`${base}/api/connectors/app/callback?code=good&state=${encodeURIComponent(state)}`)).text();
    const cancel = html.match(/<a class="no" href="([^"]+)"/)![1].replace(/&#38;/g, "&");
    expect(cancel).not.toContain("code=");
    const back = await fetch(base + cancel, { redirect: "manual" });
    expect(decodeURIComponent(back.headers.get("location")!)).toContain("Sign-in was cancelled.");
    expect((await api("GET", `/api/connectors/${r.data.connectors[0].id}`)).data.auth.error).toBe("Sign-in was cancelled.");
  });

  it("shows the sign-in page's own words only for a sign-in under way here", async () => {
    const made = `${base}/api/connectors/app/callback?error=x&error_description=${encodeURIComponent("Call 555 to restore your account")}&state=nope`;
    const back = await fetch(made, { redirect: "manual" });
    const to = decodeURIComponent(back.headers.get("location")!);
    expect(to).toContain("This sign-in link has expired");
    expect(to).not.toContain("555");
    const mcp = await fetch(`${base}/api/connectors/oauth/callback?error=x&error_description=hi&state=nope`, { redirect: "manual" });
    expect(decodeURIComponent(mcp.headers.get("location") ?? "")).not.toContain("hi#");
  });

  it("only takes catalog apps that sign in, and only shares a sign-in within one company", async () => {
    expect((await api("POST", "/api/connectors/connect", { catalogIds: ["postgres"], origin: base })).status).toBe(400);
    expect((await api("POST", "/api/connectors/connect", { catalogIds: ["gmail", "github"], origin: base })).status).toBe(400);
    expect((await api("POST", "/api/connectors/connect", { catalogIds: ["gmail"], origin: base, returnTo: "https://evil.example" })).status).toBe(400);
  });
});

describe("the relay", () => {
  it("asks before sending a code to a hub on the internet", async () => {
    const state = `${Buffer.from("https://someone.example.com").toString("base64url")}.abc`;
    const res = relay.callback(new Request(`${RELAY}/oauth/callback?code=c&state=${state}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("someone.example.com");
    expect(html).toContain("Continue only if that's your Bubble AI");
    expect(html).toContain(`https://someone.example.com/api/connectors/app/callback?code=c&#38;state=${state}`);
  });

  it("sends the code on without asking only to this computer", () => {
    for (const h of ["http://localhost:8787", "http://127.0.0.1:1", "http://wisp.localhost:8787", "http://[::1]:8787"]) expect(relay.isThisComputer(new URL(h))).toBe(true);
    // a home-network address could be anyone's hub on the network the person is on (a café's, a hotel's)
    for (const h of ["http://192.168.0.4:8787", "http://10.0.0.2", "http://172.20.1.1", "http://100.101.2.3:8787", "http://wisp.local:8787", "https://wisp.example.ts.net", "https://evil.example", "http://8.8.8.8"]) expect(relay.isThisComputer(new URL(h))).toBe(false);
  });

  it("refuses states that aren't a hub's address", () => {
    for (const s of [null, "", "x", `${Buffer.from("javascript:alert(1)").toString("base64url")}.a`, `${Buffer.from("https://a.example/path").toString("base64url")}.a`, `${Buffer.from("https://u:p@a.example").toString("base64url")}.a`]) expect(relay.hubFromState(s)).toBeNull();
    expect(relay.callback(new Request(`${RELAY}/oauth/callback?code=c&state=nope`)).status).toBe(400);
  });

  it("only trades codes that came back through it, and only for apps it has", async () => {
    const post = (body: unknown) => relay.token(new Request(`${RELAY}/api/oauth/token`, { method: "POST", body: JSON.stringify(body) }), relayEnv, company);
    expect((await post({ provider: "google", grant_type: "authorization_code", code: "good", code_verifier: "v", redirect_uri: "https://other.example/cb" })).status).toBe(400);
    expect((await post({ provider: "slack", grant_type: "refresh_token", refresh_token: "r" })).status).toBe(404);
    expect((await post({ provider: "nope", grant_type: "refresh_token", refresh_token: "r" })).status).toBe(400);
    expect((await post({ provider: "google", grant_type: "client_credentials" })).status).toBe(400);
    expect(relay.apps(relayEnv)).toEqual({ google: { clientId: "g-client" }, github: { clientId: "gh-client" } });
  });
});

describe("token answers", () => {
  it("reads Slack's user token and the companies' 200-with-error answers", () => {
    expect(normalizeTokens("slack", { ok: true, authed_user: { access_token: "xoxp-1", scope: "channels:read", token_type: "user" } })).toEqual({ access_token: "xoxp-1", scope: "channels:read", token_type: "user" });
    expect(normalizeTokens("slack", { ok: true, access_token: "xoxp-2", refresh_token: "xoxe-1", expires_in: 43200 })).toMatchObject({ access_token: "xoxp-2", refresh_token: "xoxe-1", expires_in: 43200 });
    expect(() => normalizeTokens("slack", { ok: false, error: "invalid_code" })).toThrow(/invalid_code/);
    expect(() => normalizeTokens("github", { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." })).toThrow(/incorrect or expired/);
  });
});
