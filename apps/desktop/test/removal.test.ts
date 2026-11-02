import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
const { LIST, WORD, createRemoval, locations, helperScript } = createRequire(import.meta.url)("../src/removal.cjs");

vi.setConfig({ testTimeout: 60_000 }); // each test starts many small processes
const repo = path.resolve(__dirname, "../../..");
const script = fs.readFileSync(path.join(repo, "uninstall.sh"), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const STUBS = `
log() { echo "$(basename "$0") $*" >> "$STUB_LOG"; }
log "$@"
case "$(basename "$0") $*" in
  "container ls -a") printf 'ID IMAGE\\nwisp-cmp_new img\\nwarren-cmp_old img\\nbuildkit img\\nmy-wisp-cmp_x img\\n' ;;
  "container image list") printf 'NAME TAG DIGEST\\nwisp-computer abc d\\nghcr.io/eireijie/wisp-computer def d\\nwarren-computer old d\\nnginx latest d\\n' ;;
  "docker info") exit 0 ;;
  "docker ps -a --format {{.Names}}") printf 'wisp-cmp_dock\\nother\\n' ;;
  "docker images --format {{.Repository}}:{{.Tag}}") printf 'wisp-computer:1\\nredis:7\\n' ;;
  "docker images -q "*) printf 'abc\\n' ;;
  "tailscale status --json") cat "$STUB_DIR/ts-status.json" ;;
  "tailscale serve status --json") cat "$STUB_DIR/ts-serve.json" ;;
  "tailscale funnel --https=443 off"|"tailscale serve --https=443 off"|"tailscale serve --https=443 --set-path=/ off") [ -f "$STUB_DIR/ts-stuck" ] || echo '{}' > "$STUB_DIR/ts-serve.json" ;;
esac
[ -f "$STUB_DIR/fail-$(basename "$0")-$1" ] && exit 1
exit 0`;

/** A whole Wisp on a made-up computer: a temp HOME, system folders, and stand-ins for every command. */
function computer(platform: "darwin" | "linux" = process.platform === "linux" ? "linux" : "darwin") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wisp-removal-"))); roots.push(root);
  const home = path.join(root, "home"), stubs = path.join(root, "stubs"), outside = path.join(root, "outside");
  const appData = platform === "darwin" ? path.join(home, "Library/Application Support") : path.join(home, ".config");
  const write = (file: string, content = "x") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const W = (rel: string, content = "x") => write(path.join(home, rel), content);
  fs.mkdirSync(stubs, { recursive: true });
  for (const c of ["launchctl", "systemctl", "container", "docker", "tailscale", "osascript", "sudo", "zenity"]) fs.writeFileSync(path.join(stubs, c), `#!/bin/sh${STUBS}\n`, { mode: 0o755 });
  const stubLog = path.join(root, "stub.log");
  write(path.join(stubs, "ts-status.json"), JSON.stringify({ Self: { DNSName: "mac.tail.ts.net." } }));
  write(path.join(stubs, "ts-serve.json"), JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4747" } } } } }));
  if (platform === "darwin") {
    for (const s of LIST.launchAgents) W(`Library/LaunchAgents/${s}.plist`);
    for (const b of ["Wisp", "Warren"]) write(path.join(root, `Applications/${b}.app/Contents/Info.plist`), `<string>ai.${b.toLowerCase()}.desktop</string>`);
    W("Library/Logs/Wisp/hub.log"); W("Library/Preferences/ai.wisp.desktop.plist"); W("Library/Caches/ai.wisp.desktop/c"); W("Library/Saved Application State/ai.wisp.desktop.savedState/s");
  } else for (const s of LIST.systemdUnits) W(`.config/systemd/user/${s}.service`);
  W(path.relative(home, path.join(appData, "Wisp/desktop.json")));
  W(path.relative(home, path.join(appData, "Warren/desktop.json")));
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  for (const c of LIST.commands) fs.symlinkSync("/nowhere", path.join(home, ".local/bin", c));
  W(".local/bin/not-ours");
  W(".wisp/node.json"); W(".wisp/data/wisp.db"); W(".wisp/agents/a/f");
  W("wisp/package.json", '{ "name": "wisp" }'); W("wisp/data/wisp.db"); W("wisp/apps/x");
  W("warren/package.json", '{ "name": "warren" }');
  fs.symlinkSync(path.join(home, ".wisp"), path.join(home, ".warren"));
  W("Documents/keep.txt");
  write(path.join(outside, "precious"));
  const env = { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, STUB_LOG: stubLog, STUB_DIR: stubs };
  const make = (extra = {}) => createRemoval({ platform, home, appData, root, env, tmpdir: fs.realpathSync(os.tmpdir()), pid: 999999, ...extra });
  const tree = () => (execFileSync("find", [root, "-not", "-path", `${stubs}*`, "-not", "-name", "stub.log", "-not", "-path", "*com.apple.python*"], { encoding: "utf8" }).split("\n").filter(Boolean).map((f) => f.slice(root.length)).sort());
  const calls = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean) : []);
  return { platform, root, home, appData, stubs, outside, env, write, W, make, tree, calls, stubLog };
}
const allIds = ["data", "vms", "services", "image", "app", "commands", "state", "install"];
const finishNow = (r: ReturnType<typeof computer>, removal: any) => {
  const file = removal.finish();
  const out = spawnSync("/bin/sh", [file], { env: r.env as NodeJS.ProcessEnv, encoding: "utf8" });
  expect(out.status).toBe(0);
};
async function realSpawnless(r: ReturnType<typeof computer>, extra = {}) {
  return r.make({ spawn: () => ({ unref() {} }), ...extra });
}

