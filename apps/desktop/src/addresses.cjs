const os = require("node:os");
const { isIP } = require("node:net");

const isTailscale = (address) => {
  const parts = address.split(".").map(Number);
  return isIP(address) === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
};

/** Addresses other devices can use; keep this in sync with JOIN-SPEC.md. */
function reachableAddresses(port, interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (/^(docker\d*|br-.*|veth.*|vmnet.*)$/i.test(name) || /^bridge(\d+)$/i.test(name) && Number(name.slice(6)) >= 100) continue;
    for (const entry of entries || []) {
      const address = entry.address;
      const family = isIP(address);
      if (entry.internal || !family || /^169\.254\./.test(address) || /^127\./.test(address) || address === "::1") continue;
      if (/^utun/i.test(name) && !isTailscale(address)) continue;
      // Browsers cannot open scoped IPv6 link-local URLs; use the LAN IPv4/ULA instead.
      if (family === 6 && (/^fe[89ab]/i.test(address) || address === "::")) continue;
      if (address === "0.0.0.0") continue;
      out.add(`http://${family === 6 ? `[${address}]` : address}:${port}`);
    }
  }
  return [...out];
}

module.exports = { reachableAddresses, isTailscale };
