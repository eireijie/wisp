/** True only for an exact loopback hostname or address, never a hostname prefix. */
export function isLocalOnlyHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255));
}
