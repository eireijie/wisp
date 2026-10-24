import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type { HarnessLogin } from "@wisp/core";

/**
 * Signing a harness account in from Warren: the device runs the harness's own sign-in command
 * (with the account's folder), and Warren shows the link and code it prints, so nobody needs the
 * device's terminal. Device-code sign-ins finish on their own once approved; ones that print a
 * link and then wait for a pasted code get it through `input`.
 */
export class HarnessLogins {
  private live = new Map<string, { state: HarnessLogin; child: ChildProcess; timer: ReturnType<typeof setTimeout> }>();
  /** finished sign-ins stay readable for a while, so the page sees how they ended */
  private ended = new Map<string, HarnessLogin>();

  constructor(private onDone: (login: HarnessLogin) => void = () => {}) {}

  start(harness: string, account: string, cmd: { command: string; args: string[]; env: Record<string, string> }, timeoutMs = 15 * 60_000): HarnessLogin {
    // one sign-in per account at a time
    for (const [id, l] of this.live) if (l.state.harness === harness && l.state.account === account) this.cancel(id);
    const id = `login_${crypto.randomBytes(6).toString("hex")}`;
    const state: HarnessLogin = { id, harness, account, status: "running", output: "" };
    const child = spawn(cmd.command, cmd.args, { env: { ...process.env, ...cmd.env, NO_COLOR: "1", BROWSER: "none" }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    const timer = setTimeout(() => this.finish(id, "failed", "The sign-in took too long, so it was stopped. Start it again."), timeoutMs);
    this.live.set(id, { state, child, timer });
    const take = (d: Buffer) => {
      state.output = clean(state.output + d.toString()).slice(-4000);
      const found = findLink(state.output);
      if (found.url) state.url = found.url;
      if (found.code) state.code = found.code;
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", (e) => this.finish(id, "failed", `couldn't start ${cmd.command}: ${e.message}`));
    child.on("close", (code) => this.finish(id, code === 0 ? "done" : "failed", code === 0 ? undefined : lastLine(state.output) || `the sign-in ended with code ${code}`));
    return { ...state };
  }

  status(id: string): HarnessLogin {
    const s = this.live.get(id)?.state ?? this.ended.get(id);
    if (!s) throw new Error("that sign-in isn't running anymore; start it again");
    return { ...s };
  }

  input(id: string, text: string): HarnessLogin {
    const l = this.live.get(id);
    if (!l) throw new Error("that sign-in isn't running anymore; start it again");
    l.child.stdin!.write(`${text.replace(/[\r\n]+/g, "")}\n`);
    return { ...l.state };
  }

  cancel(id: string) {
    if (this.live.has(id)) this.finish(id, "failed", "Cancelled.");
  }

  stopAll() {
    for (const id of [...this.live.keys()]) this.cancel(id);
  }

  private finish(id: string, status: "done" | "failed", error?: string) {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    clearTimeout(l.timer);
    if (l.child.exitCode === null) l.child.kill();
    l.state.status = status;
    if (error && status === "failed") l.state.error = error.slice(0, 1000);
    this.ended.set(id, l.state);
    setTimeout(() => this.ended.delete(id), 10 * 60_000).unref?.();
    this.onDone({ ...l.state });
  }
}

/** Terminal colors and cursor moves out. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\r(?!\n)/g, "\n");
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter((l) => l.trim()).pop()?.trim().slice(0, 300) ?? "";
}

/**
 * The link to open and the one-time code to enter, as sign-ins print them ("go to
 * https://…/device and enter ABCD-1234"). The last link wins: a later one is what it's waiting on.
 * Exported for tests.
 */
export function findLink(output: string): { url?: string; code?: string } {
  const urls = [...output.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""));
  const url = urls.at(-1);
  // a code is short, upper-case letters/digits, often in two halves (ABCD-1234), near the word "code"
  const near = /code[^A-Za-z0-9\n]{0,40}([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})+|[A-Z0-9]{6,10})\b/i.exec(output);
  const loose = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/.exec(output);
  const code = (near?.[1] && /[A-Z]/.test(near[1]) && /\d|-/.test(near[1]) ? near[1] : undefined) ?? loose?.[1];
  return { url, code };
}
