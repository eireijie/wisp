import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TRANSFER_BYTES, POSIX_FILES, expandHome, parseListing, sortEntries, type FileEntry, type FolderListing } from "@wisp/core";
import { ActionError, exec, has, type ExecResult } from "./driver.ts";

/** A computer's clipboard (text). */
export interface Clipboard {
  get(): Promise<string>;
  set(text: string): Promise<void>;
}

/** A computer's files, for moving them to and from people's devices. */
export interface Files {
  list(folder?: string): Promise<FolderListing>;
  read(file: string): Promise<{ name: string; data: Buffer }>;
  /** puts the file in `folder` (made if missing), renaming it if the name is taken; returns where it went */
  write(folder: string, name: string, data: Buffer): Promise<string>;
  mkdir(folder: string, name: string): Promise<string>;
}

/** Runs `sh -c script sh ...args` on the computer, with `input` on stdin. */
export type ShRunner = (script: string, args: string[], input?: Buffer | string) => Promise<ExecResult>;

const fail = (r: ExecResult, what: string) => new ActionError(r.stderr.trim().split("\n").pop() || `couldn't ${what}`);

/** Files on a Linux computer reached through a shell (a VM). */
export function shellFiles(sh: ShRunner): Files {
  return {
    async list(folder) {
      const r = await sh(POSIX_FILES.list, [folder ?? "~"]);
      if (r.code !== 0) throw fail(r, "open that folder");
      return parseListing(r.stdout.toString());
    },
    async read(file) {
      const r = await sh(POSIX_FILES.read(MAX_TRANSFER_BYTES), [file]);
      if (r.code !== 0) throw fail(r, "read that file");
      return { name: path.posix.basename(file), data: r.stdout };
    },
    async write(folder, name, data) {
      const r = await sh(POSIX_FILES.write, [folder, name], data);
      if (r.code !== 0) throw fail(r, "save the file");
      return r.stdout.toString().trim();
    },
    async mkdir(folder, name) {
      const r = await sh(POSIX_FILES.mkdir, [folder, name]);
      if (r.code !== 0) throw fail(r, "make the folder");
      return r.stdout.toString().trim();
    },
  };
}

/** The clipboard of an X11 desktop, with xclip (in the VM image; on Linux devices, if installed). */
export function x11Clipboard(sh: ShRunner): Clipboard {
  return {
    async get() {
      // xclip fails when the clipboard is empty
      const r = await sh("xclip -selection clipboard -o 2>/dev/null || true", []);
      return r.stdout.toString();
    },
    async set(text) {
      // xclip stays behind to serve the clipboard; its output is closed so the call returns
      const r = await sh("xclip -selection clipboard -i >/dev/null 2>&1", [], text);
      if (r.code !== 0) throw fail(r, "set the clipboard");
    },
  };
}

/**
 * Files on this device itself, for its owner. Only inside the home folder: that's where people's
 * files are, and it keeps system folders out of reach.
 */
export function localFiles(home = os.homedir()): Files {
  const inside = async (p: string, mustExist = true) => {
    const abs = path.resolve(expandHome(p, home));
    // a folder that doesn't exist yet: the real path of the part that does, plus the rest
    let real: string | null = null;
    for (let at = abs, rest = ""; !real; rest = path.join(path.basename(at), rest), at = path.dirname(at)) {
      real = await fs.realpath(at).then((r) => path.join(r, rest), () => null);
      if (!real && (mustExist || at === path.dirname(at))) throw new ActionError(`There is no ${path.basename(abs)} here`);
    }
    const homeReal = await fs.realpath(home);
    const rel = path.relative(homeReal, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ActionError("Only files in your home folder can be reached from Warren");
    return real;
  };
  return {
    async list(folder) {
      const dir = await inside(folder ?? "~");
      const homeReal = await fs.realpath(home);
      const names = await fs.readdir(dir).catch(() => {
        throw new ActionError(`Can't open ${dir}`);
      });
      const entries: FileEntry[] = [];
      for (const name of names) {
        // fs.stat follows links, so a link to a folder opens like one
        const st = await fs.stat(path.join(dir, name)).catch(() => null);
        if (!st) continue;
        entries.push({ name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString() });
      }
      return { path: dir, parent: dir === homeReal ? null : path.dirname(dir), home: homeReal, entries: sortEntries(entries) };
    },
    async read(file) {
      const p = await inside(file);
      const st = await fs.stat(p);
      if (!st.isFile()) throw new ActionError(`${path.basename(p)} isn't a file`);
      if (st.size > MAX_TRANSFER_BYTES) throw new ActionError(`It's bigger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB`);
      return { name: path.basename(p), data: await fs.readFile(p) };
    },
    async write(folder, name, data) {
      const dir = await inside(folder, false);
      await fs.mkdir(dir, { recursive: true });
      const ext = path.extname(name);
      const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
      let target = path.join(dir, name);
      for (let i = 1; await exists(target); i++) target = path.join(dir, `${base} (${i})${base === name ? "" : ext}`);
      await fs.writeFile(target, data, { flag: "wx" });
      return target;
    },
    async mkdir(folder, name) {
      const target = path.join(await inside(folder), name);
      if (await exists(target)) throw new ActionError(`${name} already exists`);
      await fs.mkdir(target);
      return target;
    },
  };
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** This device's own clipboard. */
export function localClipboard(): Clipboard {
  if (process.platform === "darwin")
    return {
      get: async () => (await exec("pbpaste", [], { timeoutMs: 10_000, env: { LANG: "en_US.UTF-8" } })).stdout.toString(),
      set: async (text) => {
        const r = await exec("pbcopy", [], { input: text, timeoutMs: 10_000, env: { LANG: "en_US.UTF-8" } });
        if (r.code !== 0) throw fail(r, "set the clipboard");
      },
    };
  if (process.platform === "win32") {
    // base64 both ways, so text survives whatever code page the console has
    const ps = (script: string, input?: string) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, timeoutMs: 15_000 });
    return {
      async get() {
        const r = await ps("$t = Get-Clipboard -Raw; if ($t -eq $null) { $t = '' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))");
        if (r.code !== 0) throw fail(r, "read the clipboard");
        return Buffer.from(r.stdout.toString().trim(), "base64").toString("utf8");
      },
      async set(text) {
        const r = await ps("Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())))", Buffer.from(text, "utf8").toString("base64"));
        if (r.code !== 0) throw fail(r, "set the clipboard");
      },
    };
  }
  const env = { DISPLAY: process.env.DISPLAY ?? ":0" };
  const clip = x11Clipboard((script, args, input) => exec("sh", ["-c", script, "sh", ...args], { input, env, timeoutMs: 15_000 }));
  const need = async () => {
    if (!(await has("xclip"))) throw new ActionError("Install xclip on this device to share its clipboard");
  };
  return {
    get: async () => (await need(), clip.get()),
    set: async (text) => (await need(), clip.set(text)),
  };
}
