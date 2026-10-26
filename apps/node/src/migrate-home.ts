import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export interface HomeMigrationOptions {
  home: string;
  from?: string;
  to?: string;
  log?: (line: string) => void;
  fs?: typeof fs;
}

/** Move once, without merging homes. The old path remains usable by existing services. */
export function migrateHome({ home, from = ".warren", to = ".wisp", log = () => {}, fs: io = fs }: HomeMigrationOptions) {
  const source = path.join(home, from);
  const destination = path.join(home, to);
  const stat = (p: string) => io.lstatSync(p, { throwIfNoEntry: false });
  if (stat(destination)) {
    // Recover the small rename-to-alias window after an interrupted migration.
    if (!stat(source)) {
      try { io.symlinkSync(destination, source, process.platform === "win32" ? "junction" : "dir"); }
      catch (err) { log(`Wisp could not restore the old home alias ${source}: ${(err as Error).message}`); }
    }
    return { moved: false, dir: destination };
  }
  if (!stat(source)?.isDirectory() || stat(source)?.isSymbolicLink())
    return { moved: false, dir: stat(source)?.isDirectory() ? source : destination };
  let moved = false;
  let sourceBackup: string | undefined;
  try {
    try {
      io.renameSync(source, destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      // Stage and verify every byte/link before publishing or removing the source.
      const stage = `${destination}.migrate-${process.pid}-${crypto.randomUUID()}`;
      const manifest = (root: string): string => {
        const entries: string[] = [];
        const walk = (rel: string) => {
          const file = path.join(root, rel), s = io.lstatSync(file);
          if (s.isSymbolicLink()) entries.push(`${rel}:link:${io.readlinkSync(file)}`);
          else if (s.isDirectory()) { entries.push(`${rel}:dir`); for (const n of io.readdirSync(file).sort()) walk(path.join(rel, n)); }
          else entries.push(`${rel}:${crypto.createHash("sha256").update(io.readFileSync(file)).digest("hex")}`);
        };
        walk("");
        return entries.join("\n");
      };
      try {
        io.cpSync(source, stage, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        if (manifest(source) !== manifest(stage)) throw new Error("copied home failed verification");
        if (stat(destination)) throw new Error("destination appeared during migration");
        io.renameSync(stage, destination);
        moved = true;
        // Rename on the source device before removing anything; a failed delete cannot
        // leave the old path pointing at a partially removed home.
        sourceBackup = `${source}.wisp-migrate-old-${crypto.randomUUID()}`;
        io.renameSync(source, sourceBackup);
      } finally { io.rmSync(stage, { recursive: true, force: true }); }
    }
    moved = true;
    // Leave the alias first: even an unreadable config cannot break old absolute paths.
    io.symlinkSync(destination, source, process.platform === "win32" ? "junction" : "dir");
    const rewrite = (dir: string) => {
      for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
        // User workspaces, vaults and harness histories are content, not device configuration.
        if (entry.isSymbolicLink() || ["node_modules", ".git", "agents", "repos", "files", "vault", "sessions", "projects", "memories", "skills", "logs"].includes(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) rewrite(file);
        else if (entry.name.endsWith(".json")) {
          try {
            const text = io.readFileSync(file, "utf8");
            const parsed = JSON.parse(text);
            const visit = (value: any): any => typeof value === "string"
              ? value.replaceAll(`/${from}/`, `/${to}/`).replaceAll(`\\${from}\\`, `\\${to}\\`)
              : Array.isArray(value) ? value.map(visit)
              : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)])) : value;
            const after = JSON.stringify(visit(parsed), null, 2);
            if (JSON.stringify(parsed) !== JSON.stringify(visit(parsed))) {
              const tmp = `${file}.wisp-tmp-${process.pid}`;
              io.writeFileSync(tmp, after + "\n", { mode: io.statSync(file).mode & 0o777 });
              io.renameSync(tmp, file);
            }
          } catch { /* Non-config JSON or inaccessible file: the old-path alias still works. */ }
        }
      }
    };
    rewrite(destination);
    if (sourceBackup) io.rmSync(sourceBackup, { recursive: true });
    log(`Wisp migrated ${source} to ${destination} (old path kept as an alias)`);
    return { moved: true, dir: destination };
  } catch (err) {
    log(`Wisp could not finish migrating ${source}: ${(err as Error).message}; using ${moved ? destination : source}`);
    return { moved, dir: moved ? destination : source };
  }
}

/** The checkout this file lives in (apps/node/src → repo root). */
export const checkoutDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Hubs from before the rename kept their data in <checkout>/data. Keep using it until <home>/data holds a database. */
export function defaultHubDataDir(homeDir: string, checkout = checkoutDir, log: (line: string) => void = () => {}, io: typeof fs = fs): string {
  const hasDb = (dir: string) => ["wisp.db", "warren.db"].some((name) => io.existsSync(path.join(dir, name)));
  const fresh = path.join(homeDir, "data"), old = path.join(checkout, "data");
  if (hasDb(fresh) || !hasDb(old)) return fresh;
  log(`Wisp is using the data folder from before the rename (${old})`);
  return old;
}

/** Linux system installs use the same migration, but can retain the old directory if unwritable. */
export function migrateDataDir(dir: string, log: (line: string) => void = () => {}, io: typeof fs = fs): string {
  if (["/var/lib/wisp", "/var/lib/warren"].includes(dir) && !io.existsSync("/var/lib/wisp") && io.existsSync("/var/lib/warren"))
    return migrateHome({ home: "/var/lib", from: "warren", to: "wisp", log, fs: io }).dir;
  return dir;
}
