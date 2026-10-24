import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accessChecker, atLeast, type Decision, type Viewer } from "@warren/core";
import { VaultError, isHiddenPath } from "@warren/vault";
import type { Hub } from "./hub.ts";

/**
 * The memory vault over git's smart HTTP protocol, so Obsidian's Git plugin on another computer
 * can clone, pull and push it.
 *
 * What makes this safe:
 *  - Every request needs a per-person token (Settings → Memory), sent as the password.
 *  - A clone or pull contains the whole history, and git can't hide single folders, so only
 *    people who may read every note that has ever been in memory can use it (owners always can).
 *  - Reading goes through a separate bare repository that borrows the vault's objects, so the
 *    git server never touches the vault's own folder.
 *  - A push is received into a throwaway repository first. Only after every changed file has been
 *    checked against the person's access rules (can they edit it?) are the commits fast-forwarded
 *    into the vault, under the vault's lock. Anything else is refused with a reason.
 */

const run = promisify(execFile);
const ZERO = "0".repeat(40);
const NO_CONFIG = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, args: string[]) => run("git", args, { cwd, env: { ...process.env, ...NO_CONFIG }, maxBuffer: 256 * 1024 * 1024 });

export const GIT_PATH = "/git/vault.git";

// --- who may sync -----------------------------------------------------------------------------------

/**
 * Why this person can't sync memory with Obsidian, or null when they can. Cloning hands over the
 * entire history, so they must be allowed to read every note that ever existed.
 */
export async function syncProblem(hub: Hub, workspaceId: string, viewer: Viewer): Promise<string | null> {
  if (viewer.role === "guest") return "Guests can read memory in Warren but can't sync it with Obsidian.";
  if (viewer.role === "owner") return null;
  const check = hub.access.checker(workspaceId, viewer);
  const hidden = (await hub.vault(workspaceId).pathsEver()).find((p) => !atLeast(check(p).level, "read"));
  return hidden ? "Syncing hands over all of memory, including notes only some people can see. Ask an owner to sync, or to change who can read those notes." : null;
}

// --- reading a push -----------------------------------------------------------------------------------

interface PushCommand {
  from: string;
  to: string;
  ref: string;
}

const readPackets = (body: Buffer): { commands: PushCommand[]; caps: string[] } => {
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  for (let i = 0; i + 4 <= body.length; ) {
    const len = parseInt(body.subarray(i, i + 4).toString("latin1"), 16);
    if (!Number.isFinite(len) || len === 0) break; // flush: the commands end here
    if (len < 4 || i + len > body.length) break;
    const [line, extra] = body.subarray(i + 4, i + len).toString("utf8").replace(/\n$/, "").split("\0");
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ from: m[1], to: m[2], ref: m[3] });
    if (extra) caps = extra.split(" ");
    i += len;
  }
  return { commands, caps };
};

const packet = (data: string | Buffer) => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
};

/** git's reply to a push that was refused: "ng" for each branch, plus the reason where git shows server messages. */
export function pushRefusal(caps: string[], refs: string[], reason: string): Buffer {
  const text = reason.replace(/\s+/g, " ").slice(0, 400);
  const status = Buffer.concat([packet("unpack ok\n"), ...refs.map((r) => packet(`ng ${r} ${text}\n`)), Buffer.from("0000")]);
  if (caps.includes("side-band-64k") || caps.includes("side-band")) return Buffer.concat([packet(Buffer.concat([Buffer.from([2]), Buffer.from(`Warren: ${text}\n`)])), packet(Buffer.concat([Buffer.from([1]), status])), Buffer.from("0000")]);
  return caps.includes("report-status") || caps.includes("report-status-v2") ? status : Buffer.alloc(0);
}

/**
 * Check every file the pushed commits changed against what this person may do. Hidden files and
 * folders (like .obsidian), links and submodules never come in from outside.
 */
