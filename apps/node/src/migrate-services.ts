import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type ServiceRunner = (command: string, args: string[]) => string;
export interface ServiceMigrationOptions {
  platform?: NodeJS.Platform;
  home: string;
  run?: ServiceRunner;
  fs?: typeof fs;
  uid?: number;
  systemDir?: string;
  system?: boolean;
  kinds?: ("hub" | "node")[];
  removeOnly?: boolean;
  log?: (line: string) => void;
}
export const serviceRunner: ServiceRunner = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Rewrite only our names/paths; all arguments and environment settings remain in the definition. */
export function rewriteService(text: string, moveHome = true): string {
  return text.replace(/ai\.warren\.(hub|node)/g, "ai.wisp.$1")
    .replace(/Warren (hub|node|device)/g, "Wisp $1")
    .replace(/WARREN_/g, "WISP_")
    .replace(/([/\\])\.warren(?=[/\\]|[\s"'<]|$)/g, moveHome ? "$1.wisp" : "$1.warren")
    .replace(/\/var\/lib\/warren(?=\/|[\s"'<]|$)/g, "/var/lib/wisp")
    .replace(/\/opt\/warren(?=\/|[\s"'<]|$)/g, "/opt/wisp")
    .replace(/warren(-hub|-mcp)?\.mjs/g, "wisp$1.mjs")
    .replace(/\bwarren-node(?=\.service|[\s"'<]|$)/g, "wisp-node")
    .replace(/\bwarren(?=\.service)/g, "wisp")
    .replace(/([/\\]bin[/\\])warren(-hub|-mcp)?(?=[\s"'<]|$)/g, "$1wisp$2");
}

/** Older CLI-installed hubs defaulted to <checkout>/data. Make that choice explicit on upgrade. */
function preserveHubData(text: string, platform: NodeJS.Platform, io: typeof fs): string {
  if (/(?:WARREN|WISP)_DATA_DIR/.test(text)) return text;
  const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const directory = platform === "darwin" ? text.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    : platform === "linux" ? text.match(/^WorkingDirectory=(.+)$/m)?.[1]?.replace(/^"|"$/g, "")
    : text.match(/<WorkingDirectory>([^<]+)<\/WorkingDirectory>/)?.[1];
  if (!directory) return text;
  const data = path.join(decode(directory), "data");
  if (!io.existsSync(data)) return text;
  if (platform === "darwin") {
    const setting = `<key>WISP_DATA_DIR</key><string>${xml(data)}</string>`;
    if (/<key>EnvironmentVariables<\/key>\s*<dict>/.test(text)) return text.replace(/(<key>EnvironmentVariables<\/key>\s*<dict>)/, `$1${setting}`);
    return text.replace(/(<plist[^>]*>\s*<dict>)/, `$1<key>EnvironmentVariables</key><dict>${setting}</dict>`);
  }
  if (platform === "linux") return text.replace(/^(\[Service\])$/m, `$1\nEnvironment="WISP_DATA_DIR=${data.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
  // Standard PowerShell actions emitted by the CLI use -Command followed by the script.
  return text.replace(/(<Arguments>[^<]*?-Command )/, `$1${xml(`$env:WISP_DATA_DIR=${quote(data)}; `)}`);
}

/** Injectable single entry point used by startup, service commands and the desktop's migrate command. */
export function migrateServices({ platform = process.platform, home, run = serviceRunner, fs: io = fs, uid = process.getuid?.() ?? 0, systemDir = "/etc/systemd/system", system = uid === 0, kinds = ["hub", "node"], removeOnly = false, log = () => {} }: ServiceMigrationOptions): string[] {
  const changed: string[] = [];
  const moveHome = !(io.existsSync(path.join(home, ".warren")) && !io.existsSync(path.join(home, ".wisp")));
  const rewrite = (text: string, kind: "hub" | "node") => {
    let next = rewriteService(kind === "hub" ? preserveHubData(text, platform, io) : text, moveHome);
    // A checkout or system data directory can be unwritable; retain its existing path then.
    for (const base of ["/opt", "/var/lib"]) {
      if (io.existsSync(`${base}/warren`) && !io.existsSync(`${base}/wisp`)) next = next.replaceAll(`${base}/wisp`, `${base}/warren`);
    }
    return next;
  };
  const attempt = (cmd: string, args: string[]) => { try { return run(cmd, args); } catch { return ""; } };
  const publish = (file: string, content: string) => {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.wisp-tmp-${process.pid}`;
    io.writeFileSync(tmp, content, { mode: 0o600 });
    io.renameSync(tmp, file);
  };
  for (const kind of kinds) {
    if (platform === "darwin") {
      const oldName = `ai.warren.${kind}`, name = `ai.wisp.${kind}`;
      const oldFile = path.join(home, "Library/LaunchAgents", `${oldName}.plist`);
      if (!io.existsSync(oldFile)) continue;
      const file = path.join(path.dirname(oldFile), `${name}.plist`);
      const original = io.readFileSync(oldFile, "utf8");
      if (!removeOnly && !io.existsSync(file)) publish(file, rewrite(original, kind));
      // The new process must not see the old definition and try this handoff again.
      io.rmSync(oldFile, { force: true });
      if (!removeOnly) {
        try { run("launchctl", ["bootstrap", `gui/${uid}`, file]); }
        catch (err) {
          try { run("launchctl", ["print", `gui/${uid}/${name}`]); }
          catch { publish(oldFile, original); throw err; }
        }
      }
      changed.push(oldName);
      // Stop last: this can be the launchd job running this very migration after an update.
      attempt("launchctl", ["bootout", `gui/${uid}/${oldName}`]);
    } else if (platform === "linux") {
      const oldName = kind === "hub" ? "warren" : "warren-node", name = kind === "hub" ? "wisp" : "wisp-node";
      const locations = [{ dir: path.join(home, ".config/systemd/user"), prefix: ["--user"] }, ...(system ? [{ dir: systemDir, prefix: [] as string[] }] : [])];
      for (const { dir, prefix } of locations) {
        const oldFile = path.join(dir, `${oldName}.service`), file = path.join(dir, `${name}.service`);
        if (!io.existsSync(oldFile)) continue;
        if (!removeOnly && !io.existsSync(file)) publish(file, rewrite(io.readFileSync(oldFile, "utf8"), kind));
        attempt("systemctl", [...prefix, "disable", oldName]);
        io.rmSync(oldFile, { force: true });
        run("systemctl", [...prefix, "daemon-reload"]);
        if (!removeOnly) { run("systemctl", [...prefix, "enable", name]); run("systemctl", [...prefix, "restart", name]); }
        changed.push(oldName);
        attempt("systemctl", [...prefix, "stop", oldName]);
      }
    } else if (platform === "win32") {
      const oldName = `Warren ${kind}`, name = `Wisp ${kind}`;
      const definition = attempt("powershell.exe", ["-NoProfile", "-Command", `if (Get-ScheduledTask -TaskName ${quote(oldName)} -ErrorAction SilentlyContinue) { Export-ScheduledTask -TaskName ${quote(oldName)} }`]);
      if (!definition.trim()) continue;
      if (!removeOnly) {
        const xml = rewrite(definition, kind);
        run("powershell.exe", ["-NoProfile", "-Command", `if (-not (Get-ScheduledTask -TaskName ${quote(name)} -ErrorAction SilentlyContinue)) { Register-ScheduledTask -TaskName ${quote(name)} -Xml ${quote(xml)} | Out-Null }`]);
      }
      if (!removeOnly) run("powershell.exe", ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName ${quote(name)}`]);
      run("powershell.exe", ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName ${quote(oldName)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${quote(oldName)} -Confirm:$false`]);
      changed.push(oldName);
    }
  }
  if (changed.length) log(`Wisp ${removeOnly ? "removed" : "replaced"} old services: ${changed.join(", ")}`);
  return changed;
}
