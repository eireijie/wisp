import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ACCOUNT_ID, harnessInfo, type HarnessAccount } from "@wisp/core";
import { HARNESS_SPECS, harnessConfigPath, harnessDir, type HarnessHomes } from "./harness-config.ts";

/**
 * Several logins of one harness on a device (a work and a personal Claude, two ChatGPT accounts for
 * Codex). Each account is the harness's own folder somewhere else, which its home variable
 * (CODEX_HOME, CLAUDE_CONFIG_DIR, HERMES_HOME…) points it at, so logins never mix. The default
 * account is the harness's usual folder. Hermes already has this: its profiles.
 *
 * Which accounts exist and which agent uses which is kept on the device (harness-accounts.json in
 * Wisp's folder there), like everything else about the harness.
 */

export interface AccountsFile {
  accounts: Record<string, { id: string; label: string }[]>;
  /** agent id → account id, for agents that don't use the default account */
  agents: Record<string, string>;
}

const PROBE_MS = 10_000;

/** Asks a harness whether an account is signed in: true, false, or null when it can't tell. */
export type SignInProbe = (harness: string, binary: string, env: Record<string, string>) => Promise<boolean | null>;

/** The harnesses' own read-only status commands, and how to read their answers. Exported for tests. */
export const SIGN_IN_STATUS: Record<string, { binary: string; args: string[]; read: (stdout: string, code: number, stderr: string) => boolean | null }> = {
  "claude-code": {
    binary: "claude",
    args: ["auth", "status", "--json"],
    read: (stdout) => {
      try {
        const v = JSON.parse(stdout).loggedIn;
        return typeof v === "boolean" ? v : null;
      } catch {
        return null; // a version with no such command
      }
    },
  },
  codex: { binary: "codex", args: ["login", "status"], read: (stdout, code, stderr) => (code === 0 ? true : /not logged in/i.test(`${stdout}\n${stderr}`) ? false : null) },
};

const askHarness: SignInProbe = (harness, binary, env) =>
  new Promise((resolve) => {
    const s = SIGN_IN_STATUS[harness];
    execFile(binary, s.args, { env: { ...process.env, ...env }, timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (err as { code?: unknown }).code : 0;
      // it didn't run at all (not installed, timed out): that says nothing about the sign-in
      resolve(typeof code === "number" ? s.read(stdout, code, stderr) : null);
    });
  });

export class HarnessAccounts {
  constructor(
    /** Wisp's folder on the device (~/.wisp) */
    private wispDir: string,
    private h: HarnessHomes = {},
  ) {}

  private probed = new Map<string, { at: number; signedIn: boolean | null }>();

  private get file() {
    return path.join(this.wispDir, "harness-accounts.json");
  }