describe("what's on this computer", () => {
  it("finds both names, including VMs a wisp-only check misses, and nobody else's", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    const scan = await removal.scan({});
    const byId = Object.fromEntries(scan.items.map((i: any) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual([...allIds].sort());
    expect(byId.vms.label).toBe("Agent computers · 3");
    expect(byId.vms.detail).toContain("1 with old warren names");
    expect(byId.data.group).toBe("lost");
    expect(byId.state.detail).toBe("~/.wisp, ~/.warren");
    expect(byId.install.detail).toBe("~/wisp, ~/warren");
    expect(scan.tailscale).toBe(true);
  });

  it("leaves a folder that's only called wisp out of the list", async () => {
    const r = computer();
    fs.rmSync(path.join(r.home, "warren"), { recursive: true });
    r.W("wisp/package.json", '{ "name": "my-own-project" }');
    const scan = await (await realSpawnless(r)).scan({});
    expect(scan.items.find((i: any) => i.id === "install")).toBeUndefined();
    expect(scan.items.find((i: any) => i.id === "data").detail).toContain("~/.wisp/data");
    expect(scan.items.find((i: any) => i.id === "data").detail).not.toContain("~/wisp/data");
  });

  it("keeps a memory folder and data folder elsewhere, and says so", async () => {
    const r = computer();
    const scan = await (await realSpawnless(r)).scan({ memoryPath: path.join(r.home, "Documents/Notes"), dataDir: path.join(r.home, "Documents/data") });
    expect(scan.kept).toEqual(expect.arrayContaining(["your memory folder at ~/Documents/Notes", "the data folder at ~/Documents/data"]));
  });

  it("hands system installs to an admin instead of asking for a password", async () => {
    const r = computer();
    r.write(path.join(r.root, "var/lib/wisp/wisp.db"));
    r.write(path.join(r.root, "opt/wisp/compose.yaml"));
    const removal = await realSpawnless(r);
    const scan = await removal.scan({});
    expect(scan.manual.map((m: any) => m.command).join()).toContain("sudo rm -rf");
    await removal.start(allIds, WORD);
    expect(fs.existsSync(path.join(r.root, "var/lib/wisp/wisp.db"))).toBe(true);
    expect(r.calls().filter((c) => c.startsWith("sudo"))).toEqual([]);
  });
});

describe("the allow-list", () => {
  const refused = (removal: any, file: string) => expect(() => removal.guard(file), file).toThrow(/Refused/);

  it("refuses everything that isn't Wisp's", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    for (const file of [r.home, path.dirname(r.home), "/", path.join(r.home, "Documents"), path.join(r.home, "Documents/keep.txt"), path.join(r.home, ".wisp/../Documents"), path.join(r.home, ".local/bin/not-ours"), path.join(r.home, ".local/bin"), path.join(r.home, "Library"), path.join(r.outside, "precious"), "relative/.wisp", "", path.join(r.home, ".wisp2"), path.join(r.root, "Applications/Other.app"), path.join(r.root, "var/lib/wisp")]) refused(removal, file);
    refused(removal, undefined as unknown as string);
  });

  it("deletes a link and never what it points at", async () => {
    const r = computer();
    fs.rmSync(path.join(r.home, ".wisp"), { recursive: true });
    fs.symlinkSync(r.outside, path.join(r.home, ".wisp"));
    fs.rmSync(path.join(r.home, "wisp"), { recursive: true });
    fs.symlinkSync(r.outside, path.join(r.home, "wisp"));
    const removal = await realSpawnless(r);
    refused(removal, path.join(r.home, ".wisp/precious"));
    await removal.scan({});
    const { steps } = await removal.start(allIds, WORD);
    expect(steps.filter((s: any) => s.state === "failed")).toEqual([]);
    expect(fs.existsSync(path.join(r.outside, "precious"))).toBe(true);
    expect(fs.existsSync(path.join(r.home, ".wisp"))).toBe(false);
    expect(fs.existsSync(path.join(r.home, "wisp"))).toBe(false);
  });

  it("doesn't follow a link inside a folder it deletes", async () => {
    const r = computer();
    fs.symlinkSync(r.outside, path.join(r.home, ".wisp/agents/link"));
    const removal = await realSpawnless(r);
    await removal.scan({});
    await removal.start(allIds, WORD);
    expect(fs.existsSync(path.join(r.outside, "precious"))).toBe(true);
    expect(fs.existsSync(path.join(r.home, ".wisp"))).toBe(false);
  });

  it("refuses an app bundle that isn't Wisp, and a folder swapped after the scan", async () => {
    const r = computer();
    if (r.platform !== "darwin") return;
    const removal = await realSpawnless(r);
    await removal.scan({});
    r.write(path.join(r.root, "Applications/Wisp.app/Contents/Info.plist"), "com.other.app");
    r.W("wisp/package.json", '{ "name": "someone-else" }');
    expect(() => removal.finish()).toThrow(/Refused|nothing left/);
    const { steps } = await removal.start(["install"], WORD);
    expect(steps.find((s: any) => s.id === "install").state).toBe("failed");
    expect(fs.existsSync(path.join(r.home, "wisp/apps/x"))).toBe(true);
  });

  it("only accepts a test folder in the temp folder", () => {
    expect(() => createRemoval({ platform: "darwin", home: os.homedir(), appData: "/x", root: "/" })).toThrow(/temp folder/);
    const r = computer();
    expect(() => createRemoval({ platform: "darwin", home: os.homedir(), appData: "/x", root: r.root })).toThrow(/temp folder/);
  });

  it("takes the running copy only when it's really an installed Wisp", async () => {
    const r = computer();
    if (r.platform !== "darwin") return;
    r.write(path.join(r.home, "Downloads/Wisp.app/Contents/Info.plist"), "ai.wisp.desktop");
    const packaged = r.make({ packaged: true, execPath: path.join(r.home, "Downloads/Wisp.app/Contents/MacOS/Wisp") });
    expect(packaged.guard(path.join(r.home, "Downloads/Wisp.app"))).toBeTruthy();
    r.write(path.join(r.root, "Applications/wisp.app/Contents/Info.plist"), "ai.wisp.desktop");
    const lower = r.make({ packaged: true, execPath: path.join(r.root, "Applications/wisp.app/Contents/MacOS/Wisp") });
    expect(lower.guard(path.join(r.root, "Applications/wisp.app"))).toBeTruthy();
    expect((await lower.scan({})).items.find((i: any) => i.id === "app").detail.match(/wisp\.app/gi)).toHaveLength(1);
    const onDisk = r.make({ packaged: true, execPath: "/Volumes/Wisp/Wisp.app/Contents/MacOS/Wisp" });
    expect((await onDisk.scan({})).manual.map((m: any) => m.label)).toContain("This copy of the app");
    expect(() => onDisk.guard("/Volumes/Wisp/Wisp.app")).toThrow(/Refused/);
  });
});

