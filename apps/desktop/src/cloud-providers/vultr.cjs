const { envVar } = require("../env.cjs");
const { CloudError, apiCall, round } = require("./shared.cjs");
// Vultr: the person's own account, billed by the hour up to a monthly cap, same price in every region.

const NAME = "Vultr";
const base = () => envVar("VULTR_API", process.env) ?? "https://api.vultr.com/v2";

function explain(res, data) {
  const message = data.error || `Vultr said ${res.status}`;
  if (res.status === 403 && /ip/i.test(message)) return new CloudError("Vultr only accepts this API key from certain addresses. In Vultr, open Account, API, and allow all IPv4 and IPv6 addresses, then try again.");
  if (res.status === 403) return new CloudError("That API key isn't allowed to create servers. Turn the API on in Vultr under Account, API, then copy the key again.");
  if (/limit/i.test(message)) return new CloudError(`Your Vultr account is at its limit: ${message} Delete a server you don't need, or ask Vultr to raise it.`);
  if (/billing|payment|credit|fund/i.test(message)) return new CloudError("Vultr needs a payment method first. Add one under Billing in Vultr, then try again.");
  if (/not available|unavailable|sold out/i.test(message)) return new CloudError("Vultr has no servers of that size left in that region right now. Pick another size or region.");
  return new CloudError(message);
}

const call = (token, method, route, body, { fetchImpl } = {}) => apiCall({ name: NAME, base: base(), token, method, route, body, explain, fetchImpl });

async function all(token, route, key, opts) {
  const out = [];
  for (let cursor = ""; ; ) {
    const data = await call(token, "GET", `${route}${route.includes("?") ? "&" : "?"}per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, null, opts);
    out.push(...(data[key] || []));
    cursor = data.meta?.links?.next || "";
    if (!cursor) return out;
  }
}

/** Regular shared-CPU sizes ("vc2") with 2–16 GB, in each region that has them. */
async function plans(token, opts = {}) {
  const [list0, regions] = await Promise.all([all(token, "/plans?type=vc2", "plans", opts), all(token, "/regions", "regions", opts)]);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const list = [];
  for (const p of list0) {
    const gb = p.ram / 1024;
    if (gb < 2 || gb > 16) continue;
    for (const loc of p.locations) {
      if (!byId.has(loc)) continue;
      list.push({ type: p.id, location: loc, cores: p.vcpu_count, memory: gb, disk: p.disk, arch: "x86", monthly: round(p.monthly_cost), server: round(p.monthly_cost), ipv4: 0 });
    }
  }
  const used = new Set(list.map((p) => p.location));
  return {
    currency: "USD",
    locations: regions.filter((r) => used.has(r.id)).map((r) => ({ name: r.id, city: r.city, country: r.country, zone: r.continent })),
    plans: list,
  };
}

/** Vultr names images by number; find Ubuntu 24.04 rather than trusting one. */
async function ubuntu(token, opts) {
  const os = (await all(token, "/os", "os", opts)).find((o) => /^Ubuntu 24\.04/.test(o.name) && o.arch === "x64");
  if (!os) throw new CloudError("Vultr doesn't offer Ubuntu 24.04 right now.");
  return os.id;
}

async function create(token, { name, type, location, userData }, opts) {
  const created = await call(token, "POST", "/instances", {
    region: location,
    plan: type,
    os_id: await ubuntu(token, opts),
    label: name,
    hostname: name,
    user_data: Buffer.from(userData).toString("base64"),
    enable_ipv6: true,
    tags: ["wisp"],
  }, opts);
  return { id: created.instance.id, ip: realIp(created.instance.main_ip) };
}

// a new instance says 0.0.0.0 until it has its address
const realIp = (ip) => (ip && ip !== "0.0.0.0" ? ip : "");

async function status(token, id, opts) {
  const i = (await call(token, "GET", `/instances/${id}`, null, opts)).instance;
  return { running: i.status === "active" && i.power_status === "running", ip: realIp(i.main_ip) };
}

async function remove(token, id, opts) {
  await call(token, "DELETE", `/instances/${id}`, null, opts);
}

module.exports = {
  id: "vultr",
  name: NAME,
  apiHost: "api.vultr.com",
  signInUrl: "https://my.vultr.com/settings/#settingsapi",
  billingUrl: "https://my.vultr.com/billing/",
  // Vultr API keys are 36 capital letters and digits
  looksLikeToken: (text) => /^[A-Z0-9]{36}$/.test(text),
  plans,
  create,
  status,
  remove,
};
