#!/usr/bin/env node
// Builds the Wisp the desktop app carries inside it, so a downloaded app can run a hub and be a
// device without Node.js or a clone of the repo: the hub, the device, wisp-mcp and the web app,
// with their production dependencies. The app runs it
// with its own binary as Node (ELECTRON_RUN_AS_NODE), the same `bin/wisp.mjs` a terminal runs.
//
//   node apps/desktop/scripts/bundle-wisp.mjs   → apps/desktop/build/wisp-runtime
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import env from "../src/env.cjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const repo = path.resolve(desktop, "../..");
const out = path.join(desktop, "build", "wisp-runtime");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
// WISP_BUNDLE_ARCH=x64 bundles for Intel on an Apple silicon Mac: native modules come prebuilt for that processor
const arch = env.envVar("BUNDLE_ARCH");

console.log("building the web app");
run(npm, ["run", "build"], repo);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const skip = (src) => !/[\\/](node_modules|test|\.DS_Store)([\\/]|$)/.test(path.relative(repo, src));
const copy = (rel) => fs.cpSync(path.join(repo, rel), path.join(out, rel), { recursive: true, filter: skip });

for (const rel of ["bin", "apps/hub", "apps/node", "apps/web/dist", "docker/computer", "docker/cloud-init.yaml", "install.sh", "install.ps1", "LICENSE"]) copy(rel);
for (const pkg of fs.readdirSync(path.join(repo, "packages"))) copy(`packages/${pkg}`);

// a better-sqlite3 with Node-API prebuilds, which load in any Node or Electron on every platform
// (11.x is built per Node version and doesn't compile against this Electron's V8)
const SQLITE = "^13.0.3";
const root = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify({ name: "wisp-runtime", private: true, version: root.version, type: "module", license: root.license, workspaces: ["apps/hub", "apps/node", "packages/*"], dependencies: { ...root.dependencies, "better-sqlite3": SQLITE }, overrides: { "better-sqlite3": SQLITE } }, null, 2),
);

console.log("installing production dependencies");
run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", ...(arch ? [`--cpu=${arch}`] : [])], out, arch ? { npm_config_arch: arch, npm_config_target_arch: arch } : {});

fs.rmSync(path.join(out, "package-lock.json"), { force: true });
console.log(`Wisp runtime ready in ${path.relative(repo, out)}`);
