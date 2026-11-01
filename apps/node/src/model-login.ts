import fs from "node:fs";
import path from "node:path";
import { chatgptAccount, type ConnectionSecret, type HarnessLogin, type ModelLogin, type ModelProvider, type NodeToHub } from "@wisp/core";
import { modelLoginCommand, setupTokenFrom } from "@wisp/adapters";
import { HarnessLogins } from "./harness-login.ts";

/**
 * Signing in to a model provider for the hub (Settings → Models → Connect): the device runs the
 * harness's own sign-in in a scratch folder nobody else uses, shows the link and code through the
 * hub, and once it's approved hands what the sign-in saved to the hub, which keeps it as a
 * connection. The scratch folder is deleted either way, so the device keeps nothing; scratch folders
 * live under `scratchRoot`, which is emptied on start in case a crash left one with a sign-in in it.
 */
export class ModelLogins {
  private logins: HarnessLogins;
  /** by the hub's id for the sign-in */
  private live = new Map<string, { inner: string; provider: ModelProvider; harness: string; dir: string; raw: string; wantsInput: boolean }>();

  constructor(
    private send: (m: NodeToHub) => void,
    private scratchRoot: string,
  ) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    this.logins = new HarnessLogins((l) => void this.finished(l));
  }

  start(loginId: string, provider: ModelProvider, harness: string, binary?: string): ModelLogin {
    for (const id of [...this.live.keys()]) if (id === loginId) this.cancel(id);
    const cmd = modelLoginCommand(provider, harness, binary);
    fs.mkdirSync(this.scratchRoot, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(this.scratchRoot, "login-"));
    const entry = { inner: "", provider, harness, dir, raw: "", wantsInput: cmd.wantsInput };
    this.live.set(loginId, entry);
    const state = this.logins.start(harness, `model-${loginId}`, { command: cmd.command, args: cmd.args, env: { [cmd.home]: dir } }, 15 * 60_000, {
      // Claude prints the token it made; it goes to the hub, never into what people see
      redact: /sk-ant-oat\d*-[A-Za-z0-9_-]+/,
      redactStart: "sk-ant-oat",
      onRaw: (t) => (entry.raw = (entry.raw + t).slice(-64_000)),
      onChange: (l) => this.send({ type: "model_login", login: this.view(loginId, l) }),
    });
    entry.inner = state.id;
    return this.view(loginId, state);
  }

  input(loginId: string, text: string): ModelLogin {
    const e = this.entry(loginId);
    return this.view(loginId, this.logins.input(e.inner, text));
  }

  cancel(loginId: string) {
    const e = this.live.get(loginId);
    if (e) this.logins.cancel(e.inner);
  }

  /** The device is stopping: every sign-in ends, and no scratch folder is left behind. */
  stopAll() {
    const dirs = [...this.live.values()].map((e) => e.dir);
    this.logins.stopAll();
    this.live.clear();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }

  /** Scratch folders of sign-ins still running (for tests). */
  get scratch(): string[] {
    return [...this.live.values()].map((e) => e.dir);
  }

  private entry(loginId: string) {
    const e = this.live.get(loginId);
    if (!e) throw new Error("that sign-in isn't running anymore; start it again");
    return e;
  }

  private view(loginId: string, l: HarnessLogin): ModelLogin {
    const e = this.live.get(loginId);
    return { id: loginId, provider: e?.provider ?? "anthropic", harness: l.harness, status: l.status, ...(l.url ? { url: l.url } : {}), ...(l.code ? { code: l.code } : {}), ...(e?.wantsInput ? { wantsInput: true } : {}), output: l.output, ...(l.error ? { error: l.error } : {}) };
  }

  private async finished(l: HarnessLogin) {
    const found = [...this.live.entries()].find(([, e]) => e.inner === l.id);
    if (!found) return;
    const [loginId, e] = found;
    this.live.delete(loginId);
    try {
      if (l.status !== "done") return this.send({ type: "model_login_done", loginId, ok: false, error: l.error ?? "the sign-in didn't finish" });
      const got = readSecret(e.provider, e.dir, e.raw);
      if (!got) return this.send({ type: "model_login_done", loginId, ok: false, error: "the sign-in finished, but what it saved wasn't where Wisp looked; try again" });
      this.send({ type: "model_login_done", loginId, ok: true, ...got });
    } finally {
      fs.rmSync(e.dir, { recursive: true, force: true });
    }
  }
}

/** What a finished sign-in saved: Claude's printed token, Codex's auth.json, or Hermes's pool entry. Exported for tests. */
export function readSecret(provider: ModelProvider, dir: string, raw: string): { secret: ConnectionSecret; account?: string | null; plan?: string | null } | null {
  const json = (file: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      return null;
    }
  };
  if (provider === "anthropic") {
    const token = setupTokenFrom(raw);
    return token ? { secret: { token } } : null;
  }
  if (provider === "openai") {
    const auth = json("auth.json");
    if (!auth?.tokens?.refresh_token) return null;
    return { secret: { auth }, ...chatgptAccount(auth) };
  }
  if (provider === "xai") {
    const entry = json("auth.json")?.credential_pool?.["xai-oauth"]?.[0];
    if (!entry?.refresh_token) return null;
    return { secret: { pool: { access_token: entry.access_token, refresh_token: entry.refresh_token, base_url: entry.base_url, last_refresh: entry.last_refresh } }, account: typeof entry.label === "string" ? entry.label : null };
  }
  return null;
}
