const { envVar } = require("./env.cjs");
// "Create one in your cloud account": a Wisp server in the person's own Hetzner Cloud project,
// billed to them by Hetzner. The app asks Hetzner for a server with docker/cloud-init.yaml as its
// first-boot script, waits until the hub answers over HTTPS, and makes the first account with the
// setup key only this app knows. The API token is only ever passed in, used and dropped: nothing
// here keeps or saves it.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PLACEHOLDER = "__WISP_SETUP_KEY__";
const IMAGE = "ubuntu-24.04";
/** Override the API (and the hub's address) to run the whole flow against a mock. */
const hetznerApi = () => envVar("HETZNER_API", process.env) ?? "https://api.hetzner.cloud/v1";

class CloudError extends Error {}
const timedOut = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";
const timeoutError = () => Object.assign(new CloudError("The request timed out. Try again."), { code: "timed_out", retryable: true });

/** One Hetzner API call, with its errors said the way a person needs to hear them. */
async function hetzner(token, method, route, body, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(new URL(hetznerApi() + route), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (timedOut(err)) throw timeoutError();
    throw new CloudError(`Couldn't reach Hetzner (${err.cause?.code || err.message}). Check your internet connection.`);
  }
  if (res.status === 204) return {};
  const data = await res.json().catch((err) => { if (timedOut(err)) throw timeoutError(); return {}; });
  if (res.ok) return data;
  const code = data.error?.code;
  const message = data.error?.message || `Hetzner said ${res.status}`;
  if (res.status === 401) throw new CloudError("Hetzner didn't accept that token. Copy it again, all of it.");
  if (res.status === 403 || code === "forbidden") throw new CloudError("That token can only read. Make a new one with Read & Write access.");
  if (code === "resource_limit_exceeded") throw new CloudError(`Your Hetzner project is at its limit: ${message}. Ask Hetzner to raise it, or delete a server you don't need.`);
  if (code === "resource_unavailable") throw new CloudError("Hetzner has no servers of that size left in that location right now. Pick another size or location.");
  if (res.status === 429) throw new CloudError("Hetzner is limiting requests. Wait a minute and try again.");
  throw new CloudError(message);
}

/** Every page of a list (server types are more than one page). */
async function all(token, route, key, opts) {
  const out = [];
  for (let page = 1; page; ) {
    const data = await hetzner(token, "GET", `${route}${route.includes("?") ? "&" : "?"}page=${page}&per_page=50`, null, opts);
    out.push(...(data[key] || []));
    page = data.meta?.pagination?.next_page || 0;
  }
  return out;
}

const money = (p) => Number(p?.price_monthly?.gross ?? NaN);

/**
 * What can be created with this token: locations, and each size in each location with its monthly
 * price including the IPv4 address (Hetzner bills that separately), cheapest first. Shared-CPU
 * sizes with 2–16 GB only: enough for a hub and a few agent computers, without a menu of 40.
 * Prices come from Hetzner every time, so they're whatever Hetzner charges today.
 */
async function plans(token, opts = {}) {
  const [types, pricing, locations] = await Promise.all([
    all(token, "/server_types", "server_types", opts),
    hetzner(token, "GET", "/pricing", null, opts),
    all(token, "/locations", "locations", opts),
  ]);
  const currency = pricing.pricing?.currency || "EUR";
  const ipv4 = new Map((pricing.pricing?.primary_ips?.find((p) => p.type === "ipv4")?.prices ?? []).map((p) => [p.location, money(p)]));
  const list = [];
  for (const t of types) {
    if (t.deprecated || t.deprecation || t.cpu_type !== "shared" || t.memory < 2 || t.memory > 16) continue;
    const where = t.locations ?? t.prices.map((p) => ({ name: p.location }));
    for (const loc of where) {
      if (loc.available === false || loc.deprecation) continue;
      const server = money(t.prices.find((p) => p.location === loc.name));
      if (!Number.isFinite(server)) continue;
      const ip = ipv4.get(loc.name) ?? 0;
      list.push({ type: t.name, location: loc.name, cores: t.cores, memory: t.memory, disk: t.disk, arch: t.architecture, monthly: round(server + ip), server: round(server), ipv4: round(ip) });
    }
  }
  list.sort((a, b) => a.monthly - b.monthly || a.memory - b.memory);
  const used = new Set(list.map((p) => p.location));
  return {
    currency,
    locations: locations.filter((l) => used.has(l.name)).map((l) => ({ name: l.name, city: l.city, country: l.country, zone: l.network_zone })),
    plans: list,
  };
}
const round = (n) => Math.round(n * 100) / 100;

/**
 * docker/cloud-init.yaml with a fresh setup key as the key file's content. Only that line: the
 * script itself also names the placeholder, to tell a pasted copy (no key) from one with a key.
 */
function userData(key, file = templatePath()) {
  const text = fs.readFileSync(file, "utf8");
  const line = `content: "${PLACEHOLDER}"`;
  if (text.split(line).length !== 2) throw new CloudError("The cloud-init script has no setup key line.");
  return text.replace(line, `content: "${key}"`);
}

