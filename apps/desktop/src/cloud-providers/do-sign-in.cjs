const crypto = require("node:crypto");
const http = require("node:http");
const { envVar } = require("../env.cjs");
const { CloudError } = require("./shared.cjs");
// "Sign in with DigitalOcean": DigitalOcean lets a desktop app register itself as a public OAuth
// client (no secret, nothing set up ahead of time) and sign the person in through their browser
// with PKCE, back to a one-off address on this computer. The token it gets lasts an hour, only
// allows servers, and is revoked once setup is done.

const base = () => envVar("DIGITALOCEAN_OAUTH", process.env) ?? "https://cloud.digitalocean.com/v1/oauth";
const SCOPES = ["droplet:create", "droplet:read", "droplet:delete", "sizes:read", "regions:read", "image:read"];

const DONE_PAGE = (ok) => `<!doctype html><meta charset="utf-8"><title>Wisp</title><body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#17171a"><p>${ok ? "Signed in. You can close this tab and go back to Wisp." : "Sign-in didn't finish. Go back to Wisp and try again."}</p></body>`;

async function post(url, body, { fetchImpl = fetch, form = false } = {}) {
  let res;
  try {
    res = await fetchImpl(new URL(url), {
      method: "POST",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CloudError(`Couldn't reach DigitalOcean (${err.cause?.code || err.message}). Check your internet connection.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloudError(`DigitalOcean didn't finish the sign-in: ${data.error_description || data.message || data.error || res.status}. Try again.`);
  return data;
}

/**
 * Sign in: register, open the browser, wait for it to come back (up to `timeoutMs`), and trade the
 * code for a token. `cancel()` on the returned handle stops waiting.
 */
function signIn({ openExternal, fetchImpl = fetch, timeoutMs = 10 * 60_000 } = {}) {
  let cancel = () => {};
  const done = new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    let redirect = "";
    let clientId = "";
    let finished = false;
    const finish = (err, token) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(token);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = url.searchParams.get("code");
      const ok = !!code && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE(ok));
      if (!ok) return finish(new CloudError(url.searchParams.get("error") === "access_denied" ? "The sign-in was cancelled in DigitalOcean. Try again when you're ready." : "DigitalOcean's sign-in didn't come back right. Try again."));
      try {
        const t = await post(`${base()}/token`, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: redirect }, { fetchImpl, form: true });
        if (!t.access_token) throw new CloudError("DigitalOcean didn't send a sign-in token. Try again.");
        finish(null, t.access_token);
      } catch (err) {
        finish(err);
      }
    });
    const timer = setTimeout(() => finish(new CloudError("The sign-in took too long. Try again.")), timeoutMs);
    cancel = () => finish(Object.assign(new CloudError("Sign-in cancelled."), { cancelled: true }));
    server.on("error", (err) => finish(new CloudError(`Couldn't start the sign-in (${err.message}).`)));
    server.listen(0, "127.0.0.1", async () => {
      redirect = `http://127.0.0.1:${server.address().port}/callback`;
      try {
        const client = await post(`${base()}/register`, { client_name: "Wisp", client_uri: "https://github.com/eireijie/wisp", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }, { fetchImpl });
        clientId = client.client_id;
        if (!clientId) throw new CloudError("DigitalOcean didn't register Wisp for sign-in. Try again.");
        const auth = new URL(`${base()}/authorize`);
        for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: SCOPES.join(" "), state }))
          auth.searchParams.set(k, v);
        await openExternal(auth.href);
      } catch (err) {
        finish(err);
      }
    });
  });
  return { done, cancel: () => cancel() };
}

/** End a signed-in token early, once setup no longer needs it. Failing is fine: it expires in an hour. */
async function revoke(token, { fetchImpl = fetch } = {}) {
  await fetchImpl(new URL(`${base()}/revoke`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

module.exports = { signIn, revoke, SCOPES };
