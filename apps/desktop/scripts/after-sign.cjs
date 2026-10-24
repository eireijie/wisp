// electron-builder hook: with no signing identity, electron-builder leaves the app unsigned, and
// after-pack.cjs has changed its Resources, so Electron's own ad-hoc signature no longer matches.
// Apple silicon won't open that ("Wisp is damaged"), so sign it ad hoc: it then opens with
// right-click → Open. A build with a real identity is already signed and left alone.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" });
    return;
  } catch {}
  console.log("  • signing ad hoc (no signing identity)");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
