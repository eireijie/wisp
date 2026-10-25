import os from "node:os";
import { BlockList, isIP } from "node:net";

const tailscale = new BlockList();
tailscale.addSubnet("100.64.0.0", 10, "ipv4");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
const local = new BlockList();
for (const [ip, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]] as const) local.addSubnet(ip, bits, "ipv4");
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");
local.addSubnet("fe80::", 10, "ipv6");
const family = (ip: string) => isIP(ip) === 6 ? "ipv6" : "ipv4";
export const isTailscaleAddress = (ip: string) => !!isIP(ip) && tailscale.check(ip, family(ip));
/** Use the socket peer, never an untrusted Forwarded/X-Forwarded-For header. */
export const isLocalJoinAddress = (ip: string) => !!isIP(ip) && local.check(ip, family(ip));

/** A credential-free HTTP(S) origin, safe to put in links and installer commands. */
export function httpOrigin(value: string | null | undefined): string | null {
  try {
    const u = new URL(value ?? "");
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

/** Addresses other devices can use, ordered page origin, LAN, then Tailscale. */
export function reachableAddresses(origin: string | null, port: number, interfaces = os.networkInterfaces()): string[] {
  const lan: string[] = [], tailnet: string[] = [];
  const excluded = new Set<string>(), included = new Set<string>();
  for (const [name, list] of Object.entries(interfaces)) for (const a of list ?? []) {
    const tail = isTailscaleAddress(a.address);
    if (a.internal || a.address.startsWith("169.254.") || (!tail && /^(docker|br-|veth|bridge|vmnet|virbr|vEthernet|utun|lo)/i.test(name))) {
      excluded.add(a.address);
      continue;
    }
    if (a.family !== "IPv4") continue;
    included.add(a.address);
    (tail ? tailnet : lan).push(`http://${a.address}:${port}`);
  }
  const out: string[] = [];
  const page = httpOrigin(origin);
  if (page) {
    const host = new URL(page).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const ownComputer = host === "localhost" || host === "0.0.0.0" || host === "::" || (!!isIP(host) && loopback.check(host, family(host)));
    if (!ownComputer && !host.startsWith("169.254.") && (!excluded.has(host) || included.has(host))) out.push(page);
  }
  return [...new Set([...out, ...lan, ...tailnet])];
}
