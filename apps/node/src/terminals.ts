import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile, execFileSync } from "node:child_process";

/**
 * Terminals on this device and inside the VMs it runs (the Code mod). Each one is a real pseudo
 * terminal (node-pty). A shell outlives the browser that opened it: when the viewer goes (a closed
 * laptop, a dropped connection), it keeps running for a while and the next viewer of the same
 * session gets its recent screen back. With tmux on the computer the shell also survives this
 * device's Wisp restarting.
 */

/** How long a shell nobody is looking at keeps running. */
export const KEEP_MS = 30 * 60_000;
/** Recent output kept for a viewer who comes back. */
const REPLAY_BYTES = 256 * 1024;
/** At most this many shells per device, so a stuck page can't fill it with them. */
const MAX_SHELLS = 24;

export interface ShellCommand {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** ends what outlives the pty (its tmux session), when the shell is closed for good */
  stop?: () => void;
  /** it's tmux, which redraws the whole screen for a viewer that comes back, so nothing is replayed */
  redraws?: boolean;
  /** called once when the shell is gone (exited or closed) */
  ended?: () => void;
}

export interface Pty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (cmd: ShellCommand, cols: number, rows: number) => Pty;

interface Shell {
  key: string;
  pty: Pty;
  stop?: () => void;
  redraws?: boolean;
  ended?: () => void;
  /** the size its viewer asked for last */
  size?: { cols: number; rows: number };
  replay: Buffer[];
  replayBytes: number;
  viewer: { id: string; send: (b: Buffer) => void; closed: (err?: string, exited?: boolean) => void } | null;
  timer: NodeJS.Timeout | null;
}

/** A session name from the hub, kept to what's safe in a tmux name and a shell argument. */
export function sessionName(raw: string): string {
  return (raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "main").slice(0, 40);
}

/** A word that's safe inside single quotes in sh. */
export const shellQuote = (s: string) => sq(s);
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell to open on this device itself: tmux when it's here, otherwise the person's own shell.
 * With `launch` (a harness's command, from Wisp's own list) the pane starts in that CLI, and
 * drops to a shell when it quits.
 */
