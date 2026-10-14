import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Launch, RunInput } from "./types.ts";

/** The command an adapter runs, after the run's launcher (if any) has had its say. */
export function launched(input: Pick<RunInput, "launch" | "cwd">, command: string, args: string[], env: Record<string, string> = {}): Launch {
  const l = { command, args, cwd: input.cwd, env };
  return input.launch ? input.launch(l) : l;
}

/** On Windows, a harness installed with npm is a `claude.cmd` shim; only cmd.exe can start those. */
function windowsScript(command: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "win32" || path.extname(command)) return null;
  const dirs = command.includes("\\") || command.includes("/") ? [""] : (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, command + ext);
      if (!fs.existsSync(file)) continue;
      return /\.(cmd|bat)$/i.test(ext) ? file : null;
    }
  }
  return null;
}

/** Quote one argument for cmd.exe so it reaches the program unchanged (the rule cross-spawn uses). */
export function escapeForCmd(arg: string): string {
  // the C runtime's rules: double backslashes before a quote, escape the quote
  let s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  // then cmd's own metacharacters
  return s.replace(/[()%!^"<>&|]/g, "^$&");
}

/**
 * Start a harness (or any command) the same way on every platform. On Windows an npm-installed
 * harness is a .cmd shim, which `spawn` can't start by itself; it goes through cmd.exe with every
 * argument quoted, so JSON and spaces in arguments survive.
 */
export function spawnCommand(command: string, args: string[], opts: SpawnOptions & { env?: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const script = windowsScript(command, opts.env ?? process.env);
  if (!script) return spawn(command, args, opts) as ChildProcessWithoutNullStreams;
  const line = [script, ...args].map(escapeForCmd).join(" ");
  return spawn(process.env.comspec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true }) as ChildProcessWithoutNullStreams;
}

export interface JsonlProcess {
  exitCode: number | null;
  stderr: string;
}

/** Spawn a process, feed each stdout JSON line to `onLine`, resolve when it exits. */
export function runJsonl(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: string; signal?: AbortSignal },
  onLine: (obj: any) => void,
): Promise<JsonlProcess> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch {
          // not JSON (banner, warning) - ignore
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-8000);
    });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) {
        try {
          onLine(JSON.parse(buf.trim()));
        } catch {}
      }
      resolve({ exitCode: code, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Run a command with simple arguments (no quoting needed) and get its stdout. On Windows it goes through the shell so .cmd shims work. */
export function execCommand(binary: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: opts.timeout ?? 10_000, maxBuffer: opts.maxBuffer, shell: process.platform === "win32" }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** First line of `<binary> --version`, or null when it isn't installed. */
export function commandVersion(binary: string): Promise<string | null> {
  return execCommand(binary, ["--version"]).then(
    (out) => out.trim().split("\n")[0] || null,
    () => null,
  );
}
