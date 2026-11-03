import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cloud = require("../src/cloud.cjs");

type Call = { method: string; url: URL; headers: Record<string, string>; body?: any };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const account = { name: "Ada", email: "ada@example.com", password: "correct horse" };
const sleep = async () => {};

/** A pretend provider API plus a pretend new server that comes up at 203.0.113.9. */
function mock(host: string, routes: (c: Call) => unknown) {
  const calls: Call[] = [];
  let key = "";
  const fetchImpl = async (url: URL, init: RequestInit = {}) => {
    const method = init.method || "GET";
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const c = { method, url, headers, body };
    calls.push(c);
    if (url.host === host) {
      if (headers.authorization !== "Bearer tok") return json({ message: "Unable to authenticate you", error: "Invalid API key" }, 401);
      const data = body?.user_data ? (host === "api.vultr.com" ? Buffer.from(body.user_data, "base64").toString() : body.user_data) : "";
      if (data) key = /content: "([^"]+)"/.exec(data)?.[1] ?? "";
      const r = routes(c);
      return r instanceof Object && "status" in (r as object) && "json" in (r as object) ? r : json(r);
    }
    if (url.host === "203.0.113.9") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
    if (url.pathname === "/api/setup" && method === "GET") return json({ needsSetup: true });
    if (url.pathname === "/api/setup" && method === "POST") return headers["x-wisp-setup-key"] === key ? json({ token: "session" }) : json({}, 403);
    if (url.pathname === "/api/me") return json({});
    throw new Error(`unexpected ${method} ${url.href}`);
  };
  return { calls, fetchImpl };
}

