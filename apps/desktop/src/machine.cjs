// Whether this computer is a laptop (it has a battery), so the first setup question can be
// answered before it's asked: a laptop sleeps and travels, so Cloud is recommended.
const { execFile } = require("node:child_process");
const fs = require("node:fs");

const out = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout))));

async function hasBattery(platform = process.platform) {
  try {
    if (platform === "darwin") return /InternalBattery/.test(await out("pmset", ["-g", "batt"]));
    if (platform === "win32") return Number((await out("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery | Measure-Object).Count"])).trim()) > 0;
    return fs.readdirSync("/sys/class/power_supply").some((n) => n.startsWith("BAT"));
  } catch {
    return false;
  }
}

module.exports = { hasBattery };
