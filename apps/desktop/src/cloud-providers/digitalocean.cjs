const { envVar } = require("../env.cjs");
const { CloudError, apiCall, round } = require("./shared.cjs");
// DigitalOcean: the person's own account, billed to them by the second up to a monthly cap. The one
// provider a person can connect by signing in (see do-sign-in.cjs) instead of copying a token.

const NAME = "DigitalOcean";
const base = () => envVar("DIGITALOCEAN_API", process.env) ?? "https://api.digitalocean.com/v2";

function explain(res, data) {
  const message = data.message || `DigitalOcean said ${res.status}`;
  if (res.status === 403) return new CloudError("That sign-in can't create servers. Sign in again and allow creating, reading and deleting Droplets.");
  if (/droplet limit/i.test(message)) return new CloudError(`Your DigitalOcean account is at its server limit: ${message} Delete a server you don't need, or ask DigitalOcean to raise the limit.`);
  if (/payment|billing|credit card|verify/i.test(message)) return new CloudError("DigitalOcean needs a payment method first. Add a card or PayPal on your DigitalOcean billing page, then try again.");
  if (/not available|unavailable|sold out/i.test(message)) return new CloudError("DigitalOcean has no servers of that size left in that region right now. Pick another size or region.");
  return new CloudError(message);
}

const call = (token, method, route, body, { fetchImpl } = {}) => apiCall({ name: NAME, base: base(), token, method, route, body, explain, fetchImpl });

async function all(token, route, key, opts) {
  const out = [];
  for (let page = 1; page; page++) {
    const data = await call(token, "GET", `${route}?page=${page}&per_page=200`, null, opts);
    out.push(...(data[key] || []));
    if (!data.links?.pages?.next) break;
  }
  return out;
}

/** Basic (shared-CPU, regular SSD) sizes with 2–16 GB, in each region that has them. */
async function plans(token, opts = {}) {
  const [sizes, regions] = await Promise.all([all(token, "/sizes", "sizes", opts), all(token, "/regions", "regions", opts)]);
  const open = new Map(regions.filter((r) => r.available).map((r) => [r.slug, r]));
  const list = [];
  for (const s of sizes) {
    const gb = s.memory / 1024;
    if (!s.available || !/^s-\d+vcpu-\d+gb$/.test(s.slug) || gb < 2 || gb > 16) continue;
    for (const slug of s.regions) {
      if (!open.has(slug)) continue;
      list.push({ type: s.slug, location: slug, cores: s.vcpus, memory: gb, disk: s.disk, arch: "x86", monthly: round(s.price_monthly), server: round(s.price_monthly), ipv4: 0 });
    }
  }
  const used = new Set(list.map((p) => p.location));
  return {
    currency: "USD",
    locations: [...open.values()].filter((r) => used.has(r.slug)).map((r) => ({ name: r.slug, ...place(r) })),
    plans: list,
  };
}

/** "New York 3" → New York, US. DigitalOcean only names its regions, so the country is from the slug. */
const COUNTRY = { nyc: "US", sfo: "US", atl: "US", tor: "CA", lon: "GB", ams: "NL", fra: "DE", sgp: "SG", blr: "IN", syd: "AU" };
function place(r) {
  return { city: r.name.replace(/\s+\d+$/, ""), country: COUNTRY[r.slug.slice(0, 3)] ?? "" };
}

async function create(token, { name, type, location, userData }, opts) {
  const created = await call(token, "POST", "/droplets", { name, region: location, size: type, image: "ubuntu-24-04-x64", user_data: userData, ipv6: true, monitoring: false }, opts);
  return { id: created.droplet.id, ip: publicIp(created.droplet) };
}

const publicIp = (d) => d?.networks?.v4?.find((n) => n.type === "public")?.ip_address || "";

async function status(token, id, opts) {
  const d = (await call(token, "GET", `/droplets/${id}`, null, opts)).droplet;
  return { running: d.status === "active", ip: publicIp(d) };
}

async function remove(token, id, opts) {
  await call(token, "DELETE", `/droplets/${id}`, null, opts);
}

module.exports = {
  id: "digitalocean",
  name: NAME,
  apiHost: "api.digitalocean.com",
  signInUrl: "https://cloud.digitalocean.com/registrations/new",
  billingUrl: "https://cloud.digitalocean.com/account/billing",
  signIn: true,
  // personal access tokens start dop_v1_; signed-in ones come from do-sign-in.cjs
  looksLikeToken: (text) => /^do[opr]_v1_[a-f0-9]{64}$/.test(text),
  plans,
  create,
  status,
  remove,
};