export function deviceShell(session: string, opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; has?: (bin: string) => boolean; launch?: string } = {}): ShellCommand {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const has = opts.has ?? onPath;
  const cwd = os.homedir();
  const launch = opts.launch;
  if (platform === "win32") {
    const ps = has("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
    return { file: ps, args: launch ? ["-NoLogo", "-NoExit", "-Command", launch] : ["-NoLogo"], cwd };
  }
  const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  // a login shell, so the CLI is found where the person's own PATH has it
  const run = launch ? `${sq(shell)} -lc ${sq(`${launch}; exec ${sq(shell)} -l`)}` : null;
  if (has("tmux"))
    return {
      file: "tmux",
      // Wisp's pane header already names the computer, so tmux's status bar goes (for Wisp's sessions only)
      args: ["new-session", "-A", "-s", `wisp-${session}`, ...(run ? [run] : []), ";", "set-option", "-t", `wisp-${session}`, "status", "off"],
      cwd,
      env: { SHELL: shell },
      stop: () => void execFile("tmux", ["kill-session", "-t", `wisp-${session}`], () => {}),
      redraws: true,
    };
  return launch ? { file: shell, args: ["-lc", `${launch}; exec ${sq(shell)} -l`], cwd } : { file: shell, args: ["-l"], cwd };
}

/** Inside a VM: tmux when the image has it, otherwise a login bash; `launch` as for the device. */
export function vmShell(vm: { bin: string; name: string; user: string; home: string }, session: string, launch?: string): ShellCommand {
  const script = [
    'L="$2"',
    'if command -v tmux >/dev/null 2>&1; then',
    '  if [ -n "$L" ]; then exec tmux new-session -A -s "wisp-$1" "$L; exec bash -l" \\; set-option -t "wisp-$1" status off; fi',
    '  exec tmux new-session -A -s "wisp-$1" \\; set-option -t "wisp-$1" status off',
    "fi",
    '[ -n "$L" ] && sh -c "$L"',
    "exec bash -l",
  ].join("\n");
  return {
    file: vm.bin,
    args: ["exec", "-i", "-t", "-u", vm.user, "-w", vm.home, "-e", `HOME=${vm.home}`, "-e", "TERM=xterm-256color", "-e", "DISPLAY=:1", vm.name, "sh", "-c", script, "sh", session, launch ?? ""],
    stop: () => void execFile(vm.bin, ["exec", "-u", vm.user, vm.name, "sh", "-c", 'command -v tmux >/dev/null 2>&1 && tmux kill-session -t "wisp-$1"', "sh", session], () => {}),
  };
}

function onPath(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let loaded: SpawnPty | null = null;

/** node-pty, loaded the first time a terminal opens so a device that never uses Code never loads it. */
export function nodePty(): SpawnPty {
  if (loaded) return loaded;
  let mod: typeof import("node-pty");
  try {
    mod = createRequire(import.meta.url)("node-pty");
  } catch {
    throw new Error(
      process.platform === "linux"
        ? "Terminals need node-pty, which couldn't be built on this device. Install build tools (build-essential, python3), then run npm install in Wisp's folder."
        : "Terminals need node-pty, which isn't installed with this copy of Wisp. Update Wisp on this device.",
    );
  }
  // npm drops the executable bit from node-pty's helper on macOS, and then every spawn fails
  try {
    const dir = path.join(path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (fs.existsSync(dir) && !(fs.statSync(dir).mode & 0o111)) fs.chmodSync(dir, 0o755);
  } catch {}
  loaded = (cmd, cols, rows) => {
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...cmd.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    return mod.spawn(cmd.file, cmd.args, { name: "xterm-256color", cols, rows, cwd: cmd.cwd ?? os.homedir(), env }) as unknown as Pty;
  };
  return loaded;
}

export class Terminals {
  private shells = new Map<string, Shell>();
  /** viewer id → the shell it's looking at */
  private viewers = new Map<string, string>();

  constructor(private spawn: () => SpawnPty = nodePty, private keepMs = KEEP_MS) {}

  /**
   * Show `key`'s shell to a viewer, starting it with `command` if it isn't running. A viewer already
   * on that shell is let go (the newest one wins, like tmux). Resolves whether it was already running;
   * call `replay()` once the viewer is ready for its recent screen.
   */
  async attach(
    key: string,
    viewerId: string,
    size: { cols: number; rows: number },
    command: () => Promise<ShellCommand>,
    send: (b: Buffer) => void,
    closed: (err?: string, exited?: boolean) => void,
  ): Promise<{ resumed: boolean; replay: () => void }> {
    let shell = this.shells.get(key);
    const resumed = !!shell;
    if (!shell) {
      if (this.shells.size >= MAX_SHELLS) throw new Error(`this device already has ${MAX_SHELLS} terminals open; close some first`);
      const spawn = this.spawn();
      const cmd = await command();
      const pty = spawn(cmd, clamp(size.cols, 2, 1000), clamp(size.rows, 1, 500));
      // something else may have started it while the command was being worked out
      const raced = this.shells.get(key);
      if (raced) {
        pty.kill();
        shell = raced;
      } else {
        const s: Shell = { key, pty, stop: cmd.stop, redraws: cmd.redraws, ended: cmd.ended, replay: [], replayBytes: 0, viewer: null, timer: null };
        shell = s;
        this.shells.set(key, s);
        pty.onData((text) => {
          const b = Buffer.from(text, "utf8");
          s.replay.push(b);
          s.replayBytes += b.length;
          while (s.replayBytes > REPLAY_BYTES && s.replay.length > 1) s.replayBytes -= s.replay.shift()!.length;
          s.viewer?.send(b);
        });
        pty.onExit(({ exitCode }) => {
          if (this.shells.get(key) !== s) return;
          this.shells.delete(key);
          if (s.timer) clearTimeout(s.timer);
          s.ended?.();
          const v = s.viewer;
          s.viewer = null;
          if (v) {
            this.viewers.delete(v.id);
            v.closed(exitCode ? `the shell exited (${exitCode})` : undefined, true);
          }
        });
      }
    }
    if (shell.timer) clearTimeout(shell.timer);
    shell.timer = null;
    const old = shell.viewer;
    if (old && old.id !== viewerId) {
      this.viewers.delete(old.id);
      old.closed("opened somewhere else");
    }
    shell.viewer = { id: viewerId, send, closed };
    this.viewers.set(viewerId, key);
    const s = shell;
    const replay = () => {
      if (!resumed || s.viewer?.id !== viewerId) return;
      const cols = clamp(size.cols, 2, 1000);
      const rows = clamp(size.rows, 1, 500);
      s.size = { cols, rows };
      if (s.redraws) {
        // tmux draws the screen afresh at the new size, cleaner than output recorded at an old one;
        // a size change is what makes it, even when the size is the same as before. Back to the
        // size asked for last, which the page may have changed meanwhile.
        s.pty.resize(cols, Math.max(1, rows - 1));
        setTimeout(() => s.viewer?.id === viewerId && s.size && s.pty.resize(s.size.cols, s.size.rows), 250).unref?.();
        return;
      }
      for (const b of s.replay) send(b);
      s.pty.resize(cols, rows);
    };
    return { resumed, replay };
  }

  write(viewerId: string, data: Uint8Array) {
    const s = this.byViewer(viewerId);
    if (s) s.pty.write(Buffer.from(data));
  }

  resize(viewerId: string, cols: number, rows: number) {
    const s = this.byViewer(viewerId);
    if (!s) return;
    s.size = { cols: clamp(cols, 2, 1000), rows: clamp(rows, 1, 500) };
    s.pty.resize(s.size.cols, s.size.rows);
  }

  /** The viewer went away. `end`: they closed the pane, so the shell stops too; otherwise it waits for them. */
  detach(viewerId: string, end = false) {
    const key = this.viewers.get(viewerId);
    this.viewers.delete(viewerId);
    const s = key ? this.shells.get(key) : undefined;
    if (!s || s.viewer?.id !== viewerId) return;
    s.viewer = null;
    if (end) return this.kill(s);
    s.timer = setTimeout(() => this.kill(s), this.keepMs);
    s.timer.unref?.();
  }

  /** Every viewer goes (the connection to the hub dropped); the shells keep running for them to come back. */
  detachAll() {
    for (const id of [...this.viewers.keys()]) this.detach(id);
  }

  /** Stop every shell whose key starts with `prefix` (a VM removed), or all of them. */
  killAll(prefix = "") {
    for (const s of [...this.shells.values()]) if (s.key.startsWith(prefix)) {
      if (s.viewer) {
        this.viewers.delete(s.viewer.id);
        s.viewer.closed("the terminal was closed");
        s.viewer = null;
      }
      this.kill(s);
    }
  }

  get count() {
    return this.shells.size;
  }

  private byViewer(viewerId: string) {
    const key = this.viewers.get(viewerId);
    const s = key ? this.shells.get(key) : undefined;
    return s?.viewer?.id === viewerId ? s : undefined;
  }

  private kill(s: Shell) {
    if (this.shells.get(s.key) !== s) return;
    this.shells.delete(s.key);
    if (s.timer) clearTimeout(s.timer);
    try {
      s.pty.kill();
    } catch {}
    try {
      s.stop?.();
    } catch {}
    s.ended?.();
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));
}
