// What every cloud provider shares: one error type, and an API call that says its failures the way
// a person needs to hear them.

class CloudError extends Error {}
const timedOut = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";
const timeoutError = () => Object.assign(new CloudError("The request timed out. Try again."), { code: "timed_out", retryable: true });
const round = (n) => Math.round(n * 100) / 100;

/**
 * One JSON API call to a provider. `explain(res, data)` turns a failed answer into a CloudError
 * (or returns nothing for the provider's own message to be used).
 */
async function apiCall({ name, base, token, method, route, body, explain, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(new URL(base + route), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (timedOut(err)) throw timeoutError();
    throw new CloudError(`Couldn't reach ${name} (${err.cause?.code || err.message}). Check your internet connection.`);
  }
  if (res.status === 204) return {};
  const data = await res.json().catch((err) => { if (timedOut(err)) throw timeoutError(); return {}; });
  if (res.ok) return data;
  if (res.status === 401) throw new CloudError(`${name} didn't accept that token. Copy it again, all of it.`);
  if (res.status === 429) throw new CloudError(`${name} is limiting requests. Wait a minute and try again.`);
  throw explain(res, data) || new CloudError(`${name} said ${res.status}`);
}

module.exports = { CloudError, timedOut, timeoutError, round, apiCall };
