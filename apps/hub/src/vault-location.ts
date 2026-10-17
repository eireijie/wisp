import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the memory vault lives. By default it's `<data>/vault`. The owner can point it at any
 * folder on the hub's machine, such as an existing Obsidian vault, with Settings → Memory or the
 * WARREN_VAULT_DIR environment variable (which wins). The choice is saved in
 * `<data>/vault-location.json`, next to the database, and read once when the hub starts.
 */
export interface VaultLocation {
  /** the folder to use */
  path: string;
  /** where that choice came from */
  source: "env" | "setting" | "default";
  /** the folder the owner saved in Settings (even while an environment variable overrides it) */
  setting: string | null;
  /** the folder used last time, when it isn't this one: still there, never deleted */
  previous: string | null;
}

interface Saved {
  path?: string | null;
  /** the folder the hub used the last time it started */
  lastUsed?: string;
}

const FILE = "vault-location.json";
export const defaultVaultDir = (dataDir: string) => path.resolve(dataDir, "vault");

function readSaved(dataDir: string): Saved {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as Saved;
  } catch {
    return {};
  }
}

function writeSaved(dataDir: string, saved: Saved) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(saved, null, 2) + "\n");
}

/** "~/Notes" becomes an absolute path; anything relative is taken from where the hub runs. */
export function expandPath(p: string): string {
  const t = p.trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(os.homedir(), t.slice(2));
  return path.resolve(t);
}

export function resolveVaultLocation(dataDir: string, env: NodeJS.ProcessEnv = process.env): VaultLocation {
  const saved = readSaved(dataDir);
  const fromEnv = env.WARREN_VAULT_DIR?.trim();
  const setting = saved.path ? expandPath(saved.path) : null;
  const chosen = fromEnv ? expandPath(fromEnv) : (setting ?? defaultVaultDir(dataDir));
  const last = saved.lastUsed ?? (fs.existsSync(defaultVaultDir(dataDir)) ? defaultVaultDir(dataDir) : null);
  return { path: chosen, source: fromEnv ? "env" : setting ? "setting" : "default", setting, previous: last && last !== chosen && fs.existsSync(last) ? last : null };
}

/** Remember that the hub started with this folder (so a later change knows what it came from). */
export function rememberVaultDir(dataDir: string, used: string) {
  const saved = readSaved(dataDir);
  if (saved.lastUsed !== used) writeSaved(dataDir, { ...saved, lastUsed: used });
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Why a folder can't be the vault, in words for the owner; null when it's fine. */
export function vaultDirProblem(raw: string, dataDir: string): string | null {
  if (!raw.trim()) return "Enter a folder on the machine that runs Warren.";
  const p = expandPath(raw);
  if (!path.isAbsolute(p)) return "Enter the full path of the folder.";
  if (p === path.parse(p).root) return "Pick a folder, not the whole drive.";
  if (real(p) === real(os.homedir())) return "Pick a folder inside your home folder, not the home folder itself.";
  const data = real(dataDir);
  const target = real(p);
  if (inside(data, target)) return "That folder contains Warren's own data (the database), so it can't hold memory. Pick a different one.";
  if (inside(target, path.join(data, "files"))) return "That folder is where Warren keeps uploaded files.";
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return "That is a file, not a folder.";
  } catch {
    if (!fs.existsSync(path.dirname(p))) return "The folder it would go in doesn't exist.";
  }
  return null;
}

/** Save the owner's choice (null goes back to the default). It takes effect the next time Warren starts. */
export function saveVaultLocation(dataDir: string, raw: string | null): { ok: true } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") {
    writeSaved(dataDir, { ...readSaved(dataDir), path: null });
    return { ok: true };
  }
  const problem = vaultDirProblem(raw, dataDir);
  if (problem) return { ok: false, error: problem };
  const p = expandPath(raw);
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.warren-write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
  } catch {
    return { ok: false, error: "Warren can't write to that folder. Check that it exists and that this account may change it." };
  }
  writeSaved(dataDir, { ...readSaved(dataDir), path: p });
  return { ok: true };
}

export interface MoveResult {
  from: string;
  to: string;
  /** "copied": the new folder was empty and got the whole earlier vault, history included; "merged": it already had notes, so only files it lacked were added */
  how: "copied" | "merged" | "none";
  files: number;
}

/**
 * When the vault's folder changed since last start, bring the earlier memory along without ever
 * touching it: an empty new folder gets a full copy (with git history); a folder that already has
 * notes (an existing Obsidian vault) gets only the files it doesn't have yet, so nothing there is
 * overwritten. The earlier folder is left exactly as it was.
 */
export function carryOverVault(dataDir: string, to: string): MoveResult | null {
  const saved = readSaved(dataDir);
  const from = saved.lastUsed ?? (fs.existsSync(defaultVaultDir(dataDir)) ? defaultVaultDir(dataDir) : null);
  if (!from || from === to || !fs.existsSync(from)) return null;
  if (inside(real(to), real(from)) || inside(real(from), real(to))) return { from, to, how: "none", files: 0 };
  fs.mkdirSync(to, { recursive: true });
  const empty = fs.readdirSync(to).length === 0;
  let files = 0;
  const copy = (src: string, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      // an earlier vault's tool folders (.git, .obsidian) only travel when the new folder is empty
      if (!empty && e.name.startsWith(".")) continue;
      const a = path.join(src, e.name);
      const b = path.join(dst, e.name);
      if (e.isDirectory()) copy(a, b);
      else if (e.isFile() && !fs.existsSync(b)) {
        fs.copyFileSync(a, b);
        files++;
      }
    }
  };
  copy(from, to);
  return { from, to, how: empty ? "copied" : "merged", files };
}
