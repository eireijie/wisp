import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type { HarnessLogin } from "@wisp/core";

/**
 * Signing a harness account in from Wisp: the device runs the harness's own sign-in command
 * (with the account's folder), and Wisp shows the link and code it prints, so nobody needs the
 * device's terminal. Device-code sign-ins finish on their own once approved; ones that print a
 * link and then wait for a pasted code get it through `input`.
 */
export class HarnessLogins {
  private live = new Map<string, { state: HarnessLogin; child: ChildProcess; timer: ReturnType<typeof setTimeout> }>();
  /** finished sign-ins stay readable for a while, so the page sees how they ended */
  private ended = new Map<string, HarnessLogin>();

  constructor(private onDone: (login: HarnessLogin) => void = () => {}) {}

  /**
   * `opts.redact`: what must never show in `output` (a token the sign-in prints), replaced there;
   * `opts.onRaw` sees everything it prints, unredacted (to pick that token up); `opts.onChange`
   * hears each time the link or code shows up.
   */
  start(harness: string, account: string, cmd: { command: string; args: string[]; env: Record<string, string> }, timeoutMs = 15 * 60_000, opts: { redact?: RegExp; redactStart?: string; onRaw?: (text: string) => void; onChange?: (login: HarnessLogin) => void } = {}): HarnessLogin {
    // one sign-in per account at a time
    for (const [id, l] of this.live) if (l.state.harness === harness && l.state.account === account) this.cancel(id);
    const id = `login_${crypto.randomBytes(6).toString("hex")}`;
    const state: HarnessLogin = { id, harness, account, status: "running", output: "" };
    const child = spawn(cmd.command, cmd.args, { env: { ...process.env, ...cmd.env, NO_COLOR: "1", BROWSER: "none" }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    const timer = setTimeout(() => this.finish(id, "failed", "The sign-in took too long, so it was stopped. Start it again."), timeoutMs);
    this.live.set(id, { state, child, timer });
    // everything it printed, unredacted; what people see is made from this each time, so a token
    // split across two chunks is still caught whole (redacting the already-redacted text plus the
    // new chunk would let the token's tail through)
    let raw = "";
    const render = (final: boolean) => {
      let out = clean(raw);
      if (opts.redact) out = out.replace(new RegExp(opts.redact.source, "g"), "[saved]");
      if (opts.redact && !final) out = withheld(out, opts.redact, opts.redactStart);
      return out.slice(-4000);
    };
    const take = (d: Buffer) => {
      opts.onRaw?.(d.toString());
      raw = (raw + d.toString()).slice(-16_000);
      state.output = render(false);
      const found = findLink(state.output);
      const changed = (found.url && found.url !== state.url) || (found.code && found.code !== state.code);
      if (found.url) state.url = found.url;
      if (found.code) state.code = found.code;
      if (changed) opts.onChange?.({ ...state });
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", (e) => this.finish(id, "failed", `couldn't start ${cmd.command}: ${e.message}`));
    child.on("close", (code) => {
      // nothing more is coming: what was held back shows (redacted)
      state.output = render(true);
      this.finish(id, code === 0 ? "done" : "failed", code === 0 ? undefined : lastLine(state.output) || `the sign-in ended with code ${code}`);
    });
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

/**
 * What may show of `out` (already redacted) while more may follow: a token still being printed
 * at the very end, or the start of one ("sk-ant-o"), is held back until the next chunk shows
 * where it ends. Exported for tests.
 */
export function withheld(out: string, redact: RegExp, start?: string): string {
  if (!start) return out;
  const tail = /\S*$/.exec(out)![0];
  const partial = tail.length >= 3 && (start.startsWith(tail) || (tail.startsWith(start) && !new RegExp(redact.source).test(tail)));
  return partial ? out.slice(0, -tail.length) : out;
}

/** Terminal colors and cursor moves out. */
function clean(s: string): string {
  // OSC sequences (a terminal link) end with BEL or ESC \
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001b[()][A-Za-z0-9]/g, "").replace(/\r(?!\n)/g, "\n");
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter((l) => l.trim()).pop()?.trim().slice(0, 300) ?? "";
}

/**
 * The link to open and the one-time code to enter, as sign-ins print them ("go to
 * https://…/device and enter ABCD-1234"). The last link wins: a later one is what it's waiting on.
 *
 * A code is only ever looked for outside links: sign-in links are full of "code" (`code=true`,
 * `…%2Foauth%2Fcode%2Fcallback`, `code_challenge=…`), and none of that is a code to type. One in a
 * link's `user_code` is used only when it looks like one. Codes are upper-case letters
 * and digits, often in halves (ABCD-1234). Sign-ins that want a code pasted back (Claude Code) have
 * none to show. Exported for tests.
 */
export function findLink(output: string): { url?: string; code?: string } {
  const LINK = /https?:\/\/[^\s"'<>)\]]+/g;
  const urls = [...output.matchAll(LINK)].map((m) => m[0].replace(/[.,;:]+$/, ""));
  const url = urls.at(-1);
  const isCode = (s: string | undefined | null): s is string => !!s && /^(?:[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})+|[A-Z0-9]{6,10})$/.test(s) && /[A-Z]/.test(s) && /\d|-/.test(s);
  // the words around the links, with each link swapped for a space so nothing in one is read as a code
  const text = output.replace(LINK, " ");
  // near the word "code", within a couple of lines ("Enter this one-time code (expires in 15 minutes)\n   7O27-5PWBT")
  let code: string | undefined;
  for (const m of text.matchAll(/\bcode\b([\s\S]{0,120})/gi)) {
    code = m[1].split(/[^A-Za-z0-9-]+/).find(isCode);
    if (code) break;
  }
  code ??= text.split(/[^A-Za-z0-9-]+/).find((w) => /^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/.test(w) && isCode(w));
  if (!code) {
    for (const u of urls) {
      try {
        const q = new URL(u).searchParams;
        const v = q.get("user_code");
        if (isCode(v)) code = v;
      } catch {}
    }
  }
  return { url, code };
}
