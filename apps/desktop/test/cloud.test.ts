import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const cloud = createRequire(import.meta.url)("../src/cloud.cjs");

type Call = { method: string; url: string; headers: Record<string, string>; body?: any };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const price = (gross: string) => ({ price_monthly: { net: gross, gross } });
const certError = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });

const TYPES = [
  { name: "cx23", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "x86", deprecated: false, deprecation: null, prices: [{ location: "fsn1", ...price("4.99") }, { location: "ash", ...price("6.49") }], locations: [{ name: "fsn1", available: true, deprecation: null }, { name: "ash", available: false, deprecation: null }] },
  { name: "cax11", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "arm", deprecated: false, deprecation: null, prices: [{ location: "fsn1", ...price("4.49") }], locations: [{ name: "fsn1", available: true, deprecation: null }] },
  { name: "cx13", cores: 1, memory: 1, disk: 20, cpu_type: "shared", architecture: "x86", deprecated: false, deprecation: null, prices: [{ location: "fsn1", ...price("2.99") }], locations: [{ name: "fsn1", available: true, deprecation: null }] },
  { name: "ccx13", cores: 2, memory: 8, disk: 80, cpu_type: "dedicated", architecture: "x86", deprecated: false, deprecation: null, prices: [{ location: "fsn1", ...price("19.99") }], locations: [{ name: "fsn1", available: true, deprecation: null }] },
  { name: "cx22", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "x86", deprecated: true, deprecation: { announced: "2025-10-01", unavailable_after: "2026-01-01" }, prices: [{ location: "fsn1", ...price("3.79") }], locations: [{ name: "fsn1", available: true, deprecation: null }] },
  { name: "cx33", cores: 4, memory: 8, disk: 80, cpu_type: "shared", architecture: "x86", deprecated: false, deprecation: null, prices: [{ location: "fsn1", ...price("8.49") }], locations: [{ name: "fsn1", available: true, deprecation: null }] },
];
const PRICING = { pricing: { currency: "EUR", vat_rate: "19.00", primary_ips: [{ type: "ipv4", prices: [{ location: "fsn1", ...price("0.50") }, { location: "ash", ...price("0.60") }] }, { type: "ipv6", prices: [] }] } };
const LOCATIONS = [{ name: "fsn1", city: "Falkenstein", country: "DE", network_zone: "eu-central" }, { name: "ash", city: "Ashburn, VA", country: "US", network_zone: "us-east" }];
const page = (key: string, items: unknown[], next: number | null = null) => ({ [key]: items, meta: { pagination: { page: 1, per_page: 50, next_page: next } } });

/** A pretend Hetzner and a pretend new server, recording every request the app makes. */
function mockCloud({ hubAfter = 2, ipCert = false, token = "good-token", readOnly = false } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  let serverPolls = 0;
  let setupKey = "";
  let upAfter = hubAfter;
  const fetchImpl = async (url: URL, init: RequestInit = {}) => {
    const method = init.method || "GET";
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: url.href, headers, body });
    if (url.host === "api.hetzner.cloud") {
      if (headers.authorization !== `Bearer ${token}`) return json({ error: { code: "unauthorized", message: "unable to authenticate" } }, 401);
      const route = url.pathname.replace("/v1", "");
      if (method === "GET" && route === "/server_types") return json(page("server_types", TYPES));
      if (method === "GET" && route === "/pricing") return json(PRICING);
      if (method === "GET" && route === "/locations") return json(page("locations", LOCATIONS));
      if (method === "POST" && route === "/servers") {
        if (readOnly) return json({ error: { code: "forbidden", message: "insufficient permissions" } }, 403);
        setupKey = /setup-key\n\s+permissions: "0600"\n\s+content: "([^"]+)"/.exec(body.user_data)?.[1] ?? "";
        return json({ server: { id: 42, name: body.name, status: "initializing", public_net: { ipv4: null } }, action: { id: 1, status: "running" }, root_password: "x" }, 201);
      }
      if (method === "GET" && route === "/servers/42") {
        serverPolls++;
        return json({ server: { id: 42, status: serverPolls > 1 ? "running" : "starting", public_net: { ipv4: { ip: "203.0.113.7" } } } });
      }
      if (method === "DELETE" && route === "/servers/42") return json({ action: { id: 2 } });
      return json({ error: { code: "not_found", message: "not found" } }, 404);
    }
    // the new server: the IP address has no certificate (unless ipCert), the sslip.io name does
    if (url.host === "203.0.113.7" && !ipCert) throw certError();
    if (url.pathname === "/api/setup" && method === "GET") {
      if (++polls < upAfter) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return json({ needsSetup: true });
    }
    if (url.pathname === "/api/setup" && method === "POST") {
      if (headers["x-warren-setup-key"] !== setupKey) return json("This Warren is being set up by the app that created it.", 403);
      return json({ token: "session-token", user: { name: body.name } });
    }
    if (url.pathname === "/api/me") return json({ ok: true });
    throw new Error(`unexpected ${method} ${url.href}`);
  };
  return { calls, fetchImpl, key: () => setupKey, comeUp: () => (upAfter = 0) };
}

