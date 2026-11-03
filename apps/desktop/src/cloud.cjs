const { envVar } = require("./env.cjs");
// "Cloud": a Wisp server in the person's own account at a cloud provider, billed to them by that
// provider. The app asks the provider for a server with docker/cloud-init.yaml as its first-boot
// script, waits until the hub answers over HTTPS, and makes the first account with the setup key
// only this app knows. The API token is only ever passed in, used and dropped: nothing here keeps or
// saves it. Each provider is one module in cloud-providers/ with the same five calls, so another
// one (a future Wisp Cloud included) is one more module.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { CloudError, timedOut, timeoutError } = require("./cloud-providers/shared.cjs");
const PROVIDERS = require("./cloud-providers/index.cjs");
const { nearestLocation } = require("./cloud-providers/places.cjs");

const PLACEHOLDER = "__WISP_SETUP_KEY__";

function provider(id = PROVIDERS[0].id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new CloudError(`Wisp doesn't know the cloud provider "${id}".`);
  return p;
}

/**
 * What can be created with this token: locations, and each size in each location with its monthly
 * price (including anything billed on top, like Hetzner's IPv4 address), cheapest first.
 */
async function plans(token, { provider: id, ...opts } = {}) {
  const r = await provider(id).plans(token, opts);
  r.plans.sort((a, b) => a.monthly - b.monthly || a.memory - b.memory);
  return r;
}

/**
 * The sizes offered at a location: the cheapest of each of 2, 4 and 8 GB (x86 first, so every agent
 * image runs), with the recommended one marked.
 */
function sizeChoices(list, location) {
  const here = list.filter((p) => p.location === location);
  const rec = recommendedPlan(here);
  const out = [];
  for (const gb of [2, 4, 8]) {
    const tier = here.filter((p) => p.memory === gb);
    const p = tier.find((x) => x.arch !== "arm") || tier[0];
    if (p) out.push({ ...p, recommended: p === rec });
  }
  if (rec && !out.some((p) => p.recommended)) out.push({ ...rec, recommended: true });
  return out.sort((a, b) => a.memory - b.memory);
}

/**
 * The size to start with: the cheapest with at least 4 GB (the hub and its device take about 1 GB,
 * and one agent's computer fits beside them), preferring x86 so every agent image runs, with Arm
 * only when x86 isn't there. A bigger server is a resize away when more agents get computers.
 */
function recommendedPlan(list) {
  const fits = (p) => p.memory >= RECOMMENDED_GB;
  return list.find((p) => fits(p) && p.arch !== "arm") || list.find(fits) || list[list.length - 1] || null;
}
const RECOMMENDED_GB = 4;

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
 * Create a Wisp in the person's cloud account and make its first account. `onStep(id)` hears
 * "create", "boot", "https" and "account" as each starts. On failure after the server exists, the
 * error carries it (`err.server`) and its setup key (`err.key`), so the person can delete it, or keep
 * waiting: `resume: { server, key }` picks the same server up again instead of creating another,
 * since only that key can make its first account.
 */
async function createWisp({ provider: id, token, type, location, account }, { fetchImpl = fetch, sleep = sleepFor, onStep = () => {}, bootMs = 5 * 60_000, httpsMs = 15 * 60_000, template, resume } = {}) {
  const opts = { fetchImpl };
  // a server left from before there was a choice of provider is a Hetzner one
  const cloud = provider(id ?? resume?.server?.provider ?? (resume ? "hetzner" : undefined));
  let key;
  let server;
  if (resume?.server?.id && resume.key) {
    key = resume.key;
    server = { provider: cloud.id, ...resume.server };
  } else {
    key = crypto.randomBytes(24).toString("base64url");
    const name = `wisp-${crypto.randomBytes(3).toString("hex")}`;
    onStep("create");
    const created = await cloud.create(token, { name, type, location, userData: userData(key, template) }, opts);
    server = { provider: cloud.id, id: created.id, name, ip: created.ip, location, type };
  }

  try {
    onStep("boot");
    for (const until = Date.now() + bootMs; ; ) {
      const s = await cloud.status(token, server.id, opts);
      server.ip = s.ip || server.ip;
      if (s.running && server.ip) break;
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
async function deleteServer(token, id, { provider: which, ...opts } = {}) {
  await provider(which).remove(token, id, opts);
}

module.exports = { CloudError, PROVIDERS, provider, plans, recommendedPlan, sizeChoices, nearestLocation, userData, templatePath, hubUrls, createWisp, waitForHub, claim, deleteServer, PLACEHOLDER };
