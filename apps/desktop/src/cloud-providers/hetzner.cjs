const { envVar } = require("../env.cjs");
const { CloudError, apiCall, round } = require("./shared.cjs");
// Hetzner Cloud: the person's own project, billed to them by the hour.

const NAME = "Hetzner";
/** Override the API to run the whole flow against a mock. */
const base = () => envVar("HETZNER_API", process.env) ?? "https://api.hetzner.cloud/v1";

function explain(res, data) {
  const code = data.error?.code;
  const message = data.error?.message || `Hetzner said ${res.status}`;
  if (res.status === 403 || code === "forbidden") return new CloudError("That token can only read. Make a new one with Read & Write access.");
  if (code === "resource_limit_exceeded") return new CloudError(`Your Hetzner project is at its limit: ${message}. Ask Hetzner to raise it, or delete a server you don't need.`);
  if (code === "resource_unavailable") return new CloudError("Hetzner has no servers of that size left in that location right now. Pick another size or location.");
  if (code === "account_locked" || /verif|unverified/i.test(message)) return new CloudError("Hetzner hasn't finished checking your account. Look for their email, finish the check, then try again.");
  return new CloudError(message);
}

const call = (token, method, route, body, { fetchImpl } = {}) => apiCall({ name: NAME, base: base(), token, method, route, body, explain, fetchImpl });

/** Every page of a list (server types are more than one page). */
async function all(token, route, key, opts) {
  const out = [];
  for (let page = 1; page; ) {
    const data = await call(token, "GET", `${route}${route.includes("?") ? "&" : "?"}page=${page}&per_page=50`, null, opts);
    out.push(...(data[key] || []));
    page = data.meta?.pagination?.next_page || 0;
  }
  return out;
}

const money = (p) => Number(p?.price_monthly?.gross ?? NaN);

/**
 * Each shared-CPU size with 2–16 GB in each location, priced with the IPv4 address (Hetzner bills
 * that separately). Prices come from Hetzner every time, so they're whatever Hetzner charges today.
 */
async function plans(token, opts = {}) {
  const [types, pricing, locations] = await Promise.all([
    all(token, "/server_types", "server_types", opts),
    call(token, "GET", "/pricing", null, opts),
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
  const used = new Set(list.map((p) => p.location));
  return {
    currency,
    locations: locations.filter((l) => used.has(l.name)).map((l) => ({ name: l.name, city: l.city, country: l.country, zone: l.network_zone })),
    plans: list,
  };
}

async function create(token, { name, type, location, userData }, opts) {
  const created = await call(token, "POST", "/servers", {
    name,
    server_type: type,
    location,
    image: "ubuntu-24.04",
    user_data: userData,
    labels: { "managed-by": "wisp" },
    public_net: { enable_ipv4: true, enable_ipv6: true },
  }, opts);
  return { id: created.server.id, ip: created.server.public_net?.ipv4?.ip || "" };
}

async function status(token, id, opts) {
  const s = (await call(token, "GET", `/servers/${id}`, null, opts)).server;
  return { running: s.status === "running", ip: s.public_net?.ipv4?.ip || "" };
}

async function remove(token, id, opts) {
  await call(token, "DELETE", `/servers/${id}`, null, opts);
}

module.exports = {
  id: "hetzner",
  name: NAME,
  apiHost: "api.hetzner.cloud",
  signInUrl: "https://console.hetzner.com/projects",
  billingUrl: "https://accounts.hetzner.com/",
  // Hetzner API tokens are 64 letters and digits
  looksLikeToken: (text) => /^[A-Za-z0-9]{64}$/.test(text),
  plans,
  create,
  status,
  remove,
};