const sleep = async () => {};
const account = { name: "Ada", email: "ada@example.com", password: "correct horse" };

describe("Hetzner sizes and prices", () => {
  it("lists shared-CPU sizes that can be ordered, priced with their IPv4 address, cheapest first", async () => {
    const { fetchImpl, calls } = mockCloud();
    const r = await cloud.plans("good-token", { fetchImpl });
    expect(r.currency).toBe("EUR");
    expect(r.plans.map((p: any) => `${p.type}@${p.location}=${p.monthly}`)).toEqual(["cax11@fsn1=4.99", "cx23@fsn1=5.49", "cx33@fsn1=8.99"]);
    expect(r.plans[1]).toMatchObject({ server: 4.99, ipv4: 0.5, cores: 2, memory: 4, disk: 40, arch: "x86" });
    // ash has nothing available, so it isn't offered
    expect(r.locations).toEqual([{ name: "fsn1", city: "Falkenstein", country: "DE", zone: "eu-central" }]);
    expect(calls.every((c) => c.method === "GET" && c.headers.authorization === "Bearer good-token")).toBe(true);
  });

  it("suggests the cheapest size with 4 GB", async () => {
    const { fetchImpl } = mockCloud();
    const r = await cloud.plans("good-token", { fetchImpl });
    expect(cloud.recommended(r.plans, "fsn1")).toMatchObject({ type: "cax11" });
    expect(cloud.recommended(r.plans, "nowhere")).toBeNull();
  });

  it("follows the API's pages", async () => {
    let n = 0;
    const fetchImpl = async (url: URL) => {
      if (url.pathname.endsWith("/server_types")) return json(page("server_types", [TYPES[n++]], url.searchParams.get("page") === "1" ? 2 : null));
      if (url.pathname.endsWith("/pricing")) return json(PRICING);
      return json(page("locations", LOCATIONS));
    };
    const r = await cloud.plans("t", { fetchImpl });
    expect(r.plans.map((p: any) => p.type)).toEqual(["cax11", "cx23"]);
  });

  it("says plainly when the token is wrong", async () => {
    const { fetchImpl } = mockCloud();
    await expect(cloud.plans("typo", { fetchImpl })).rejects.toThrow(/didn't accept that token/);
  });
});

describe("creating a Warren in the person's Hetzner project", () => {
  it("creates the server with the cloud-init script, waits for HTTPS, then makes the account with the setup key", async () => {
    const mock = mockCloud({ hubAfter: 3 });
    const steps: string[] = [];
    const r = await cloud.createWarren({ token: "good-token", type: "cx23", location: "fsn1", account }, { fetchImpl: mock.fetchImpl, sleep, onStep: (s: string) => steps.push(s) });

    expect(steps).toEqual(["create", "boot", "https", "account"]);
    expect(r).toMatchObject({ url: "https://203-0-113-7.sslip.io", session: "session-token", server: { id: 42, ip: "203.0.113.7", location: "fsn1", type: "cx23" } });

    const create = mock.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/servers"))!;
    expect(create.body).toMatchObject({ server_type: "cx23", location: "fsn1", image: "ubuntu-24.04", labels: { "managed-by": "warren" }, public_net: { enable_ipv4: true } });
    expect(create.body.name).toMatch(/^warren-[0-9a-f]{6}$/);
    expect(create.body.user_data.startsWith("#cloud-config\n")).toBe(true);
    expect(create.body.user_data).not.toContain(`content: "${cloud.PLACEHOLDER}"`);
    expect(new TextEncoder().encode(create.body.user_data).length).toBeLessThan(32 * 1024); // Hetzner's limit
    expect(mock.key()).toMatch(/^[\w-]{32}$/);

    // the IP address is tried first, then the sslip.io name
    const hubGets = mock.calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/setup")).map((c) => new URL(c.url).host);
    expect(hubGets.slice(0, 2)).toEqual(["203.0.113.7", "203-0-113-7.sslip.io"]);

    const setup = mock.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/setup"))!;
    expect(setup.headers["x-warren-setup-key"]).toBe(mock.key());
    expect(setup.body).toEqual({ ...account, workspaceName: "Warren" });
    // the Hetzner token never goes to the new server
    expect(mock.calls.filter((c) => !c.url.includes("api.hetzner.cloud")).some((c) => JSON.stringify(c).includes("good-token"))).toBe(false);
  });

  it("uses the IP address itself when its certificate is there", async () => {
    const mock = mockCloud({ hubAfter: 1, ipCert: true });
    const r = await cloud.createWarren({ token: "good-token", type: "cx23", location: "fsn1", account }, { fetchImpl: mock.fetchImpl, sleep });
    expect(r.url).toBe("https://203.0.113.7");
  });

  it("says when the token can only read, before anything is created", async () => {
    const mock = mockCloud({ readOnly: true });
    const err = await cloud.createWarren({ token: "good-token", type: "cx23", location: "fsn1", account }, { fetchImpl: mock.fetchImpl, sleep }).catch((e: Error) => e);
    expect(err.message).toMatch(/Read & Write/);
    expect(err.server).toBeUndefined();
  });

  it("hands back the server when Warren never answers, so it can be deleted", async () => {
    const mock = mockCloud({ hubAfter: Infinity });
    const err = await cloud.createWarren({ token: "good-token", type: "cx23", location: "fsn1", account }, { fetchImpl: mock.fetchImpl, sleep, httpsMs: 30 }).catch((e: Error) => e);
    expect(err.message).toMatch(/didn't answer over HTTPS/);
    expect(err.server).toMatchObject({ id: 42, ip: "203.0.113.7" });
    await cloud.deleteServer("good-token", err.server.id, { fetchImpl: mock.fetchImpl });
    expect(mock.calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://api.hetzner.cloud/v1/servers/42" });
  });

  it("keeps the setup key of a server that didn't finish, so the same server can be picked up again", async () => {
    const mock = mockCloud({ hubAfter: Infinity });
    const err = await cloud.createWarren({ token: "good-token", type: "cx23", location: "fsn1", account }, { fetchImpl: mock.fetchImpl, sleep, httpsMs: 30 }).catch((e: Error) => e);
    expect(err.key).toBe(mock.key());

    mock.comeUp();
    const steps: string[] = [];
    const r = await cloud.createWarren({ token: "good-token", type: "cx23", location: "fsn1", account }, { fetchImpl: mock.fetchImpl, sleep, onStep: (s: string) => steps.push(s), resume: { server: err.server, key: err.key } });
    expect(steps).toEqual(["boot", "https", "account"]);
    expect(r).toMatchObject({ session: "session-token", server: { id: 42 } });
    expect(mock.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/servers"))).toHaveLength(1);
  });

  it("puts a fresh key into the real cloud-init script", () => {
    const a = cloud.userData("key-one");
    expect(a).toContain('content: "key-one"');
    expect(a).not.toContain(`content: "${cloud.PLACEHOLDER}"`);
    // the script still knows the placeholder, so the key it got isn't mistaken for "no key"
    expect(a).toContain(`"" | ${cloud.PLACEHOLDER})`);
    expect(cloud.userData("key-two")).not.toBe(a);
  });
});


describe("cloud request deadlines", () => {
  it("makes an account timeout retryable and preserves the pending server and key", async () => {
    const server = { id: 42, name: "existing", ip: "203.0.113.7", location: "fsn1", type: "cx23" };
    const err = await cloud.createWarren({ token: "good-token", account }, {
      resume: { server, key: "saved-key" }, sleep,
      fetchImpl: async (url: URL, init: RequestInit) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        if (url.host === "api.hetzner.cloud") return json({ server: { status: "running", public_net: { ipv4: { ip: server.ip } } } });
        if (!init.method) return json({ needsSetup: true });
        throw Object.assign(new Error("deadline"), { name: "TimeoutError" });
      },
    }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "timed_out", retryable: true, server: { id: 42 }, key: "saved-key" });
  });

  it("aborts an unresponsive account request", async () => {
    const fetchImpl = (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    await expect(cloud.claim("https://hub", "key", account, { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({ code: "timed_out", retryable: true });
  });

  it("bounds the optional timezone request and still returns the created session", async () => {
    const fetchImpl = async (_url: URL, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (init.method === "POST") return json({ token: "session" });
      return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    };
    expect(await cloud.claim("https://hub", "key", account, { fetchImpl, timeoutMs: 10 })).toBe("session");
  });
});
