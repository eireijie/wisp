// electron-builder hook: put the Warren that scripts/bundle-warren.mjs staged into the app's
// Resources/warren. Copied here rather than through `extraResources` so npm's workspace links
// (node_modules/@wisp/* → ../../packages/*) stay links.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const from = path.join(context.packager.info.projectDir, "build", "warren-runtime");
  if (!fs.existsSync(path.join(from, "bin", "warren.mjs"))) throw new Error("Warren isn't staged; run `npm run bundle -w @wisp/desktop` first");
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const to = path.join(resources, "warren");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
};
