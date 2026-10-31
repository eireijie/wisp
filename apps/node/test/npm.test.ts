import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findNpmDir, npmFolders, withDir } from "../src/npm.ts";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-npm-"));
  temporary.push(d);
  return d;
};

describe.skipIf(process.platform === "win32")("finding npm", () => {
  it("is found in a folder a GUI app's short PATH misses (nvm), picking the newest version", () => {
    const h = home();
    for (const v of ["v20.1.0", "v22.4.0", "v9.0.0"]) {
      fs.mkdirSync(path.join(h, ".nvm/versions/node", v, "bin"), { recursive: true });
      fs.writeFileSync(path.join(h, ".nvm/versions/node", v, "bin/npm"), "");
    }
    const folders = npmFolders({ PATH: "/nowhere" }, "linux", h).filter((d) => d.startsWith(h));
    const nvm = folders.filter((d) => d.includes(".nvm"));
    expect(nvm[0]).toBe(path.join(h, ".nvm/versions/node/v22.4.0/bin"));
    expect(nvm).toHaveLength(3);
  });
  it("is found again after Node.js is installed, without restarting", () => {
    const h = home();
    const bin = path.join(h, "bin");
    fs.mkdirSync(bin);
    const env = { PATH: bin };
    const before = findNpmDir(env, "linux", h);
    fs.writeFileSync(path.join(bin, "npm"), "");
    expect(findNpmDir(env, "linux", h)).toBe(bin);
    expect(before).not.toBe(bin);
  });
  it("puts npm's folder first on the PATH its children get, so npm finds node", () => {
    expect(withDir("/x/bin", { PATH: "/usr/bin" }).PATH).toBe("/x/bin:/usr/bin");
    expect(withDir("/usr/bin", { PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });
});