export async function pushProblem(repo: string, from: string, to: string, check: (path: string) => Decision): Promise<string | null> {
  const { stdout } = await git(repo, ["log", "--raw", "--no-abbrev", "--no-renames", "--root", "-m", "-z", "--format=", `${from}..${to}`]);
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i].match(/^:(\d+) (\d+) \S+ \S+ (\S+)$/);
    if (!meta) continue;
    const file = tokens[++i];
    if (!file) continue;
    if (isHiddenPath(file)) return `${file} is a hidden file or folder (like .obsidian); those stay on your own computer.`;
    if (meta[2] === "120000" || meta[2] === "160000") return `${file} is a link or a nested repository; memory only takes plain files.`;
    if (!atLeast(check(file).level, "edit")) return `you can't edit ${file}`;
  }
  return null;
}

// --- talking to git -----------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Readable;
}

/** Hand a request to `git http-backend` (git's own server side of the protocol) and read its answer. */
function backend(root: string, req: { method: string; pathInfo: string; query: string; type?: string; encoding?: string; protocol?: string; config?: Record<string, string>; user: string; ip: string; body?: Buffer }): Promise<Reply & { kill(): void }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...NO_CONFIG,
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    PATH_INFO: req.pathInfo,
    QUERY_STRING: req.query,
    REMOTE_USER: req.user,
    REMOTE_ADDR: req.ip,
    CONTENT_LENGTH: String(req.body?.length ?? 0),
  };
  const extra = Object.entries(req.config ?? {});
  if (extra.length) {
    env.GIT_CONFIG_COUNT = String(extra.length);
    extra.forEach(([k, v], i) => ((env[`GIT_CONFIG_KEY_${i}`] = k), (env[`GIT_CONFIG_VALUE_${i}`] = v)));
  }
  if (req.type) env.CONTENT_TYPE = req.type;
  if (req.encoding) env.HTTP_CONTENT_ENCODING = req.encoding;
  if (req.protocol) env.HTTP_GIT_PROTOCOL = req.protocol;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on("close", () => clearTimeout(timer));
    child.stdin.on("error", () => undefined);
    child.stdin.end(req.body);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const head: Buffer[] = [];
    let answered = false;
    const onData = (chunk: Buffer) => {
      head.push(chunk);
      const all = Buffer.concat(head);
      const end = all.indexOf("\r\n\r\n");
      if (end < 0) return;
      answered = true;
      child.stdout.off("data", onData);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of all.subarray(0, end).toString("latin1").split("\r\n")) {
        const [k, ...v] = line.split(":");
        if (k.toLowerCase() === "status") status = parseInt(v.join(":").trim(), 10) || 200;
        else if (k) headers[k.toLowerCase()] = v.join(":").trim();
      }
      const body = new PassThrough();
      body.write(all.subarray(end + 4));
      child.stdout.pipe(body);
      resolve({ status, headers, body, kill: () => child.kill() });
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    child.on("close", () => {
      if (!answered) reject(new Error(`git http-backend failed: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** A new sync token. Only its hash is kept; the text is shown once. */
export function newSyncToken(): { token: string; hash: string } {
  const token = `wr_sync_${crypto.randomBytes(24).toString("base64url")}`;
  return { token, hash: sha(token) };
}

// --- routes -----------------------------------------------------------------------------------

export function registerVaultGit(app: FastifyInstance, hub: Hub, opts: { dataDir: string }) {
  const { store } = hub;
  /** each organization's vault is served from its own read-only copy; the first keeps the original folder */
  const gatewayOf = (workspaceId: string) => (hub.vaults.isPrimary(workspaceId) ? path.join(opts.dataDir, "vault-gateway") : path.join(hub.vaults.orgDir(workspaceId), "vault-gateway"));
  const gatewayBranches = new Map<string, string>();

  /** The read-only copy git serves: a bare repository that borrows the vault's objects and points at its branch. */
  async function refreshGateway(workspaceId: string): Promise<boolean> {
    const vault = hub.vault(workspaceId);
    const gateway = gatewayOf(workspaceId);
    const [head, branch] = await Promise.all([vault.head(), vault.branch()]);
    if (!head || !branch) return false;
    const repo = path.join(gateway, "vault.git");
    if (!fs.existsSync(path.join(repo, "HEAD"))) {
      fs.mkdirSync(gateway, { recursive: true });
      await git(gateway, ["init", "-q", "--bare", repo]);
      for (const [k, v] of [
        ["http.receivepack", "false"],
        ["uploadpack.allowReachableSHA1InWant", "true"],
        ["gc.auto", "0"],
        ["core.alternateRefsCommand", "true"], // don't list the vault's own refs
      ]) await git(repo, ["config", k, v]);
    }
    const alternates = path.join(repo, "objects", "info", "alternates");
    const want = (await vault.objectsDir()) + "\n";
    if (!fs.existsSync(alternates) || fs.readFileSync(alternates, "utf8") !== want) {
      fs.mkdirSync(path.dirname(alternates), { recursive: true });
      fs.writeFileSync(alternates, want);
    }
    if (gatewayBranches.get(gateway) !== branch) {
      const refs = (await git(repo, ["for-each-ref", "--format=%(refname)"])).stdout.split("\n").filter(Boolean);
      for (const r of refs) if (r !== `refs/heads/${branch}`) await git(repo, ["update-ref", "-d", r]);
      await git(repo, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      gatewayBranches.set(gateway, branch);
    }
    await git(repo, ["update-ref", `refs/heads/${branch}`, head]);
    return true;
  }

  /** The person behind a request's token (git sends it as the password; the user name is ignored). */
  function who(req: FastifyRequest) {
    const h = req.headers.authorization ?? "";
    let token: string | undefined;
    const basic = h.match(/^Basic\s+(\S+)$/i);
    if (basic) {
      const text = Buffer.from(basic[1], "base64").toString("utf8");
      token = text.slice(text.indexOf(":") + 1);
    } else token = h.match(/^Bearer\s+(\S+)$/i)?.[1];
    const row = token ? store.useVaultToken(sha(token)) : undefined;
    const role = row && store.role(row.workspaceId, row.userId);
    const user = row && role ? store.user(row.userId) : undefined;
    return row && role && user ? { userId: row.userId, workspaceId: row.workspaceId, name: user.name, viewer: { actor: { kind: "user" as const, id: row.userId }, role } satisfies Viewer } : null;
  }

  const denied = (reply: FastifyReply, code: number, text: string) => reply.code(code).type("text/plain; charset=utf-8").header("cache-control", "no-store").send(text + "\n");

  async function gate(req: FastifyRequest, reply: FastifyReply, readOnlyCopy = true) {
    const person = who(req);
    if (!person) {
      reply.header("www-authenticate", 'Basic realm="Warren memory"');
      denied(reply, 401, "Sign in with a sync token from Warren: Settings, Memory.");
      return null;
    }
    const problem = await syncProblem(hub, person.workspaceId, person.viewer);
    if (problem) {
      denied(reply, 403, problem);
      return null;
    }
    if (readOnlyCopy && !(await refreshGateway(person.workspaceId))) {
      denied(reply, 503, "Memory has no saved notes yet, or isn't on a branch. Open Warren and add a note first.");
      return null;
    }
    return person;
  }

  const raw = { parseAs: "buffer" as const, bodyLimit: 100 * 1024 * 1024 };
  app.addContentTypeParser(/^application\/x-git-.*-request$/, raw, (_req, body, done) => done(null, body));

  const send = async (reply: FastifyReply, req: FastifyRequest, r: Reply & { kill(): void }) => {
    req.raw.on("close", () => r.kill());
    return reply.code(r.status).headers(r.headers).send(r.body);
  };

  app.get(`${GIT_PATH}/info/refs`, async (req, reply) => {
    const service = (req.query as { service?: string }).service;
    // only git's smart protocol; the old "dumb" one would hand out raw files
    if (service !== "git-upload-pack" && service !== "git-receive-pack") return denied(reply, 403, "Use git 1.6.6 or newer.");
    const person = await gate(req, reply);
    if (!person) return;
    // Pushing is switched off in the read-only copy, so its list of refs is only allowed to be
    // shown for a push; the push itself always goes to a scratch repository (below).
    return send(
      reply,
      req,
      await backend(gatewayOf(person.workspaceId), {
        method: "GET",
        pathInfo: "/vault.git/info/refs",
        query: `service=${service}`,
        protocol: req.headers["git-protocol"] as string | undefined,
        config: service === "git-receive-pack" ? { "http.receivepack": "true" } : undefined,
        user: person.name,
        ip: req.ip,
      }),
    );
  });

  app.post(`${GIT_PATH}/git-upload-pack`, async (req, reply) => {
    const person = await gate(req, reply);
    if (!person) return;
    return send(
      reply,
      req,
      await backend(gatewayOf(person.workspaceId), {
        method: "POST",
        pathInfo: "/vault.git/git-upload-pack",
        query: "",
        type: req.headers["content-type"],
        encoding: req.headers["content-encoding"] as string | undefined,
        protocol: req.headers["git-protocol"] as string | undefined,
        user: person.name,
        ip: req.ip,
        body: req.body as Buffer,
      }),
    );
  });

  app.post(`${GIT_PATH}/git-receive-pack`, async (req, reply) => {
    const person = await gate(req, reply, false);
    if (!person) return;
    let body = req.body as Buffer;
    if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
    const { commands, caps } = readPackets(body);
    const vault = hub.vault(person.workspaceId);
    const branch = await vault.branch();
    const refuse = (reason: string) => reply.code(200).type("application/x-git-receive-pack-result").header("cache-control", "no-cache").send(pushRefusal(caps, commands.map((c) => c.ref), reason));
    if (!commands.length) return denied(reply, 400, "Nothing to receive.");
    const wrong = commands.find((c) => c.ref !== `refs/heads/${branch}` || c.to === ZERO);
    if (wrong) return refuse(`only the ${branch} branch can be pushed to, and it can't be deleted`);

    try {
      return await vault.exclusive(async (tx) => {
        // outside edits on the hub's machine become commits first, so the push is judged against what's really there
        await tx.sync();
        const head = await tx.head();
        if (!head) return refuse("memory has no saved notes yet");
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "warren-push-"));
        try {
          const repo = path.join(scratch, "vault.git");
          await git(scratch, ["init", "-q", "--bare", repo]);
          fs.mkdirSync(path.join(repo, "objects", "info"), { recursive: true });
          fs.writeFileSync(path.join(repo, "objects", "info", "alternates"), (await vault.objectsDir()) + "\n");
          await git(repo, ["update-ref", `refs/heads/${branch}`, head]);

          const answer = await backend(scratch, {
            method: "POST",
            pathInfo: "/vault.git/git-receive-pack",
            query: "",
            type: req.headers["content-type"],
            encoding: req.headers["content-encoding"] as string | undefined,
            // git refuses what isn't a plain fast-forward, deletes, and objects that don't check out
            config: { "http.receivepack": "true", "receive.denyNonFastForwards": "true", "receive.denyDeletes": "true", "receive.fsckObjects": "true", "gc.auto": "0" },
            user: person.name,
            ip: req.ip,
            body: req.body as Buffer,
          });
          const out = await collect(answer.body);
          const to = (await git(repo, ["rev-parse", `refs/heads/${branch}`])).stdout.trim();
          const send200 = () => reply.code(answer.status).headers(answer.headers).send(out);
          if (to === head) return send200(); // git itself said no (not up to date, a bad object, ...)

          const rules = hub.access.rules(person.workspaceId);
          const problem = await pushProblem(repo, head, to, accessChecker(person.viewer, rules));
          if (problem) return refuse(problem);
          try {
            await tx.adopt(repo, branch!, head, to, person.name);
          } catch (e) {
            return refuse(e instanceof VaultError ? e.message : "Warren couldn't take that in; try again");
          }
          hub.broadcast(person.workspaceId, { type: "memory_changed" });
          return send200();
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      });
    } catch (e) {
      app.log.error(e);
      return denied(reply, 500, "Warren couldn't take that push.");
    }
  });
}
