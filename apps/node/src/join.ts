import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverWisps, type NearbyWisp } from "./join-discovery.ts";
import { installService } from "./service.ts";

export const INVITE_HINT = "Open Wisp on the computer it lives on, choose Add a device, then run: wisp join <invite-link>";
export interface JoinTarget { url: string; invite?: string; host: string }
export function joinTarget(raw: string): JoinTarget {
  const text = raw.trim().replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`); }
  catch { throw new Error("That link isn't valid; copy a new invite from Add a device in Wisp."); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) throw new Error("Use an http or https link from Wisp.");
  const match = url.pathname.match(/^\/join\/([^/]+)\/?$/);
  if (url.pathname !== "/" && !match) throw new Error("Copy the invite link from Add a device in Wisp.");
  return { url: url.origin, host: url.hostname, ...(match ? { invite: decodeURIComponent(match[1]) } : {}) };
}
interface Grant { nodeId: string; nodeToken: string; hubUrl: string; workspaceName: string; hubId?: string }
interface Request { requestId: string; secret: string; code: string; expiresAt: string }
export interface JoinOptions { dir: string; address?: string; name?: string; service?: boolean; signal?: AbortSignal }
export interface JoinDependencies {
  fetch: typeof fetch;
  discover: () => Promise<NearbyWisp[]>;
  say: (line: string) => void;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  install: (dir: string) => unknown;
  choose?: (wisps: NearbyWisp[]) => Promise<NearbyWisp>;
}

/** `--dir <folder>` when it isn't the default, so a printed follow-up command finds this computer's settings. */
const dirFlag = (dir: string) => (path.resolve(dir) === path.join(os.homedir(), ".wisp") ? "" : ` --dir ${JSON.stringify(dir)}`);

/** Persist credentials before starting the service; a service failure must not lose a one-use grant. */
export function saveJoinedComputer(dir: string, grant: Grant, name: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "node.json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const next = { ...saved, hub: joinTarget(grant.hubUrl).url, token: grant.nodeToken, nodeId: grant.nodeId, name, local: false, ...(grant.hubId ? { hubId: grant.hubId } : {}) };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export async function joinWisp(options: JoinOptions, overrides: Partial<JoinDependencies> = {}): Promise<Grant> {
  const deps: JoinDependencies = {
    fetch, discover: () => discoverWisps({ signal: options.signal }), say: console.log,
    sleep: (ms) => delay(ms, undefined, { signal: options.signal }), now: Date.now,
    install: (dir) => installService("node", dir), ...overrides,
  };
  const say = deps.say;
  say("Wisp");
  let target: JoinTarget;
  if (options.address) target = joinTarget(options.address);
  else {
    say("◌ Looking for your Wisp on this Wi-Fi…");
    let wisps: NearbyWisp[];
    try { wisps = await deps.discover(); }
    catch { throw new Error(`Couldn't look on this Wi-Fi; ${INVITE_HINT}`); }
    if (!wisps.length) throw new Error(`Couldn't find your Wisp on this Wi-Fi; ${INVITE_HINT}`);
    const selected = wisps.length === 1 ? wisps[0] : deps.choose ? await deps.choose(wisps) : null;
    if (!selected) throw new Error(`Found more than one Wisp; ${INVITE_HINT}`);
    target = { url: selected.url, host: selected.host };
    say(`✓ Found “${selected.name}” on this Wi-Fi`);
  }
  const name = options.name ?? os.hostname().split(".")[0];
  const request = async (route: string, init: RequestInit) => {
    options.signal?.throwIfAborted();
    let response: Response;
    try { response = await deps.fetch(`${target.url}${route}`, { ...init, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }); }
    catch { throw new Error("Couldn't reach your Wisp; check your Wi-Fi or copy a new invite link."); }
    if (!response.ok) throw new Error(response.status === 403 ? "This invite can't be used; copy a new one from Add a device in Wisp." : response.status === 429 ? "Too many join attempts; wait a minute and run wisp join again." : "Your Wisp couldn't finish joining; run wisp join again.");
    return response.json();
  };
  const pending = await request("/api/join/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, kind: "computer", platform: process.platform, ...(target.invite ? { invite: target.invite } : {}) }),
  }) as Request;
  if (!pending.requestId || !pending.secret || !/^\d{6}$/.test(pending.code) || !Number.isFinite(Date.parse(pending.expiresAt))) throw new Error("Your Wisp sent an incomplete reply; update Wisp and try again.");
  say(`Approve this computer on ${target.host}. It will show this code:`);
  say(`\n    ${pending.code.slice(0, 3)} ${pending.code.slice(3)}\n`);
  say("◌ Waiting for approval…");
  const deadline = Math.min(Date.parse(pending.expiresAt), deps.now() + 10 * 60_000);
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(2000, deadline - deps.now()));
    if (deps.now() >= deadline) break;
    const status = await request(`/api/join/requests/${encodeURIComponent(pending.requestId)}`, { headers: { "x-join-secret": pending.secret } });
    if (status.status === "pending") continue;
    if (status.status === "denied") throw new Error("This computer wasn't approved; run wisp join to try again.");
    if (status.status === "expired") break;
    if (status.status !== "approved") throw new Error("Your Wisp sent an incomplete reply; update Wisp and try again.");
    if (!status.nodeId || !status.nodeToken || !status.hubUrl || !status.workspaceName) throw new Error("Approval was already collected; run wisp join to ask again.");
    // Wisp's suggested address (Tailscale, say) works away from home too, but only keep it if this computer can reach it
    const suggested = joinTarget(status.hubUrl).url;
    const reachable = suggested === target.url || await deps.fetch(`${suggested}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
    saveJoinedComputer(options.dir, { ...(status as Grant), hubUrl: reachable ? suggested : target.url }, name);
    say("✓ Approved");
    if (options.service !== false) {
      try { await deps.install(options.dir); }
      catch { throw new Error(`Approval is saved; start this computer with: wisp service install node${dirFlag(options.dir)}`); }
      say(`✓ ${name} joined. Agents can work on this computer now.`);
    } else say(`✓ ${name} joined; connect with: wisp node start${dirFlag(options.dir)}`);
    return status as Grant;
  }
  throw new Error("The code expired; run wisp join to get a new one.");
}

/** The address a joined computer's Wisp has on this Wi-Fi now, when it moved (a new DHCP lease, say). */
export async function findMovedWisp(
  me: { hubId: string; nodeId: string; token: string }, current: string,
  discover: () => Promise<NearbyWisp[]> = () => discoverWisps(), fetcher: typeof fetch = fetch,
): Promise<string | null> {
  // https addresses (Tailscale, a domain) don't move with the Wi-Fi
  if (!/^http:/.test(current)) return null;
  const found = (await discover().catch(() => [])).find((w) => w.id === me.hubId);
  if (!found || found.url === joinTarget(current).url) return null;
  // anyone can announce this Wisp's id on the Wi-Fi; only the real one can answer this without seeing the credential
  const nonce = crypto.randomBytes(24).toString("base64url");
  const expected = crypto.createHmac("sha256", crypto.createHash("sha256").update(me.token).digest("hex")).update(`wisp-relocate:${nonce}`).digest("hex");
  try {
    const res = await fetcher(`${found.url}/api/join/prove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: me.nodeId, nonce }), signal: AbortSignal.timeout(5000) });
    const { macs } = (await res.json()) as { macs?: unknown };
    const ok = Array.isArray(macs) && macs.some((m) => typeof m === "string" && m.length === expected.length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(expected)));
    return ok ? found.url : null;
  } catch { return null; }
}