describe("removing", () => {
  it("needs the word", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    await removal.scan({});
    await expect(removal.start(allIds, "remove")).rejects.toThrow(/REMOVE/);
    expect(r.calls().some((c) => / rm /.test(c))).toBe(false);
    expect(fs.existsSync(path.join(r.home, ".wisp"))).toBe(true);
  });

  it("removes only what's ticked, and what relies on a service takes the service", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    await removal.scan({});
    await removal.start(["install"], WORD);
    expect(fs.readdirSync(path.join(r.home, "wisp"))).toEqual(["data"]);
    expect(fs.existsSync(path.join(r.home, ".wisp/node.json"))).toBe(true);
    expect(fs.lstatSync(path.join(r.home, ".local/bin/wisp")).isSymbolicLink()).toBe(true);
    expect(r.calls().some((c) => c.startsWith("container rm"))).toBe(false);
    expect(r.calls().some((c) => c.startsWith("launchctl bootout") || c.startsWith("systemctl --user disable"))).toBe(true);
  });

  it("keeps chats, memory and files when they're unticked, wherever they sit", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    await removal.scan({});
    const { steps } = await removal.start(allIds.filter((id) => id !== "data"), WORD);
    expect(steps.filter((s: any) => s.state === "failed")).toEqual([]);
    expect(fs.existsSync(path.join(r.home, ".wisp/data/wisp.db"))).toBe(true);
    expect(fs.existsSync(path.join(r.home, "wisp/data/wisp.db"))).toBe(true);
    expect(fs.existsSync(path.join(r.home, ".wisp/node.json"))).toBe(false);
    expect(fs.readdirSync(path.join(r.home, "wisp"))).toEqual(["data"]);
  });

  it("a failed step doesn't hide or stop the others, and the helper repeats it", async () => {
    const r = computer();
    r.write(path.join(r.stubs, "fail-container-rm"));
    const removal = await realSpawnless(r);
    await removal.scan({});
    const { steps } = await removal.start(allIds, WORD);
    const vm = steps.find((s: any) => s.id === "vms");
    expect(vm.state).toBe("failed");
    expect(vm.label).toBe("1 of 3 agent computers deleted");
    expect(vm.detail).toContain("Run: container rm wisp-cmp_new");
    expect(steps.find((s: any) => s.id === "state").state).toBe("done");
    expect(steps.at(-1)).toMatchObject({ id: "app", state: "later" });
    finishNow(r, removal);
    const report = fs.readFileSync(path.join(r.home, "Wisp removal report.txt"), "utf8");
    expect(report).toContain("wisp-cmp_new");
    expect(r.calls().join("\n")).toContain("except for");
  });

  it("the helper removes the app last and says it's done", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    await removal.scan({});
    await removal.start(allIds, WORD);
    expect(fs.existsSync(path.join(r.appData, "Wisp"))).toBe(true);
    finishNow(r, removal);
    expect(fs.existsSync(path.join(r.appData, "Wisp"))).toBe(false);
    expect(fs.existsSync(path.join(r.home, "Wisp removal report.txt"))).toBe(false);
    expect(fs.existsSync(path.join(r.home, "Documents/keep.txt"))).toBe(true);
  });
});

