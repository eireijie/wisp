// Remove Wisp from this computer, the same way uninstall.sh and the README's Windows steps do
// (test/removal.test.ts runs the script and this against the same folders so they can't drift).
// Nothing here takes a path from a page: main.cjs passes tick-box ids, the plan is made here, and
// every path goes through guard() before anything deletes it.
const nativeFs = require("node:fs");
const nodePath = require("node:path");
const os = require("node:os");
const { execFile, spawn: nativeSpawn } = require("node:child_process");

const LIST = {
  launchAgents: ["ai.wisp.hub", "ai.wisp.node", "ai.warren.hub", "ai.warren.node"],
  systemdUnits: ["wisp", "wisp-node", "warren", "warren-node"],
  scheduledTasks: ["Wisp hub", "Wisp node", "Warren hub", "Warren node"],
  vm: /^(wisp|warren)-cmp_/,
  image: /(^|\/)(wisp|warren)-computer$/,
  products: ["Wisp", "Warren"],
  commands: ["wisp", "wisp-hub", "wisp-mcp", "warren", "warren-hub", "warren-mcp"],
  stateDirs: [".wisp", ".warren"],
  installDirs: ["wisp", "warren"],
  systemDirs: ["/var/lib/wisp", "/var/lib/warren", "/opt/wisp", "/opt/warren"],
  systemUnitDir: "/etc/systemd/system",
};
const WORD = "REMOVE";
const DB_NAMES = ["wisp.db", "warren.db"];

const realRun = (env) => (bin, args, timeout = 60_000) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout, env, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")) });
    });
  });

