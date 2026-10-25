const { isIP } = require("node:net");
const { candidates } = require("./engine.cjs");

/** Accept an invite wherever an address was accepted, without losing its secret. */
function parseTarget(input) {
  const text = String(input || "").trim();
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch {}
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Paste a Wisp invite link or address.");
  const match = url.pathname.match(/^\/join\/([^/]+)\/?$/);
  if (url.pathname.startsWith("/join") && !match) throw new Error("That invite link is incomplete.");
  return { origins: match ? [url.origin] : candidates(text), invite: match ? decodeURIComponent(match[1]) : undefined };
}

function serviceWisp(service) {
  const txt = service.txt || {};
  if (String(txt.v) !== "1" || !txt.id || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null;
  const addresses = (service.addresses || []).filter((a) => isIP(a) && a !== "::1" && !/^(127\.|169\.254\.|fe[89ab])/i.test(a));
  const address = addresses.find((a) => isIP(a) === 4) || addresses[0];
  if (!address) return null;
  return { id: String(txt.id), name: String(txt.name || service.name || "Your Wisp"), host: String(txt.host || service.host || "the computer Wisp lives on"), url: `http://${isIP(address) === 6 ? `[${address}]` : address}:${service.port}` };
}

/** Bonjour stays in the main process and is always torn down after the short scan. */
class Discovery {
  constructor(loadBonjour) { this.loadBonjour = loadBonjour; }
  cancel() { this.finish?.(); }
  browse(ms = 4000) {
    this.cancel();
    return new Promise((resolve) => {
      let bonjour, browser, timer;
      let settled = false;
      const found = new Map();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.finish = null;
        try { browser?.stop(); } catch {}
        try { bonjour?.destroy(); } catch {}
        resolve({ ok: !error, wisps: [...found.values()], ...(error ? { error: "Couldn't search this Wi-Fi; you can paste an invite link." } : {}) });
      };
      this.finish = () => finish();
      try {
        const { Bonjour } = this.loadBonjour();
        bonjour = new Bonjour(undefined, () => finish(true));
        if (settled) { bonjour.destroy(); return; }
        browser = bonjour.find({ type: "wisp", protocol: "tcp" }, (service) => {
          const wisp = serviceWisp(service);
          if (wisp) found.set(wisp.id, wisp);
        });
        if (settled) { browser.stop(); return; }
        browser.on("down", (service) => { if (service.txt?.id) found.delete(String(service.txt.id)); });
        timer = setTimeout(() => finish(), ms);
      } catch { finish(true); }
    });
  }
}

/** Never expose join secrets or device credentials to the setup renderer. */
class JoinClient {
  constructor({ fetchImpl = (...args) => fetch(...args), name, platform }) {
    this.fetch = fetchImpl;
    this.name = name;
    this.platform = platform;
    this.cancel();
  }
  cancel() { this.generation = (this.generation || 0) + 1; this.pending = null; }
  async request(input) {
    this.cancel();
    const generation = this.generation;
    const target = parseTarget(input);
    let lastError;
    for (const origin of target.origins) {
      if (generation !== this.generation) return { ok: false, cancelled: true };
      let res;
      try {
        res = await this.fetch(new URL("/api/join/requests", origin), {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
          body: JSON.stringify({ name: this.name(), kind: "computer", platform: this.platform, ...(target.invite ? { invite: target.invite } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch { lastError = new Error("Couldn't reach your Wisp; check the link and your Wi-Fi."); continue; }
      const body = await res.json().catch(() => null);
      if (generation !== this.generation) return { ok: false, cancelled: true };
      if (!res.ok) throw new Error(res.status === 403 ? "Ask for a new invite link from your Wisp." : res.status === 429 ? "Too many attempts; try again in a minute." : "Couldn't ask to join your Wisp; try again.");
      if (!body || typeof body.requestId !== "string" || !body.requestId || typeof body.secret !== "string" || !body.secret || typeof body.code !== "string" || !/^\d{6}$/.test(body.code) || !Number.isFinite(Date.parse(body.expiresAt))) throw new Error("Your Wisp returned an incomplete request; try again.");
      this.pending = { origin, requestId: body.requestId, secret: body.secret, expiresAt: body.expiresAt };
      return { ok: true, code: body.code, expiresAt: body.expiresAt, host: new URL(origin).hostname };
    }
    throw lastError || new Error("Paste a Wisp invite link or address.");
  }
  async poll() {
    const pending = this.pending;
    if (!pending) return { status: "expired" };
    if (pending.approved) return pending.approved;
    if (Date.now() >= Date.parse(pending.expiresAt)) return { status: "expired" };
    // A credential is returned once, so simultaneous IPC calls must share one read.
    if (pending.reading) return pending.reading;
    pending.reading = (async () => {
      const res = await this.fetch(new URL(`/api/join/requests/${encodeURIComponent(pending.requestId)}`, pending.origin), {
        headers: { "x-join-secret": pending.secret }, signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (res.status === 404 || res.status === 410) return { status: "expired" };
      if (!res.ok) throw new Error("Couldn't check approval; trying again…");
      const body = await res.json();
      if (pending !== this.pending) return { status: "expired" };
      if (!["pending", "approved", "denied", "expired"].includes(body.status)) throw new Error("Couldn't check approval; trying again…");
      if (body.status === "approved") {
        if (typeof body.nodeId !== "string" || !body.nodeId || typeof body.nodeToken !== "string" || !body.nodeToken) return { status: "expired" };
        // The address used to ask is known to work from this computer (the returned
        // hubUrl can be localhost or an owner-only address). Keep that reachable origin.
        pending.approved = { ...body, hubUrl: pending.origin };
      }
      return pending.approved || { status: body.status };
    })();
    try { return await pending.reading; } finally { pending.reading = null; }
  }
}

module.exports = { parseTarget, serviceWisp, Discovery, JoinClient };