describe("Tailscale", () => {
  const off = (calls: string[]) => calls.filter((c) => c.startsWith("tailscale") && c.endsWith("off"));

  it("turns off the address when the hub goes", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    await removal.scan({});
    const { steps } = await removal.start(["services"], WORD);
    expect(off(r.calls())).toEqual(["tailscale funnel --https=443 off", "tailscale serve --https=443 off"]);
    expect(steps.find((s: any) => s.id === "tailscale").state).toBe("done");
  });

  it("leaves it alone when the hub stays", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    await removal.scan({});
    await removal.start(["commands", "vms"], WORD);
    expect(off(r.calls())).toEqual([]);
  });

  it("goes with the app when the app runs the hub, and stays for a device-only service", async () => {
    const r = computer();
    for (const name of [...LIST.launchAgents, ...LIST.systemdUnits]) if (!/node/.test(name)) { fs.rmSync(path.join(r.home, "Library/LaunchAgents", `${name}.plist`), { force: true }); fs.rmSync(path.join(r.home, ".config/systemd/user", `${name}.service`), { force: true }); }
    const removal = await realSpawnless(r);
    await removal.scan({ localHub: true });
    await removal.start(["services"], WORD);
    expect(off(r.calls())).toEqual([]);
    await removal.start(["app"], WORD);
    expect(off(r.calls()).length).toBe(2);
  });

  it.each([
    ["another app's address", { "/": { Proxy: "http://127.0.0.1:3000" } }],
    ["a port other than the hub's", { "/": { Proxy: "http://127.0.0.1:47470" } }],
    ["a path that isn't the root", { "/wisp": { Proxy: "http://127.0.0.1:4747" } }],
  ])("doesn't touch %s", async (_name, Handlers) => {
    const r = computer();
    r.write(path.join(r.stubs, "ts-serve.json"), JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers } } }));
    const removal = await realSpawnless(r);
    await removal.scan({});
    const { steps } = await removal.start(allIds, WORD);
    expect(off(r.calls())).toEqual([]);
    expect(steps.find((s: any) => s.id === "tailscale")).toBeUndefined();
  });

  it("removes only the root when something else shares the address", async () => {
    const r = computer();
    r.write(path.join(r.stubs, "ts-serve.json"), JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4747" }, "/mine": { Proxy: "http://127.0.0.1:9000" } } } } }));
    const removal = await realSpawnless(r);
    await removal.scan({});
    await removal.start(["services"], WORD);
    expect(off(r.calls())).toEqual(["tailscale serve --https=443 --set-path=/ off"]);
  });

  it("reports an address that stayed on", async () => {
    const r = computer();
    r.write(path.join(r.stubs, "ts-stuck"));
    const removal = await realSpawnless(r);
    await removal.scan({});
    const { steps } = await removal.start(["services"], WORD);
    expect(steps.find((s: any) => s.id === "tailscale")).toMatchObject({ state: "failed" });
    expect(steps.find((s: any) => s.id === "tailscale").detail).toContain("tailscale serve --https=443 off");
    expect(steps.find((s: any) => s.id === "services").state).toBe("done");
  });
});