/** Every place Wisp can be on this computer; `root` only moves the system folders, for tests. */
function locations({ platform, home, appData, root = "" }) {
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const sys = (file) => (root ? p.join(root, file) : file);
  const inHome = (...parts) => p.join(home, ...parts);
  const appFiles = LIST.products.flatMap((product) => {
    const id = product.toLowerCase();
    if (platform !== "darwin") return [p.join(appData, product)];
    return [p.join(appData, product), inHome("Library/Logs", product), inHome("Library/Preferences", `ai.${id}.desktop.plist`), inHome("Library/Caches", `ai.${id}.desktop`), inHome("Library/Saved Application State", `ai.${id}.desktop.savedState`)];
  });
  return {
    p,
    launchAgents: LIST.launchAgents.map((name) => ({ name, file: inHome("Library/LaunchAgents", `${name}.plist`) })),
    userUnits: LIST.systemdUnits.map((name) => ({ name, file: inHome(".config/systemd/user", `${name}.service`) })),
    systemUnits: LIST.systemdUnits.map((name) => ({ name, file: p.join(sys(LIST.systemUnitDir), `${name}.service`) })),
    bundles: platform === "darwin" ? LIST.products.flatMap((product) => [p.join(sys("/Applications"), `${product}.app`), inHome("Applications", `${product}.app`)]) : [],
    appFiles,
    commands: LIST.commands.flatMap((name) => (platform === "win32" ? [inHome(".local/bin", `${name}.cmd`), inHome(".local/bin", `${name}-entry.ps1`)] : [inHome(".local/bin", name)])),
    stateDirs: LIST.stateDirs.map((name) => inHome(name)),
    installDirs: LIST.installDirs.map((name) => inHome(name)),
    systemDirs: LIST.systemDirs.map(sys),
    report: inHome("Wisp removal report.txt"),
  };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const qp = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The helper that finishes after the app has quit. It only gets paths guard() has passed. */
function helperScript({ platform, pid, paths, uninstaller = null, failures = [], report }) {
  const ok = "Wisp is removed from this computer.";
  if (platform === "win32") {
    return [
      `$fail = New-Object System.Collections.ArrayList`,
      ...failures.map((f) => `[void]$fail.Add(${qp(f)})`),
      `try { Wait-Process -Id ${Number(pid)} -Timeout 60 -ErrorAction SilentlyContinue } catch {}`,
      ...(uninstaller ? [`try { Start-Process -Wait -FilePath ${qp(uninstaller)} -ArgumentList '/S' } catch { [void]$fail.Add('Uninstall Wisp in Settings > Apps.') }`] : []),
      `foreach ($path in @(${paths.map(qp).join(", ")})) {`,
      `  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }`,
      `  if (Test-Path -LiteralPath $path) { [void]$fail.Add("Couldn't delete $path") }`,
      `}`,
      `Add-Type -AssemblyName System.Windows.Forms`,
      `if ($fail.Count -eq 0) { $message = ${qp(ok)} } else {`,
      `  $fail | Set-Content -LiteralPath ${qp(report)}`,
      `  $message = "Wisp is removed, except for:\`n\`n" + ($fail -join "\`n") + "\`n\`nThis list is saved in " + ${qp(report)}`,
      `}`,
      `[void][System.Windows.Forms.MessageBox]::Show($message, 'Wisp')`,
      `Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
      ``,
    ].join("\r\n");
  }
  const dialog = platform === "darwin"
    ? `osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title "Wisp" buttons {"OK"} default button 1' -e 'end run' "$message" >/dev/null 2>&1`
    : `if command -v zenity >/dev/null 2>&1; then zenity --info --title=Wisp --text="$message"; elif command -v kdialog >/dev/null 2>&1; then kdialog --title Wisp --msgbox "$message"; elif command -v notify-send >/dev/null 2>&1; then notify-send Wisp "$message"; fi`;
  return [
    `#!/bin/sh`,
    `fail=""`,
    `add() { fail="$fail$1\n"; }`,
    ...failures.map((f) => `add ${q(f)}`),
    `i=0; while kill -0 ${Number(pid)} 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done`,
    `remove() { rm -rf -- "$1" 2>/dev/null; if [ -e "$1" ] || [ -L "$1" ]; then add "Couldn't delete $1"; fi; }`,
    ...paths.map((path) => `remove ${q(path)}`),
    `if [ -z "$fail" ]; then message=${q(ok)}; else`,
    `  printf '%b' "$fail" > ${q(report)}`,
    `  message="$(printf 'Wisp is removed, except for:\n\n%bThis list is saved in %s' "$fail" ${q(report)})"`,
    `fi`,
    dialog,
    `rm -f -- "$0"`,
    ``,
  ].join("\n");
}

function createRemoval({
  platform = process.platform, home = os.homedir(), appData, root = "", fs = nativeFs, env = process.env, run = realRun(env),
  execPath = process.execPath, packaged = false, appImage = env.APPIMAGE, pid = process.pid, spawn = nativeSpawn, tmpdir = os.tmpdir(), port = 4747,
} = {}) {
  if (root) {
    const inside = (child, parent) => child.startsWith(parent + nodePath.sep);
    const real = fs.realpathSync(root);
    if (!inside(real, fs.realpathSync(tmpdir)) || !inside(fs.realpathSync(home), real)) throw new Error("A removal test folder must be in the temp folder and hold HOME.");
  }
  const at = locations({ platform, home, appData, root });
  const { p } = at;
  const lstat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };
  const exists = (file) => !!lstat(file);
  const isLink = (file) => !!lstat(file)?.isSymbolicLink();
  const isDir = (file) => !!lstat(file)?.isDirectory();
  const under = (child, parent) => child.startsWith(parent + p.sep);

  /** Wisp's own checkout, as uninstall.sh decides it: never some other folder that's called wisp. */
  const isCheckout = (dir) => {
    try { return ["wisp", "warren"].includes(JSON.parse(fs.readFileSync(p.join(dir, "package.json"), "utf8")).name); } catch { return false; }
  };
  const isWispBundle = (bundle) => {
    try { return /ai\.(wisp|warren)\.desktop/.test(fs.readFileSync(p.join(bundle, "Contents/Info.plist"), "latin1")); } catch { return false; }
  };

  // ------------------------------------------------------------- the running copy of the app

  const runningBundle = () => {
    if (!packaged || platform !== "darwin") return null;
    // electron-builder names the bundle wisp.app
    const m = execPath.match(/^(.*\/(?:wisp|warren)\.app)\/Contents\/MacOS\/[^/]+$/i);
    if (!m || m[1].startsWith("/Volumes/") || m[1].includes("/AppTranslocation/")) return null;
    return m[1];
  };
  const runningAppImage = () => (packaged && platform === "linux" && appImage && /^wisp[^/]*\.appimage$/i.test(p.basename(appImage)) ? appImage : null);
  const uninstaller = () => {
    if (!packaged || platform !== "win32") return null;
    const file = p.join(p.dirname(execPath), "Uninstall Wisp.exe");
    return exists(file) ? file : null;
  };

  // ------------------------------------------------------------- the allow-list

  const exact = () => new Set([...at.launchAgents.map((s) => s.file), ...at.userUnits.map((s) => s.file), ...at.bundles, ...at.appFiles, ...at.commands, ...at.stateDirs, ...at.installDirs, ...[runningBundle(), runningAppImage()].filter(Boolean)]);

  /** Throws unless `target` is one of Wisp's own places (or inside ~/.wisp or a Wisp checkout). */
  function guard(target) {
    const stop = (why) => { throw new Error(`Refused to delete ${target}: ${why}`); };
    if (typeof target !== "string" || !p.isAbsolute(target) || p.normalize(target) !== target) stop("not a plain full path");
    if (target === home || under(home, target) || target === root || target === p.parse(target).root) stop("it holds your home folder");
    const folder = [...at.stateDirs, ...at.installDirs].find((dir) => under(target, dir));
    if (folder) {
      for (let up = p.dirname(target); ; up = p.dirname(up)) {
        if (isLink(up)) stop("it's reached through a link");
        if (up === folder) break;
      }
    } else if (!exact().has(target)) stop("it isn't on Wisp's list");
    if (isLink(target)) return target; // the link goes, whatever it points at stays
    const checkout = at.installDirs.includes(target) ? target : at.installDirs.includes(folder) ? folder : null;
    if (checkout && !isCheckout(checkout)) stop("it isn't a Wisp folder");
    if (at.bundles.includes(target) || target === runningBundle()) {
      if (exists(target) && !isWispBundle(target)) stop("it isn't the Wisp app");
    }
    if (at.commands.includes(target) && platform !== "win32" && exists(target)) stop("Wisp's commands are links, and this isn't one");
    return target;
  }

  function remove(target) {
    guard(target);
    const s = lstat(target);
    if (!s) return;
    if (s.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
    if (exists(target)) throw new Error(`Couldn't delete ${target}`);
  }

  /** Everything in `dir` except `keep` and the folders leading to it. */
  function removeExcept(dir, keep) {
    if (!keep || !under(keep, dir) || isLink(dir)) return remove(dir);
    guard(dir);
    // package.json last: it's how guard() knows a checkout for the rest
    for (const name of fs.readdirSync(dir).sort((a, b) => (a === "package.json") - (b === "package.json"))) {
      const child = p.join(dir, name);
      if (child === keep) continue;
      if (under(keep, child)) removeExcept(child, keep);
      else remove(child);
    }
  }

  // ------------------------------------------------------------- what's on this computer

  const hasDb = (dir) => isDir(dir) && DB_NAMES.some((name) => exists(p.join(dir, name)));
  const size = (dir) => {
    let total = 0, seen = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (++seen > 200_000) return;
        const file = p.join(d, e.name);
        if (e.isDirectory()) walk(file);
        else if (e.isFile()) total += lstat(file)?.size ?? 0;
      }
    };
    try { walk(dir); } catch {}
    return total;
  };
  const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  const short = (file) => (file === home || under(file, home) ? `~${file.slice(home.length)}` : file);
  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const allowed = (file) => { try { guard(file); return true; } catch { return false; } };

  async function findTasks() {
    const r = await run("powershell.exe", ["-NoProfile", "-Command", `@(Get-ScheduledTask -TaskName ${LIST.scheduledTasks.map(qp).join(",")} -ErrorAction SilentlyContinue).TaskName; exit 0`], 15_000);
    return LIST.scheduledTasks.filter((name) => r.stdout.split(/\r?\n/).map((l) => l.trim()).includes(name));
  }
  async function findVms() {
    const container = await run("container", ["ls", "-a"], 15_000);
    const fromContainer = container.code === 0 ? container.stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]).filter((id) => LIST.vm.test(id)) : [];
    const info = await run("docker", ["info"], 15_000);
    const docker = info.code === 0 ? await run("docker", ["ps", "-a", "--format", "{{.Names}}"], 15_000) : { code: 1, stdout: "" };
    const fromDocker = docker.code === 0 ? docker.stdout.split("\n").map((l) => l.trim()).filter((id) => LIST.vm.test(id)) : [];
    return { container: fromContainer, docker: fromDocker };
  }
  async function findImages() {
    const container = await run("container", ["image", "list"], 15_000);
    const fromContainer = container.code === 0 ? container.stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter(([name, tag]) => name && tag && LIST.image.test(name)).map(([name, tag]) => `${name}:${tag}`) : [];
    const docker = await run("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], 15_000);
    const fromDocker = docker.code === 0 ? docker.stdout.split("\n").map((l) => l.trim()).filter((ref) => LIST.image.test(ref.replace(/:[^:/]*$/, ""))) : [];
    return { container: fromContainer, docker: fromDocker };
  }

  /** The port a hub service listens on, from its own definition. */
  const hubPort = () => {
    for (const file of platform === "darwin" ? at.launchAgents.map((s) => s.file) : at.userUnits.map((s) => s.file)) {
      try {
        const m = fs.readFileSync(file, "utf8").match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>|\bEnvironment=["']?PORT=(\d+)\b/);
        if (m) return Number(m[1] ?? m[2]);
      } catch {}
    }
    return port;
  };

  const tailscaleBins = () => {
    if (root) return ["tailscale"]; // a test only ever uses its stand-in on PATH
    if (env.WISP_TAILSCALE) return [env.WISP_TAILSCALE];
    if (platform === "darwin") return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
    if (platform === "win32") return ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];
    return ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
  };
  const json = (out) => { try { return JSON.parse(out.slice(out.indexOf("{"))); } catch { return null; } };

  /** Whether Tailscale sends this computer's https://<name> root to this hub: that alone is Wisp's. */
  async function readTailscale() {
    for (const bin of tailscaleBins()) {
      const status = json((await run(bin, ["status", "--json"], 8000)).stdout);
      if (!status) continue;
      const dns = status.Self?.DNSName?.replace(/\.$/, "");
      const serve = json((await run(bin, ["serve", "status", "--json"], 8000)).stdout);
      const handlers = (dns && serve?.Web?.[`${dns}:443`]?.Handlers) || {};
      const proxy = handlers["/"]?.Proxy;
      const serving = !!proxy && new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${hubPort()}/?$`).test(proxy);
      return { bin, serving, others: Object.keys(handlers).filter((mount) => mount !== "/") };
    }
    return { bin: null, serving: false, others: [] };
  }

  /** Turn off only what points at this hub; another mount on the same address is somebody else's. */
  async function tailscaleOff() {
    const t = await readTailscale();
    if (!t.serving) return null;
    const steps = t.others.length ? [["serve", "--https=443", "--set-path=/", "off"]] : [["funnel", "--https=443", "off"], ["serve", "--https=443", "off"]];
    for (const args of steps) await run(t.bin, args, 20_000);
    if ((await readTailscale()).serving) throw new Error(`Run: tailscale ${steps.at(-1).join(" ")}`);
    return "Tailscale address turned off";
  }

  let plan = null;

  /** `hub`: what the running app knows, from the hub it's signed in to. */
  async function scan(hub = {}) {
    const services = platform === "darwin" ? at.launchAgents.filter((s) => exists(s.file))
      : platform === "linux" ? at.userUnits.filter((s) => exists(s.file))
      : (await findTasks()).map((name) => ({ name }));
    const systemUnits = platform === "linux" ? at.systemUnits.filter((s) => exists(s.file)) : [];
    const vms = await findVms();
    const images = await findImages();
    const commands = at.commands.filter((file) => (platform === "win32" ? exists(file) : isLink(file)));
    const states = at.stateDirs.filter(exists);
    const installs = at.installDirs.filter((dir) => exists(dir) && (isLink(dir) || isCheckout(dir)));
    // on a Mac's usual disk /Applications/Wisp.app and /Applications/wisp.app are one folder
    const bundles = [...new Map([...at.bundles, runningBundle()].filter(Boolean).map((b) => [b.toLowerCase(), b])).values()].filter((b) => exists(b) && allowed(b));
    const appFiles = at.appFiles.filter(exists);
    const image = runningAppImage();
    const removeApp = uninstaller();
    const candidates = [...states, ...installs].filter((dir) => !isLink(dir)).map((dir) => p.join(dir, "data"));
    const reported = hub.dataDir && !candidates.includes(hub.dataDir) && [...states, ...installs].some((dir) => under(hub.dataDir, dir)) ? [hub.dataDir] : [];
    const data = [...candidates, ...reported].filter((dir) => !isLink(p.dirname(dir)) && allowed(dir) && hasDb(dir));
    const legacy = [...vms.container, ...vms.docker].filter((id) => id.startsWith("warren-")).length;
    const vmCount = vms.container.length + vms.docker.length;
    const items = [];
    const add = (id, group, label, detail, needs) => items.push({ id, group, label, detail, ...(needs ? { needs } : {}) });

    if (data.length) {
      const c = hub.counts;
      const what = c ? `${plural(c.messages, "message")}, ${plural(c.notes, "note")}, ${plural(c.files, "file")} · ` : "";
      add("data", "lost", "Chats, memory and files", `${what}${gb(data.reduce((sum, dir) => sum + size(dir), 0))} · ${data.map(short).join(", ")}`, ["services"]);
    }
    if (vmCount) add("vms", "lost", `Agent computers · ${vmCount}`, `Everything on them${legacy ? `, including ${legacy} with old warren names` : ""}`);
    if (services.length) add("services", "rest", "Services", `${services.map((s) => s.name).join(", ")}, started at login`);
    if (images.container.length + images.docker.length) add("image", "rest", "VM image", "wisp-computer, a few GB");
    if (bundles.length || appFiles.length || image || removeApp) add("app", "rest", "Wisp app and its settings", `${[...bundles, image, removeApp && p.dirname(removeApp)].filter(Boolean).map(short).join(", ") || "Settings only"}, finishes after Wisp closes`);
    if (commands.length) add("commands", "rest", "Commands", `${[...new Set(commands.map((f) => p.basename(f).replace(/(\.cmd|-entry\.ps1)$/, "")))].join(", ")} in ~/.local/bin`);
    if (states.length) add("state", "rest", "Device settings and agents' folders", states.map(short).join(", "), ["services"]);
    if (installs.length) add("install", "rest", "Wisp folder", installs.map(short).join(", "), ["services"]);

    const manual = [];
    if (systemUnits.length) manual.push({ label: `System services: ${systemUnits.map((s) => s.name).join(", ")}`, command: systemUnits.map((s) => `sudo systemctl disable --now ${s.name} && sudo rm -f ${s.file}`).join(" && ") });
    for (const dir of at.systemDirs.filter(isDir)) manual.push({ label: dir, command: `${exists(p.join(dir, "compose.yaml")) ? `sudo docker compose -f ${dir}/compose.yaml down && ` : ""}sudo rm -rf ${dir}` });
    if (packaged && platform === "darwin" && !runningBundle()) manual.push({ label: "This copy of the app", command: "Quit it, then drag it to the Trash." });
    if (packaged && platform === "linux" && !image) manual.push({ label: "The app", command: "sudo apt remove wisp, or delete your AppImage" });
    if (packaged && platform === "win32" && !removeApp) manual.push({ label: "The app", command: "Uninstall Wisp in Settings > Apps" });

    const tailscale = await readTailscale();
    const kept = ["Tailscale itself", "Apple container or Docker", "your agent apps"];
    if (hub.memoryPath && ![...states, ...installs].some((dir) => hub.memoryPath === dir || under(hub.memoryPath, dir))) kept.push(`your memory folder at ${short(hub.memoryPath)}`);
    if (hub.dataDir && !data.includes(hub.dataDir) && !data.some((dir) => under(hub.dataDir, dir))) kept.push(`the data folder at ${short(hub.dataDir)}`);
    if (hub.wispDir && !installs.includes(hub.wispDir)) kept.push(`the Wisp folder at ${short(hub.wispDir)}`);

    // the hub goes with its service, or with the app when the app is what runs it
    const hubService = services.some((s) => /^(ai\.(wisp|warren)\.hub|wisp|warren|(Wisp|Warren) hub)$/.test(s.name));
    const tailscaleWith = hubService ? "services" : hub.localHub ? "app" : null;
    plan = { tailscaleWith, services, vms, images, commands, states, installs, data, bundles, appFiles, image, removeApp, items };
    return { items, manual, tailscale: tailscale.serving && !!tailscaleWith, tailscaleWith, kept };
  }

  /** The ticked ids that exist; what relies on a service takes the service with it, as the window shows. */
  function chosen(ids) {
    const present = new Set(plan.items.map((i) => i.id));
    const picked = new Set(ids.filter((id) => present.has(id)));
    for (const item of plan.items) if (picked.has(item.id)) for (const need of item.needs ?? []) if (present.has(need)) picked.add(need);
    return picked;
  }

  async function removeService(service) {
    if (platform === "darwin") {
      await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${service.name}`], 30_000);
      remove(service.file);
    } else if (platform === "linux") {
      await run("systemctl", ["--user", "disable", "--now", service.name], 30_000);
      remove(service.file);
      await run("systemctl", ["--user", "daemon-reload"], 15_000);
    } else {
      const r = await run("powershell.exe", ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName ${qp(service.name)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${qp(service.name)} -Confirm:$false`], 30_000);
      if (r.code !== 0) throw new Error(`Delete the ${service.name} task in Task Scheduler.`);
    }
  }

  /** Do everything that can happen while the app runs. A step that fails never stops the next one. */
  async function start(ids, word, onStep = () => {}) {
    if (word !== WORD) throw new Error(`Type ${WORD} to confirm.`);
    if (!plan) throw new Error("Nothing has been looked at yet.");
    const picked = chosen(ids);
    const steps = [];
    const step = async (id, running, done, work) => {
      const entry = { id, label: running, state: "running", detail: "" };
      steps.push(entry);
      onStep([...steps]);
      try {
        const result = await work();
        if (result === null) { steps.pop(); onStep([...steps]); return; }
        entry.state = "done";
        entry.label = typeof result === "string" ? result : done;
      } catch (err) {
        entry.state = "failed";
        entry.label = typeof err.label === "string" ? err.label : `${running.replace(/…$/, "")} failed`;
        entry.detail = err.message;
      }
      onStep([...steps]);
    };
    const each = async (list, work) => {
      const failed = [];
      for (const thing of list) { try { await work(thing); } catch (err) { failed.push(err.message); } }
      if (failed.length) throw Object.assign(new Error(failed.join("\n")), { failedCount: failed.length, total: list.length });
    };

    if (plan.tailscaleWith && picked.has(plan.tailscaleWith)) await step("tailscale", "Turning off Tailscale address…", "Tailscale address turned off", tailscaleOff);
    if (picked.has("services")) await step("services", "Removing services…", "Services removed", () => each(plan.services, removeService));
    if (picked.has("vms")) {
      const ids = [...plan.vms.container.map((id) => ["container", id]), ...plan.vms.docker.map((id) => ["docker", id])];
      await step("vms", `Deleting ${plural(ids.length, "agent computer")}…`, `${plural(ids.length, "agent computer")} deleted`, async () => {
        let gone = 0;
        try {
          await each(ids, async ([engine, id]) => {
            if (engine === "container") await run("container", ["stop", id], 60_000);
            const r = engine === "container" ? await run("container", ["rm", id], 60_000) : await run("docker", ["rm", "-f", id], 60_000);
            if (r.code !== 0) throw new Error(`${id} didn't stop. Run: ${engine} rm ${engine === "docker" ? "-f " : ""}${id}`);
            gone++;
          });
        } catch (err) {
          err.label = `${gone} of ${ids.length} agent computers deleted`;
          throw err;
        }
      });
    }
    if (picked.has("image")) await step("image", "Deleting VM image…", "VM image deleted", () => each([...plan.images.container.map((ref) => ["container", ref]), ...plan.images.docker.map((ref) => ["docker", ref])], async ([engine, ref]) => {
      const r = engine === "container" ? await run("container", ["image", "rm", ref], 120_000) : await run("docker", ["rmi", "-f", ref], 120_000);
      if (r.code !== 0) throw new Error(`Run: ${engine === "container" ? "container image rm" : "docker rmi -f"} ${ref}`);
    }));
    if (picked.has("commands")) await step("commands", "Removing commands…", "Commands removed", () => each(plan.commands, remove));
    if (picked.has("data")) await step("data", "Deleting chats, memory and files…", "Chats, memory and files deleted", () => each(plan.data, remove));
    const keepIn = (dir) => (picked.has("data") ? null : plan.data.find((d) => under(d, dir)) ?? null);
    const names = (dirs) => dirs.map(short).join(" and ");
    if (picked.has("state")) await step("state", `Deleting ${names(plan.states)}…`, `${names(plan.states)} deleted`, () => each(plan.states, (dir) => removeExcept(dir, keepIn(dir))));
    if (picked.has("install")) await step("install", `Deleting ${names(plan.installs)}…`, `${names(plan.installs)} deleted`, () => each(plan.installs, (dir) => removeExcept(dir, keepIn(dir))));
    const app = picked.has("app");
    const failures = steps.filter((s) => s.state === "failed").flatMap((s) => s.detail.split("\n"));
    if (app) { steps.push({ id: "app", label: "App and its settings: after Wisp closes", state: "later", detail: "" }); onStep([...steps]); }
    plan.finish = app ? { paths: [...plan.bundles, ...(plan.image ? [plan.image] : []), ...plan.appFiles], uninstaller: plan.removeApp, failures } : null;
    return { steps, app, setupGone: picked.has("data") || picked.has("state") || picked.has("install") };
  }

  /** Leave the helper running, for the app to quit. */
  function finish() {
    if (!plan?.finish) throw new Error("There's nothing left to finish.");
    const { paths, uninstaller: exe, failures } = plan.finish;
    for (const path of paths) guard(path);
    if (exe && exe !== uninstaller()) throw new Error("Refused to run that uninstaller.");
    const dir = fs.mkdtempSync(p.join(tmpdir, "wisp-remove-"));
    const file = p.join(dir, platform === "win32" ? "finish.ps1" : "finish.sh");
    fs.writeFileSync(file, helperScript({ platform, pid, paths, uninstaller: exe, failures, report: at.report }), { mode: 0o700 });
    const child = platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn("/bin/sh", [file], { detached: true, stdio: "ignore", env, cwd: tmpdir });
    child.unref();
    return file;
  }

  /** Where a backup can't go: it would be deleted with the rest. */
  function backupProblem(dest) {
    const places = [...at.stateDirs, ...at.installDirs, ...at.bundles, ...at.appFiles];
    return places.some((place) => dest === place || under(dest, place)) ? "Choose a folder Wisp isn't about to remove." : null;
  }

  /** Copy the hub's data folder to <dest>/Wisp backup <day>; `snapshot` copies a database a running hub has open. */
  async function backup(dest, snapshot, day = new Date().toISOString().slice(0, 10)) {
    const problem = backupProblem(dest);
    if (problem) throw new Error(problem);
    if (!plan?.data.length) throw new Error("There's nothing to back up.");
    let out = p.join(dest, `Wisp backup ${day}`);
    for (let n = 2; exists(out); n++) out = p.join(dest, `Wisp backup ${day} ${n}`);
    for (const [i, source] of plan.data.entries()) {
      const to = plan.data.length > 1 ? p.join(out, String(i + 1)) : out;
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(source)) {
        if (/\.db(-wal|-shm)?$/.test(e)) continue;
        fs.cpSync(p.join(source, e), p.join(to, e), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      }
      for (const name of DB_NAMES) if (exists(p.join(source, name))) await snapshot(p.join(source, name), p.join(to, name));
    }
    return out;
  }

  return { scan, start, finish, backup, backupProblem, guard, remove, removeExcept, at };
}

module.exports = { LIST, WORD, createRemoval, locations, helperScript };
