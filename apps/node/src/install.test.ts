import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function fixture(oldNode = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-install-")); temporary.push(dir);
  const home = path.join(dir, "home with spaces"); const fake = path.join(dir, "tools");
  fs.mkdirSync(home); fs.mkdirSync(fake);
  const script = (name: string, body: string) => fs.writeFileSync(path.join(fake, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  script("node", oldNode ? `if [ "$1" = -p ]; then echo 18; else exec ${quote(process.execPath)} "$@"; fi` : `exec ${quote(process.execPath)} "$@"`);
  script("npm", 'printf "%s\\n" "$*" >> "$HOME/npm-calls"');
  script("git", `if [ "$1" = clone ]; then
    mkdir -p "$3/.git" "$3/bin"
    printf '%s\\n' 'console.log(JSON.stringify(process.argv.slice(2)))' > "$3/bin/warren.mjs"
  fi`);
  script("curl", 'exit 0');
  return { dir, home, fake, script, env: { ...process.env, HOME: home, WARREN_DIR: path.join(home, "warren"), PATH: `${fake}:${process.env.PATH}`, SHELL: "/bin/zsh" } };
}
function run(f: ReturnType<typeof fixture>, args: string[]) {
  return execFileSync("/bin/sh", [path.join(root, "install.sh"), ...args], { env: f.env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
}

describe("service runtime", () => {
  it("keeps npm beside the selected runtime available in service children", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../../../bin/keeper.mjs", import.meta.url).href)}); console.log(process.env.PATH)`], { env: { ...process.env, PATH: "/empty-service-path" }, encoding: "utf8" });
    expect(output.trim().split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("POSIX installer", () => {
  it("runs with sh, defaults to start mode without questions and creates persistent aliases", () => {
    const f = fixture();
    const output = run(f, ["--no-service", "--no-open"]);
    expect(output).toContain("Wisp\n"); expect(output).toContain("✓ Downloaded Wisp"); expect(output).toContain("Stuck? → wisp doctor");
    expect(output).not.toMatch(/Choose|\[Y\/n\]/);
    expect(fs.readFileSync(path.join(f.home, "npm-calls"), "utf8")).toContain("run build --silent");
    expect(fs.readFileSync(path.join(f.home, "npm-calls"), "utf8")).toContain("ci --prefix bin");
    const bin = path.join(f.home, ".local/bin");
    expect(execFileSync(path.join(bin, "wisp"), ["doctor"], { env: f.env, encoding: "utf8" }).trim()).toBe('["doctor"]');
    expect(fs.readFileSync(path.join(bin, "wisp"), "utf8")).toBe(fs.readFileSync(path.join(bin, "warren"), "utf8"));
    expect(fs.readFileSync(path.join(f.home, ".zshrc"), "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
  }, 30_000);
  it("defaults to starting Wisp and the local device service", () => {
    const f = fixture();
    const output = run(f, ["--no-open"]);
    expect(output).toContain("✓ Started Wisp (starts again when you log in)");
    expect(output).toContain("Opening Wisp in your browser… http://localhost:");
    const log = fs.readFileSync(path.join(f.home, ".warren/install.log"), "utf8");
    expect(log).toContain('["service","install","hub"]');
    expect(log).toContain('["service","install","node","--local"]');
  }, 30_000);
  it("passes join, invite and legacy flags without building the web app", () => {
    const f = fixture();
    const output = run(f, ["join", "https://wisp.example/join/hello", "--no-service", "--name", "My Laptop"]);
    expect(output).toContain('["join","https://wisp.example/join/hello","--name","My Laptop","--no-service"]');
    expect(fs.readFileSync(path.join(f.home, "npm-calls"), "utf8")).not.toContain("run build");
  }, 30_000);
  it("accepts an invite in the old --hub option", () => {
    const f = fixture();
    expect(run(f, ["--hub", "https://wisp.example/join/hello", "--no-service"])).toContain('["join","https://wisp.example/join/hello","--no-service"]');
  }, 30_000);
  it("downloads and checks Node 22 when the system runtime is old", () => {
    const f = fixture(true);
    const runtime = path.join(f.dir, "archive/bin"); fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "node"), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(runtime, "npm"), `#!/bin/sh\nexec ${quote(path.join(f.fake, "npm"))} "$@"\n`, { mode: 0o755 });
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const archive = `node-v22.23.4-${process.platform}-${arch}.tar.gz`;
    execFileSync("tar", ["-czf", path.join(f.dir, archive), "-C", f.dir, "archive"]);
    const checksum = createHash("sha256").update(fs.readFileSync(path.join(f.dir, archive))).digest("hex");
    fs.writeFileSync(path.join(f.dir, "SHASUMS256.txt"), `${checksum}  ${archive}\n`);
    f.script("curl", `case "$2" in *SHASUMS256.txt) cp ${quote(path.join(f.dir, "SHASUMS256.txt"))} "$4" ;; *) cp ${quote(path.join(f.dir, archive))} "$4" ;; esac`);
    const output = run(f, ["--no-service"]);
    expect(output).toContain("✓ Downloaded Node 22");
    const command = path.join(f.home, ".local/bin/wisp");
    expect(fs.readFileSync(command, "utf8")).toContain(".warren/runtime/node/bin/node");
    expect(execFileSync(command, ["doctor"], { encoding: "utf8" }).trim()).toBe('["doctor"]');
    // The existing bundled runtime works on subsequent installs without downloading again.
    f.script("curl", "exit 99");
    expect(run(f, ["--no-service"])).toContain("✓ Downloaded Wisp");
  }, 30_000);
  it("rejects a runtime download with a mismatched checksum", () => {
    const f = fixture(true);
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    f.script("curl", `case "$2" in *SHASUMS256.txt) printf '%s\\n' '0000  node-v22.23.4-${process.platform}-${arch}.tar.gz' > "$4" ;; *) printf 'incomplete' > "$4" ;; esac`);
    try { run(f, ["--no-service"]); throw new Error("expected failure"); }
    catch (error) { expect(String((error as { stderr: string }).stderr)).toContain("Node 22 download was incomplete"); }
    expect(fs.existsSync(path.join(f.home, ".warren/runtime/node"))).toBe(false);
  }, 30_000);
  it("keeps the old connection flags working", () => {
    const f = fixture();
    run(f, ["--hub", "http://mac:4747", "--token", "test-device-key", "--name", "Laptop"]);
    expect(fs.readFileSync(path.join(f.home, ".warren/install.log"), "utf8")).toContain('["service","install","node","--hub","http://mac:4747","--token","test-device-key","--name","Laptop"]');
  }, 30_000);
  it("rejects incomplete legacy flags with an actionable message", () => {
    const f = fixture();
    try { run(f, ["--hub", "http://mac:4747"]); throw new Error("expected failure"); }
    catch (error) { expect(String((error as { stderr: string }).stderr)).toContain("provide both --hub and --token"); }
  }, 30_000);
});