/** In a built app, the copy of Wisp inside it; from source, this repo. */
function templatePath() {
  const dirs = [envVar("RUNTIME", process.env), process.resourcesPath && path.join(process.resourcesPath, "wisp"), path.resolve(__dirname, "../../..")];
  for (const d of dirs) if (d && fs.existsSync(path.join(d, "docker", "cloud-init.yaml"))) return path.join(d, "docker", "cloud-init.yaml");
  throw new CloudError("This copy of Wisp is missing docker/cloud-init.yaml. Download Wisp again.");
}

/** Where a server's hub answers: its IP address (Let's Encrypt IP certificate), then the sslip.io name. */
function hubUrls(ip) {
  if (envVar("CLOUD_HUB_URL", process.env)) return [envVar("CLOUD_HUB_URL", process.env)];
  return [`https://${ip}`, `https://${ip.replaceAll(".", "-")}.sslip.io`];
}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a Wisp in the person's Hetzner project and make its first account. `onStep(id)` hears
 * "create", "boot", "https" and "account" as each starts. On failure after the server exists, the
 * error carries it (`err.server`) and its setup key (`err.key`), so the person can delete it, or keep
 * waiting: `resume: { server, key }` picks the same server up again instead of creating another,
 * since only that key can make its first account.
 */
async function createWisp({ token, type, location, account }, { fetchImpl = fetch, sleep = sleepFor, onStep = () => {}, bootMs = 5 * 60_000, httpsMs = 15 * 60_000, template, resume } = {}) {
  const opts = { fetchImpl };
  let key;
  let server;
  if (resume?.server?.id && resume.key) {
    key = resume.key;
    server = { ...resume.server };
  } else {
    key = crypto.randomBytes(24).toString("base64url");
    const name = `wisp-${crypto.randomBytes(3).toString("hex")}`;
    onStep("create");
    const created = await hetzner(token, "POST", "/servers", {
      name,
      server_type: type,
      location,
      image: IMAGE,
      user_data: userData(key, template),
      labels: { "managed-by": "wisp" },
      public_net: { enable_ipv4: true, enable_ipv6: true },
    }, opts);
    server = { id: created.server.id, name, ip: created.server.public_net?.ipv4?.ip || "", location, type };
  }

  try {
    onStep("boot");
    for (const until = Date.now() + bootMs; ; ) {
      const s = (await hetzner(token, "GET", `/servers/${server.id}`, null, opts)).server;
      server.ip = s.public_net?.ipv4?.ip || server.ip;
      if (s.status === "running" && server.ip) break;
      if (Date.now() > until) throw new CloudError("The server didn't start in time.");
      await sleep(3000);
    }

    onStep("https");
    const url = await waitForHub(server.ip, { fetchImpl, sleep, ms: httpsMs });
    if (!url) throw new CloudError("The server started, but Wisp didn't answer over HTTPS in time. It may still be installing.");
    server.url = url;

    onStep("account");
    const session = await claim(url, key, account, { fetchImpl });
    return { url, session, server };
  } catch (err) {
    err.server = server;
    err.key = key;
    throw err;
  }
}

/** Poll the server's addresses until one is a Wisp over valid HTTPS. */
async function waitForHub(ip, { fetchImpl = fetch, sleep = sleepFor, ms = 15 * 60_000 } = {}) {
  for (const until = Date.now() + ms; Date.now() <= until; await sleep(5000)) {
    for (const url of hubUrls(ip)) {
      try {
        const res = await fetchImpl(new URL("/api/setup", url), { signal: AbortSignal.timeout(5000) });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (body && typeof body.needsSetup === "boolean") return url;
      } catch {} // not up yet, or no certificate yet
    }
  }
  return null;
}

/** Make the first account, with the setup key the server only lets this app use. */
async function claim(url, key, { name, email, password }, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  try {
    const res = await fetchImpl(new URL("/api/setup", url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-wisp-setup-key": key },
      body: JSON.stringify({ name, email, password, workspaceName: "Wisp" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch((err) => { if (timedOut(err)) throw err; return {}; });
    if (res.status === 409) throw new CloudError("Someone already made the first account on this server.");
    if (!res.ok || !body.token) throw new CloudError(body.error ? `Wisp said: ${body.error}` : `Wisp said ${res.status}`);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone)
      await fetchImpl(new URL("/api/me", url), { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${body.token}` }, body: JSON.stringify({ timezone }), signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
    return body.token;
  } catch (err) {
    if (timedOut(err)) throw timeoutError();
    throw err;
  }
}

/** Delete a server this flow created (when the person gives up on one that didn't come up). */
async function deleteServer(token, id, opts) {
  await hetzner(token, "DELETE", `/servers/${id}`, null, opts);
}

module.exports = { CloudError, plans, userData, templatePath, hubUrls, createWisp, waitForHub, claim, deleteServer, PLACEHOLDER };
