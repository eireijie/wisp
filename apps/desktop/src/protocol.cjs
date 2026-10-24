/** Old phones and saved links still use the original scheme. Never navigate to a link's hub URL. */
function isPairingLink(input) {
  try {
    const url = new URL(input);
    return ["wisp:", "warren:"].includes(url.protocol) && url.hostname === "pair" && (!url.pathname || url.pathname === "/");
  } catch { return false; }
}
function registerProtocols(app, { defaultApp = process.defaultApp, executable = process.execPath, entry = process.argv[1] } = {}) {
  for (const scheme of ["wisp", "warren"]) {
    if (defaultApp && entry) app.setAsDefaultProtocolClient(scheme, executable, [require("node:path").resolve(entry)]);
    else app.setAsDefaultProtocolClient(scheme);
  }
}
module.exports = { isPairingLink, registerProtocols };