  read(): AccountsFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { accounts: v.accounts ?? {}, agents: v.agents ?? {} };
    } catch {
      return { accounts: {}, agents: {} };
    }
  }

  private write(v: AccountsFile) {
    fs.mkdirSync(this.wispDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(v, null, 2), { mode: 0o600 });
  }

  /** The folder an account's harness uses. */
  dir(harness: string, account: string): string {
    const base = harnessDir(harness, this.h);
    if (!base) throw new Error(`Wisp can't add accounts to ${harness} yet`);
    if (account === "default") return base;
    ACCOUNT_ID.parse(account);
    // Hermes's own profiles, so `hermes -p <name>` sees the same account
    if (harness === "hermes") return path.join(base, "profiles", account);
    const root = path.join(this.wispDir, "accounts", harness, account);
    return HARNESS_SPECS[harness].accountDir?.(root) ?? root;
  }

  /** Point a run (or a sign-in) at an account's folder; nothing for the default one. */
  env(harness: string, account: string | undefined): Record<string, string> {
    const spec = HARNESS_SPECS[harness];
    if (!account || account === "default" || !spec?.accounts) return {};
    const dir = this.dir(harness, account);
    return { [spec.env]: spec.envValue?.(dir) ?? dir };
  }

  /** Harnesses whose logins live in their folder, so a second account is really separate. */
  static supports(harness: string): boolean {
    return !!HARNESS_SPECS[harness]?.accounts;
  }

  /** Every account of a harness, the default first. Hermes profiles made outside Wisp count too. */
  list(harness: string): HarnessAccount[] {
    if (!harnessDir(harness, this.h)) return [];
    const known = HarnessAccounts.supports(harness) ? (this.read().accounts[harness] ?? []) : [];
    const out: HarnessAccount[] = [{ id: "default", label: "Default", isDefault: true, ...signedIn(harness, this.dir(harness, "default")) }];
    const ids = new Set<string>();
    for (const a of known) {
      ids.add(a.id);
      out.push({ id: a.id, label: a.label, isDefault: false, ...signedIn(harness, this.dir(harness, a.id)) });
    }
    if (harness === "hermes") {
      const root = path.join(harnessDir(harness, this.h)!, "profiles");
      for (const n of safeReaddir(root).sort()) {
        if (ids.has(n) || !ACCOUNT_ID.safeParse(n).success || !fs.statSync(path.join(root, n)).isDirectory()) continue;
        out.push({ id: n, label: n, isDefault: false, ...signedIn(harness, path.join(root, n)) });
      }
    }
    return out;
  }

  /**
   * The same list, after asking the harness itself about any account its files don't show a login
   * for: macOS keeps Claude Code's in the Keychain and Codex can keep its there too, and either can
   * run on a key from the environment. Answers are kept for a few seconds, since pages poll this.
   */
  async listChecked(harness: string, binary?: string, probe: SignInProbe = askHarness): Promise<HarnessAccount[]> {
    return Promise.all(
      this.list(harness).map(async (a) => {
        // a run here was just turned away for this sign-in: the harness's own status would still say yes
        if (this.failed(harness, a.id)) return { ...a, signedIn: false };
        if (a.signedIn === true || !SIGN_IN_STATUS[harness]) return a;
        const key = `${harness}\n${a.id}`;
        const known = this.probed.get(key);
        if (known && Date.now() - known.at < PROBE_MS) return { ...a, signedIn: known.signedIn };
        const answer = await probe(harness, binary ?? SIGN_IN_STATUS[harness].binary, this.env(harness, a.id));
        // null: too old a harness to ask, or it wouldn't say; what the files show is all there is
        const signedIn = answer ?? a.signedIn;
        this.probed.set(key, { at: Date.now(), signedIn });
        return { ...a, signedIn };
      }),
    );
  }

  /** A sign-in finished: ask again next time instead of repeating the old answer. */
  forgetChecks(harness?: string) {
    this.probed.clear();
    if (harness) this.writeFailed(Object.fromEntries(Object.entries(this.readFailed()).filter(([k]) => !k.startsWith(`${harness}\n`))));
  }

  private get failedFile() {
    return path.join(this.wispDir, "harness-signin-failed.json");
  }

  private readFailed(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.failedFile, "utf8")) ?? {};
    } catch {
      return {};
    }
  }

  private writeFailed(v: Record<string, string>) {
    if (!Object.keys(v).length) return void fs.rmSync(this.failedFile, { force: true });
    fs.mkdirSync(this.wispDir, { recursive: true });
    fs.writeFileSync(this.failedFile, JSON.stringify(v, null, 2), { mode: 0o600 });
  }

  /**
   * A run was turned away because its sign-in expired or was revoked ("OAuth session expired and
   * could not be refreshed"), which the harness's status command still calls signed in. Count the
   * account as signed out until it signs in again: a sign-in through Wisp, its login files changing,
   * or a run that works. Not for a run on a Models connection, whose sign-in isn't this account's.
   */
  markSignedOut(harness: string, account: string) {
    if (!harnessDir(harness, this.h)) return;
    this.writeFailed({ ...this.readFailed(), [`${harness}\n${account}`]: this.stamp(harness, account) });
  }

  /** A run worked: whatever turned the account away before is fixed. True when that changed something. */
  markWorked(harness: string, account: string): boolean {
    const all = this.readFailed();
    const key = `${harness}\n${account}`;
    if (!(key in all)) return false;
    delete all[key];
    this.writeFailed(all);
    return true;
  }

  /** Was the account's last run turned away for its sign-in, with nothing signed in since? */
  private failed(harness: string, account: string): boolean {
    const all = this.readFailed();
    const key = `${harness}\n${account}`;
    if (!(key in all)) return false;
    if (all[key] === this.stamp(harness, account)) return true;
    // someone signed in again (here, in a terminal): ask the harness again
    delete all[key];
    this.writeFailed(all);
    return false;
  }

  /** When the account's login files last changed, to tell a new sign-in from the one that failed. */
  private stamp(harness: string, account: string): string {
    let dir: string;
    try {
      dir = this.dir(harness, account);
    } catch {
      return "";
    }
    return LOGIN_FILES.map((f) => {
      try {
        return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`;
      } catch {
        return "";
      }
    }).join("|");
  }

  /** The account an agent uses (the default one unless it was given another). */
  accountOf(agentId: string, harness: string): string {
    const id = this.read().agents[agentId];
    return id && this.list(harness).some((a) => a.id === id) ? id : "default";
  }

  agentAccounts(): Record<string, string> {
    return this.read().agents;
  }

  /**
   * A new, signed-out account. It starts with the default account's settings file (its model,
   * plugins, apps), never its logins.
   */
  add(harness: string, label: string): HarnessAccount {
    if (!HarnessAccounts.supports(harness)) throw new Error(`${harness} keeps its logins outside its folder (in the system keychain or its own data folder), so Wisp can't keep a second account apart yet`);
    const v = this.read();
    const list = (v.accounts[harness] ??= []);
    const taken = new Set([...this.list(harness).map((a) => a.id)]);
    const base = slug(label) || "account";
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`.slice(0, 64);
    const dir = this.dir(harness, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (harness === "hermes") for (const d of ["memories", "sessions", "skills", "logs"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const from = harnessConfigPath(harness, this.h)!;
    const to = path.join(dir, HARNESS_SPECS[harness].config);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    list.push({ id, label: label.trim().slice(0, 80) });
    this.write(v);
    return this.list(harness).find((a) => a.id === id)!;
  }

  rename(harness: string, account: string, label: string) {
    const v = this.read();
    const list = (v.accounts[harness] ??= []);
    const a = list.find((x) => x.id === account);
    if (a) a.label = label.trim().slice(0, 80);
    else if (harness === "hermes" && this.list(harness).some((x) => x.id === account)) list.push({ id: account, label: label.trim().slice(0, 80) });
    else throw new Error(account === "default" ? "the default account keeps its name" : `${harness} has no account "${account}"`);
    this.write(v);
  }

  /**
   * Stop using an account. Its folder (and the login in it) stays on the device, so nothing is lost
   * by accident; agents that used it go back to the default account.
   */
  remove(harness: string, account: string): { dir: string } {
    if (account === "default") throw new Error("the default account can't be removed");
    const v = this.read();
    const dir = this.dir(harness, account);
    v.accounts[harness] = (v.accounts[harness] ?? []).filter((a) => a.id !== account);
    for (const [agent, a] of Object.entries(v.agents)) if (a === account) delete v.agents[agent];
    this.write(v);
    return { dir };
  }

  assign(agentId: string, harness: string, account: string | null) {
    if (account && account !== "default" && !this.list(harness).some((a) => a.id === account)) throw new Error(`${harness} has no account "${account}"`);
    const v = this.read();
    if (!account || account === "default") delete v.agents[agentId];
    else v.agents[agentId] = account;
    this.write(v);
  }
}

/**
 * The command that signs an account in on the device, run with the account's folder. Ones that
 * print a link and a code (device sign-in) work from anywhere; Wisp shows them.
 */
export function loginCommand(harness: string, provider?: string): { command: string; args: string[] } | { manual: string[] } {
  if (harness === "codex") return { command: "codex", args: ["login", "--device-auth"] };
  if (harness === "kimi") return { command: "kimi", args: ["login"] };
  if (harness === "hermes") {
    if (!provider) throw new Error("pick the provider to sign in to");
    return { command: "hermes", args: ["auth", "add", provider] };
  }
  // the browser shows a code to paste back, which Wisp passes on
  if (harness === "claude-code") return { command: "claude", args: ["auth", "login"] };
  // their sign-in only runs inside their own screen: the command to run at the device
  if (harness === "gemini") return { manual: ["gemini"] };
  if (harness === "qwen") return { manual: ["qwen", "(then /auth)"] };
  const login = harnessInfo(harness)?.login;
  if (login) return { manual: [login] };
  throw new Error(`Wisp can't sign ${harness} in yet; sign in on the device`);
}

/**
 * Runs a command in a pseudo-terminal 400 columns wide and relays it, for sign-ins that only run in
 * a terminal (`claude setup-token` draws its screen with Ink and prints nothing without one). Wide,
 * so the link and the token it prints aren't wrapped; Enter from Wisp is sent as a terminal's \r.
 */
const PTY_RELAY = String.raw`
import os, pty, sys, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 400, 0, 0))
    os.execvp(sys.argv[1], sys.argv[1:])
watch = [fd, 0]
while True:
    r, _, _ = select.select(watch, [], [])
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data.replace(b"\n", b"\r"))
        else:
            watch = [fd]
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8)
`;

/**
 * How a device signs in to a model provider for a connection (models.ts), in a scratch folder the
 * caller points the harness at (`home` is the variable to set). What the sign-in leaves behind is
 * read by `secretFrom`, so the hub can keep it:
 * - Claude: `claude setup-token`, a one-year token for the subscription, printed at the end (needs a terminal, so it runs in one)
 * - ChatGPT: `codex login --device-auth`, a link and code; the sign-in lands in auth.json
 * - Grok: `hermes auth add xai-oauth`, a link and code; the sign-in lands in Hermes's credential pool
 */
export function modelLoginCommand(provider: string, harness: string, binary?: string): { command: string; args: string[]; home: string; wantsInput: boolean } {
  if (provider === "anthropic" && harness === "claude-code") {
    if (process.platform === "win32") throw new Error("Claude's sign-in for Wisp needs a Mac or Linux device; or connect an API key instead");
    return { command: "python3", args: ["-c", PTY_RELAY, binary ?? "claude", "setup-token"], home: "CLAUDE_CONFIG_DIR", wantsInput: true };
  }
  if (provider === "openai" && harness === "codex") return { command: binary ?? "codex", args: ["login", "--device-auth", "-c", `cli_auth_credentials_store="file"`], home: "CODEX_HOME", wantsInput: false };
  if (provider === "xai" && harness === "hermes") return { command: binary ?? "hermes", args: ["auth", "add", "xai-oauth", "--type", "oauth", "--no-browser"], home: "HERMES_HOME", wantsInput: false };
  throw new Error(`Wisp can't sign in to ${provider} with ${harness}`);
}

/** The long-lived token `claude setup-token` prints (sk-ant-oat01-…), from its output. Exported for tests. */
export function setupTokenFrom(output: string): string | null {
  return /sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/.exec(output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""))?.[0] ?? null;
}

/** The files in an account's folder that a sign-in writes, for every harness. */
const LOGIN_FILES = [".credentials.json", ".credentials", "auth.json", ".env", "oauth_creds.json", "credentials/kimi-code.json"];

/** Claude Code's file login, if it's one that can't work any more: expired with nothing to renew it. */
function claudeLoginDead(file: string): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth;
    return !!o && typeof o.expiresAt === "number" && o.expiresAt < Date.now() && !o.refreshToken;
  } catch {
    return false;
  }
}