describe("DigitalOcean", () => {
  const SIZES = [
    { slug: "s-1vcpu-2gb", memory: 2048, vcpus: 1, disk: 50, price_monthly: 12, available: true, regions: ["nyc3", "fra1"] },
    { slug: "s-2vcpu-4gb", memory: 4096, vcpus: 2, disk: 80, price_monthly: 24, available: true, regions: ["nyc3", "fra1"] },
    { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, price_monthly: 48, available: true, regions: ["nyc3"] },
    { slug: "s-2vcpu-4gb-amd", memory: 4096, vcpus: 2, disk: 80, price_monthly: 28, available: true, regions: ["nyc3"] },
    { slug: "s-1vcpu-512mb-10gb", memory: 512, vcpus: 1, disk: 10, price_monthly: 4, available: true, regions: ["nyc3"] },
  ];
  const REGIONS = [{ slug: "nyc3", name: "New York 3", available: true }, { slug: "fra1", name: "Frankfurt 1", available: true }, { slug: "nyc1", name: "New York 1", available: false }];
  let polls = 0;
  const routes = (c: Call) => {
    const r = c.url.pathname.replace("/v2", "");
    if (r === "/sizes") return { sizes: SIZES, links: {} };
    if (r === "/regions") return { regions: REGIONS, links: {} };
    if (c.method === "POST" && r === "/droplets") return { droplet: { id: 7, status: "new", networks: { v4: [] } } };
    if (r === "/droplets/7" && c.method === "GET") return { droplet: { id: 7, status: ++polls > 1 ? "active" : "new", networks: { v4: [{ type: "private", ip_address: "10.0.0.2" }, { type: "public", ip_address: "203.0.113.9" }] } } };
    if (r === "/droplets/7" && c.method === "DELETE") return json({}, 204);
    return json({ id: "not_found", message: "not found" }, 404);
  };

  it("lists Basic sizes in open regions, priced in dollars, and recommends 4 GB", async () => {
    const { fetchImpl } = mock("api.digitalocean.com", routes);
    const r = await cloud.plans("tok", { provider: "digitalocean", fetchImpl });
    expect(r.currency).toBe("USD");
    expect(r.locations).toEqual([{ name: "nyc3", city: "New York", country: "US" }, { name: "fra1", city: "Frankfurt", country: "DE" }]);
    expect(cloud.sizeChoices(r.plans, "nyc3").map((p: any) => `${p.type}=${p.monthly}${p.recommended ? "*" : ""}`)).toEqual(["s-1vcpu-2gb=12", "s-2vcpu-4gb=24*", "s-4vcpu-8gb=48"]);
  });

  it("creates a Droplet with the start script, waits for it, and makes the account", async () => {
    polls = 0;
    const m = mock("api.digitalocean.com", routes);
    const r = await cloud.createWisp({ provider: "digitalocean", token: "tok", type: "s-2vcpu-4gb", location: "nyc3", account }, { fetchImpl: m.fetchImpl, sleep });
    expect(r).toMatchObject({ url: "https://203-0-113-9.sslip.io", session: "session", server: { provider: "digitalocean", id: 7, ip: "203.0.113.9" } });
    const create = m.calls.find((c) => c.method === "POST" && c.url.pathname === "/v2/droplets")!;
    expect(create.body).toMatchObject({ region: "nyc3", size: "s-2vcpu-4gb", image: "ubuntu-24-04-x64" });
    expect(create.body.user_data.startsWith("#cloud-config\n")).toBe(true);
    await cloud.deleteServer("tok", 7, { provider: "digitalocean", fetchImpl: m.fetchImpl });
    expect(m.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("says what to do when the account can't pay yet", async () => {
    const { fetchImpl } = mock("api.digitalocean.com", () => json({ id: "unprocessable_entity", message: "You must add a payment method to create Droplets." }, 422));
    await expect(cloud.createWisp({ provider: "digitalocean", token: "tok", type: "s", location: "nyc3", account }, { fetchImpl, sleep })).rejects.toThrow(/payment method first/);
  });
});

describe("Vultr", () => {
  const PLANS = [
    { id: "vc2-1c-2gb", ram: 2048, vcpu_count: 1, disk: 55, monthly_cost: 10, locations: ["ewr", "fra"] },
    { id: "vc2-2c-4gb", ram: 4096, vcpu_count: 2, disk: 80, monthly_cost: 20, locations: ["ewr", "fra"] },
    { id: "vc2-1c-1gb", ram: 1024, vcpu_count: 1, disk: 25, monthly_cost: 5, locations: ["ewr"] },
  ];
  const REGIONS = [{ id: "ewr", city: "New Jersey", country: "US", continent: "North America" }, { id: "fra", city: "Frankfurt", country: "DE", continent: "Europe" }];
  const routes = (c: Call) => {
    const r = c.url.pathname.replace("/v2", "");
    if (r === "/plans") return { plans: PLANS, meta: { links: { next: "" } } };
    if (r === "/regions") return { regions: REGIONS, meta: { links: { next: "" } } };
    if (r === "/os") return { os: [{ id: 2136, name: "Ubuntu 22.04 LTS x64", arch: "x64" }, { id: 2284, name: "Ubuntu 24.04 LTS x64", arch: "x64" }], meta: { links: { next: "" } } };
    if (c.method === "POST" && r === "/instances") return { instance: { id: "abc", main_ip: "0.0.0.0", status: "pending" } };
    if (r === "/instances/abc") return { instance: { id: "abc", main_ip: "203.0.113.9", status: "active", power_status: "running" } };
    return json({ error: "not found" }, 404);
  };

  it("creates an instance with Ubuntu 24.04 and the start script, base64 as Vultr wants", async () => {
    const m = mock("api.vultr.com", routes);
    const r = await cloud.plans("tok", { provider: "vultr", fetchImpl: m.fetchImpl });
    expect(cloud.sizeChoices(r.plans, "ewr").map((p: any) => `${p.memory}${p.recommended ? "*" : ""}`)).toEqual(["2", "4*"]);
    const w = await cloud.createWisp({ provider: "vultr", token: "tok", type: "vc2-2c-4gb", location: "ewr", account }, { fetchImpl: m.fetchImpl, sleep });
    expect(w.server).toMatchObject({ provider: "vultr", id: "abc", ip: "203.0.113.9" });
    const create = m.calls.find((c) => c.method === "POST")!;
    expect(create.body).toMatchObject({ os_id: 2284, plan: "vc2-2c-4gb", region: "ewr" });
    expect(Buffer.from(create.body.user_data, "base64").toString().startsWith("#cloud-config\n")).toBe(true);
  });

  it("explains an IP allow list", async () => {
    const { fetchImpl } = mock("api.vultr.com", () => json({ error: "Unauthorized IP address: 198.51.100.1" }, 403));
    await expect(cloud.plans("tok", { provider: "vultr", fetchImpl })).rejects.toThrow(/allow all IPv4/);
  });
});

describe("choosing for the person", () => {
  it("recommends 4 GB on x86, and Arm only when there's no x86", () => {
    const p = (type: string, memory: number, monthly: number, arch = "x86") => ({ type, memory, monthly, arch, location: "a" });
    expect(cloud.recommendedPlan([p("arm4", 4, 4, "arm"), p("x2", 2, 3), p("x4", 4, 6), p("x8", 8, 9)]).type).toBe("x4");
    expect(cloud.recommendedPlan([p("x2", 2, 3), p("arm4", 4, 4, "arm")]).type).toBe("arm4");
    expect(cloud.recommendedPlan([p("x2", 2, 3)]).type).toBe("x2");
  });

  it("picks the region nearest the person's time zone", () => {
    const locs = [{ name: "fra1", city: "Frankfurt", country: "DE" }, { name: "nyc3", city: "New York", country: "US" }, { name: "sfo3", city: "San Francisco", country: "US" }, { name: "sgp1", city: "Singapore", country: "SG" }];
    expect(cloud.nearestLocation(locs, "America/New_York")).toBe("nyc3");
    expect(cloud.nearestLocation(locs, "America/Los_Angeles")).toBe("sfo3");
    expect(cloud.nearestLocation(locs, "Europe/London")).toBe("fra1");
    expect(cloud.nearestLocation(locs, "Asia/Kolkata")).toBe("sgp1");
    expect(cloud.nearestLocation([{ name: "x", city: "Nowhere", country: "ZZ" }], "Europe/Paris")).toBe("x");
  });

  it("knows each provider's tokens when they're copied", () => {
    const [digitalocean, hetzner, vultr] = cloud.PROVIDERS;
    expect(digitalocean.id).toBe("digitalocean");
    expect(digitalocean.looksLikeToken(`dop_v1_${"a".repeat(64)}`)).toBe(true);
    expect(hetzner.looksLikeToken("A".repeat(64))).toBe(true);
    expect(hetzner.looksLikeToken("hello there")).toBe(false);
    expect(vultr.looksLikeToken("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe(true);
  });
});

describe("Sign in with DigitalOcean", () => {
  const signIn = require("../src/cloud-providers/do-sign-in.cjs");

  it("registers itself, opens the browser with PKCE, and trades the code that comes back", async () => {
    const posts: { url: string; body: string }[] = [];
    const real = fetch;
    const fetchImpl = async (url: URL, init: RequestInit = {}) => {
      if (url.host === "127.0.0.1") return real(url, init);
      posts.push({ url: url.href, body: String(init.body) });
      if (url.pathname.endsWith("/register")) return json({ client_id: "cid" }, 201);
      if (url.pathname.endsWith("/token")) return json({ access_token: "doo_v1_x", expires_in: 3600 });
      throw new Error(url.href);
    };
    let opened = "";
    const h = signIn.signIn({ fetchImpl, openExternal: async (u: string) => { opened = u; } });
    while (!opened) await new Promise((r) => setTimeout(r, 5));
    const auth = new URL(opened);
    expect(auth.host).toBe("cloud.digitalocean.com");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toContain("droplet:create");
    const back = new URL(auth.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", auth.searchParams.get("state")!);
    const page = await real(back);
    expect(await page.text()).toContain("Signed in");
    expect(await h.done).toBe("doo_v1_x");
    const register = JSON.parse(posts[0].body);
    expect(register).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [auth.searchParams.get("redirect_uri")] });
    const token = new URLSearchParams(posts[1].body);
    expect(token.get("code")).toBe("the-code");
    expect(token.get("code_verifier")).toMatch(/^[\w-]{43}$/);
  });

  it("refuses a callback with the wrong state, and can be cancelled", async () => {
    const real = fetch;
    let opened = "";
    const h = signIn.signIn({ fetchImpl: async (url: URL) => json({ client_id: "cid" }, 201), openExternal: async (u: string) => { opened = u; } });
    while (!opened) await new Promise((r) => setTimeout(r, 5));
    const back = new URL(new URL(opened).searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "c");
    back.searchParams.set("state", "forged");
    const refused = expect(h.done).rejects.toThrow(/didn't come back right/);
    expect((await real(back)).status).toBe(400);
    await refused;
    const h2 = signIn.signIn({ fetchImpl: async () => json({ client_id: "cid" }, 201), openExternal: async () => {} });
    h2.cancel();
    await expect(h2.done).rejects.toMatchObject({ cancelled: true });
  });
});
