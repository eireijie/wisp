// electron-builder hook: put the Wisp that scripts/bundle-wisp.mjs staged into the app's
// Resources/wisp. Copied here rather than through `extraResources` so npm's workspace links
// (node_modules/@wisp/* → ../../packages/*) stay links.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const from = path.join(context.packager.info.projectDir, "build", "wisp-runtime");
  if (!fs.existsSync(path.join(from, "bin", "wisp.mjs"))) throw new Error("Wisp isn't staged; run `npm run bundle -w @wisp/desktop` first");
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const to = path.join(resources, "wisp");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  // A Mac app signs every binary it carries, and native modules for other systems can't be signed or notarized.
  if (context.electronPlatformName === "darwin") {
    const prebuilds = path.join(to, "node_modules", "better-sqlite3", "prebuilds");
    if (fs.existsSync(prebuilds)) for (const f of fs.readdirSync(prebuilds)) if (!f.startsWith("darwin-")) fs.rmSync(path.join(prebuilds, f), { recursive: true });
  }
};
