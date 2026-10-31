import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Shown when this computer has no Node.js; the setup screen recognises it and offers the download. */
export const NO_NODE = "Node.js isn't installed on this computer";

/** Folders a GUI-launched app or a service often misses, where Node.js and npm usually live. */
export function npmFolders(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string[] {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // the runtime's own folder helps only when it is Node (the desktop app's is Electron, with no npm beside it)
  if (!process.versions.electron) dirs.push(path.dirname(process.execPath));
  if (platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]) if (base) dirs.push(path.join(base, "nodejs"));
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
    if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
    if (env.NVM_HOME && env.NVM_SYMLINK === undefined) dirs.push(env.NVM_HOME);
    dirs.push(path.join(home, "scoop", "apps", "nodejs", "current"));
    return dirs;
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(home, ".local/bin"), path.join(home, ".volta/bin"), path.join(home, ".local/share/fnm/aliases/default/bin"), path.join(home, ".fnm/aliases/default/bin"));
  // nvm keeps each version in its own folder; take the newest
  for (const root of [env.NVM_DIR ? path.join(env.NVM_DIR, "versions/node") : "", path.join(home, ".nvm/versions/node")]) {
    if (!root) continue;
    try {
      const versions = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) dirs.push(path.join(root, v, "bin"));
    } catch {}
  }
  return dirs;
}

/** The folder with npm in it, or null when there is no Node.js to be found. */
export function findNpmDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string | null {
  const names = platform === "win32" ? ["npm.cmd"] : ["npm"];
  for (const dir of npmFolders(env, platform, home)) if (names.some((n) => fs.existsSync(path.join(dir, n)))) return dir;
  return null;
}

/** An environment where npm's own `node` can be found, even if the app was started with a short PATH. */
export function withDir(dir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const parts = (env.PATH ?? "").split(path.delimiter);
  return { ...env, PATH: parts.includes(dir) ? env.PATH : [dir, ...parts].filter(Boolean).join(path.delimiter), ELECTRON_RUN_AS_NODE: undefined };
}
