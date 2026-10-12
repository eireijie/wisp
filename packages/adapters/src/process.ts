import { execFile, spawn } from "node:child_process";
import type { Launch, RunInput } from "./types.ts";

/** The command an adapter runs, after the run's launcher (if any) has had its say. */
export function launched(input: Pick<RunInput, "launch" | "cwd">, command: string, args: string[], env: Record<string, string> = {}): Launch {
  const l = { command, args, cwd: input.cwd, env };
  return input.launch ? input.launch(l) : l;
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
    const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
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

/** First line of `<binary> --version`, or null when it isn't installed. */
export function commandVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim().split("\n")[0] || null));
  });
}