describe("backups", () => {
  it("copies the data folder, with the database through the snapshot, and not into what's going", async () => {
    const r = computer();
    const removal = await realSpawnless(r);
    r.W(".wisp/data/vault/note.md", "hello");
    r.W(".wisp/data/wisp.db-wal", "torn");
    fs.rmSync(path.join(r.home, "wisp/data"), { recursive: true });
    await removal.scan({});
    await expect(removal.backup(path.join(r.home, ".wisp/backups"), async () => {})).rejects.toThrow(/isn't about to remove/);
    const out = await removal.backup(path.join(r.home, "Documents"), async (_from: string, to: string) => fs.writeFileSync(to, "snapshot"), "2026-11-01");
    expect(out).toBe(path.join(r.home, "Documents/Wisp backup 2026-11-01"));
    expect(fs.readFileSync(path.join(out, "vault/note.md"), "utf8")).toBe("hello");
    expect(fs.readFileSync(path.join(out, "wisp.db"), "utf8")).toBe("snapshot");
    expect(fs.existsSync(path.join(out, "wisp.db-wal"))).toBe(false);
  });
});

describe("the same list as uninstall.sh", () => {
  it("names everything on the shared list, for every platform's script branch", () => {
    for (const name of [...LIST.launchAgents, ...LIST.systemdUnits, ...LIST.commands, ...LIST.stateDirs.map((d: string) => `$HOME/${d}`), ...LIST.products]) expect(script, name).toContain(name);
    for (const dir of LIST.systemDirs) expect(script, dir).toContain(`$ROOT${dir}`);
    expect(script).toContain("(wisp|warren)-cmp_");
    expect(script).toContain("(wisp|warren)-computer");
    expect(LIST.vm.source).toBe("^(wisp|warren)-cmp_");
  });

  it("names what the README and the service code say on Windows", () => {
    const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
    const at = locations({ platform: "win32", home: "C:\\Users\\a", appData: "C:\\Users\\a\\AppData\\Roaming" });
    for (const needle of ["%USERPROFILE%\\wisp", "%USERPROFILE%\\.wisp", "%APPDATA%\\Wisp", "**Wisp hub**", "**Wisp node**"]) expect(readme).toContain(needle);
    expect(at.installDirs[0]).toBe("C:\\Users\\a\\wisp");
    expect(at.stateDirs[0]).toBe("C:\\Users\\a\\.wisp");
    expect(at.appFiles[0]).toBe("C:\\Users\\a\\AppData\\Roaming\\Wisp");
    expect(at.commands).toContain("C:\\Users\\a\\.local\\bin\\wisp.cmd");
    expect(at.commands).toContain("C:\\Users\\a\\.local\\bin\\wisp-entry.ps1");
    expect(LIST.scheduledTasks).toEqual(["Wisp hub", "Wisp node", "Warren hub", "Warren node"]);
    const install = fs.readFileSync(path.join(repo, "install.ps1"), "utf8");
    expect(install).toContain('@("wisp", "wisp-mcp", "wisp-hub")');
    expect(install).toContain("$Alias-entry.ps1");
  });

  it("leaves exactly the same files as the script on the same computer", async () => {
    const a = computer(), b = computer();
    const scripted = spawnSync("bash", [path.join(repo, "uninstall.sh"), "--yes"], { env: { ...a.env, WISP_UNINSTALL_ROOT: a.root } as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(scripted.status, scripted.stderr).toBe(0);
    const removal = await realSpawnless(b);
    await removal.scan({});
    await removal.start(allIds, WORD);
    finishNow(b, removal);
    expect(b.tree()).toEqual(a.tree());
    const vmCalls = (calls: string[]) => calls.filter((c) => /^(container rm|docker rm|container image rm|docker rmi|tailscale \w+ --https)/.test(c)).sort();
    expect(vmCalls(b.calls())).toEqual(vmCalls(a.calls()));
    expect(a.tree()).toContain("/home/Documents/keep.txt");
    expect(a.tree()).not.toContain("/home/.wisp");
  });

  it("the script's dry run changes nothing", () => {
    const a = computer();
    const before = a.tree();
    spawnSync("bash", [path.join(repo, "uninstall.sh"), "--dry-run"], { env: { ...a.env, WISP_UNINSTALL_ROOT: a.root } as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(a.tree()).toEqual(before);
  });
});

describe("the helper on Windows", () => {
  it("quotes paths, waits for the app and runs only the uninstaller it's given", () => {
    const text = helperScript({ platform: "win32", pid: 42, paths: ["C:\\Users\\o'neil\\AppData\\Roaming\\Wisp"], uninstaller: "C:\\Programs\\Wisp\\Uninstall Wisp.exe", failures: ["it's stuck"], report: "C:\\Users\\o'neil\\Wisp removal report.txt" });
    expect(text).toContain("Wait-Process -Id 42");
    expect(text).toContain("'C:\\Users\\o''neil\\AppData\\Roaming\\Wisp'");
    expect(text).toContain("Start-Process -Wait -FilePath 'C:\\Programs\\Wisp\\Uninstall Wisp.exe' -ArgumentList '/S'");
    expect(text).toContain("[void]$fail.Add('it''s stuck')");
  });
  it("quotes paths in the shell helper too", () => {
    const text = helperScript({ platform: "linux", pid: 7, paths: ["/home/o'neil/$(reboot)/.config/Wisp"], failures: [], report: "/home/o'neil/r.txt" });
    expect(text).toContain(`remove '/home/o'\\''neil/$(reboot)/.config/Wisp'`);
    expect(text).toContain("zenity");
  });
});