/** Whether an account's folder holds a login, from the files harnesses keep it in (null: can't tell). */
function signedIn(harness: string, dir: string): { signedIn: boolean | null } {
  if (harness === "codex") return { signedIn: fs.existsSync(path.join(dir, "auth.json")) };
  if (harness === "hermes") {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
      if (Object.keys(auth.providers ?? {}).length || Object.keys(auth.credential_pool ?? {}).length) return { signedIn: true };
    } catch {}
    const env = (() => {
      try {
        return fs.readFileSync(path.join(dir, ".env"), "utf8");
      } catch {
        return "";
      }
    })();
    return { signedIn: /^[A-Z_]*API_KEY\s*=\s*\S+/m.test(env) };
  }
  if (harness === "claude-code") {
    // Linux and Windows keep it in a file; macOS keeps it in the Keychain, which only Claude Code reads
    if (fs.existsSync(path.join(dir, ".credentials.json"))) return { signedIn: !claudeLoginDead(path.join(dir, ".credentials.json")) };
    return { signedIn: process.platform === "darwin" ? null : false };
  }
  if (harness === "kimi") return { signedIn: fs.existsSync(path.join(dir, "credentials", "kimi-code.json")) };
  if (harness === "gemini") return { signedIn: fs.existsSync(path.join(dir, "oauth_creds.json")) || /^GEMINI_API_KEY\s*=\s*\S+/m.test(readText(path.join(dir, ".env"))) };
  // what's left (a key in its settings, a provider it was pointed at) can't be read from outside, so it's unknown, never "no"
  if (harness === "qwen") return { signedIn: fs.existsSync(path.join(dir, "oauth_creds.json")) || /^[A-Z_]*API_KEY\s*=\s*\S+/m.test(readText(path.join(dir, ".env"))) || null };
  return { signedIn: null };
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
