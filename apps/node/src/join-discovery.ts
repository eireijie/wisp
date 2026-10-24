import { createRequire } from "node:module";
import { isIP } from "node:net";

export interface NearbyWisp { id: string; name: string; host: string; url: string }
export interface Advertisement {
  name: string; host: string; port: number; addresses?: string[];
  txt?: Record<string, unknown>;
}
export interface DiscoveryClient {
  find(options: { type: string; protocol: string }, onUp: (service: Advertisement) => void): { stop(): void };
  destroy(): void;
}

// The terminal owns this dependency bundle, independently of the hub's dependencies.
const require = createRequire(new URL("../../../bin/package.json", import.meta.url));
export function createDiscovery(onError: (error: Error) => void): DiscoveryClient {
  const { Bonjour } = require("bonjour-service");
  return new Bonjour(undefined, onError);
}

export function nearbyWisp(service: Advertisement): NearbyWisp | null {
  const txt = service.txt ?? {};
  if (String(txt.v) !== "1" || !txt.id || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null;
  // Prefer a routable IPv4 address; .local names are not resolved on every Linux system.
  const addresses = service.addresses ?? [];
  const address = addresses.find((a) => isIP(a) === 4 && !a.startsWith("169.254."))
    ?? addresses.find((a) => isIP(a) === 6 && !/^fe[89ab]/i.test(a)) ?? service.host;
  if (!address) return null;
  const hostname = isIP(address) === 6 ? `[${address}]` : address;
  try {
    const url = new URL(`http://${hostname}:${service.port}`).origin;
    return { id: String(txt.id), name: String(txt.name || service.name || "Your Wisp"), host: String(txt.host || service.host), url };
  } catch { return null; }
}

/** Browse for four seconds, closing the multicast socket on success and failure. */
export async function discoverWisps(options: {
  durationMs?: number; create?: typeof createDiscovery; signal?: AbortSignal;
} = {}): Promise<NearbyWisp[]> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const found = new Map<string, NearbyWisp>();
    let client: DiscoveryClient | undefined;
    let browser: ReturnType<DiscoveryClient["find"]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      browser?.stop();
      client?.destroy();
      if (error) reject(error); else resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    };
    const abort = () => finish(options.signal?.reason ?? new Error("Stopped."));
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      client = (options.create ?? createDiscovery)((e) => finish(e));
      if (finished) { client.destroy(); return; }
      browser = client.find({ type: "wisp", protocol: "tcp" }, (service) => {
        const wisp = nearbyWisp(service);
        if (wisp) found.set(wisp.id, wisp);
      });
      if (finished) { browser.stop(); return; }
      timer = setTimeout(() => finish(), options.durationMs ?? 4000);
    } catch (e) { finish(e); }
  });
}
