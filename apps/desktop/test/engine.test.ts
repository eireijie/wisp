import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const engine = createRequire(import.meta.url)("../src/engine.cjs");

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("server addresses", () => {
  it("tries plain HTTP first on a home network, and Warren's port when none is given", () => {
    expect(engine.candidates("192.168.1.20")).toEqual(["http://192.168.1.20", "https://192.168.1.20", "http://192.168.1.20:4747"]);
    expect(engine.candidates("homeserver:4747/")).toEqual(["http://homeserver:4747", "https://homeserver:4747"]);
  });

  it("tries HTTPS first for a domain, and only what was typed when a scheme is given", () => {
    expect(engine.candidates("warren.example.com")).toEqual(["https://warren.example.com", "http://warren.example.com", "http://warren.example.com:4747"]);
    expect(engine.candidates("http://warren.example.com/#/login")).toEqual(["http://warren.example.com"]);
    expect(engine.candidates("  ")).toEqual([]);
  });
});

describe("testing a server before joining", () => {
  it("joins the first address where a Warren answers", async () => {
    const tried: string[] = [];
    const r = await engine.testHub("192.168.1.20", {
      fetchImpl: async (url: URL) => {
        tried.push(url.origin);
        if (url.port !== "4747") throw refused();
        return json({ needsSetup: false });
      },
    });
    expect(tried).toEqual(["http://192.168.1.20", "https://192.168.1.20", "http://192.168.1.20:4747"]);
    expect(r).toMatchObject({ ok: true, url: "http://192.168.1.20:4747", needsSetup: false });
    expect(r.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it("says when something answers that isn't Warren", async () => {
    const r = await engine.testHub("https://example.com", { fetchImpl: async () => json("<html>", 404) });
    expect(r).toMatchObject({ ok: false, url: "https://example.com" });
    expect(r.error).toMatch(/isn't a Warren server/);
  });

  it("says why nothing answered", async () => {
    const r = await engine.testHub("https://warren.example.com", {
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Couldn't find warren\.example\.com/);
  });

  it("tells a new server's first person they'll make the first account", async () => {
    const r = await engine.testHub("https://new.example.com", { fetchImpl: async () => json({ needsSetup: true }) });
    expect(r.needsSetup).toBe(true);
    expect(r.checks.at(-1).label).toMatch(/first account/);
  });
});

describe("the processes the app runs", () => {
  /** A pretend Warren whose `warren.mjs` stays up until it's told to stop. */
  const fakeWarren = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warren-child-"));
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "warren.mjs"), "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000);\n");
    return dir;
  };
  const until = async (ok: () => boolean, ms = 5000) => {
    for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("timed out");
  };

  it("says it couldn't start when there's no Node to run, instead of crashing the app", async () => {
    const dir = fakeWarren();
    const child = new engine.Child("test", dir, () => {});
    child.start(path.join(dir, "no-such-node"), dir, ["hub", "start"]);
    await until(() => child.state === "error");
    expect(child.running()).toBe(false);
    expect(child.detail).toMatch(/couldn't start/);
  });

  it("starts again once a stopped one has exited, when asked before it did", async () => {
    const dir = fakeWarren();
    const child = new engine.Child("test", dir, () => {});
    child.start(process.execPath, dir, ["node", "start"]);
    await until(() => child.running());
    const first = child.proc;
    child.stop();
    child.start(process.execPath, dir, ["node", "start"]); // the old one takes 300ms to exit
    expect(child.proc).toBe(first);
    await until(() => child.running() && child.proc !== first);
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
    expect(child.state).toBe("starting");
    child.stop();
    await until(() => !child.running());
    expect(child.state).toBe("stopped");
  });
});


describe("hub identification", () => {
  it("keeps probing after a different server answers and saves the redirected origin", async () => {
    const tried: string[] = [];
    const r = await engine.testHub("home", { fetchImpl: async (url: URL) => {
      tried.push(url.origin);
      if (url.port === "4747") return { ...json({ needsSetup: false }), url: "https://warren.example.com/api/setup" };
      return json({ unrelated: true });
    } });
    expect(tried).toEqual(["http://home", "https://home", "http://home:4747"]);
    expect(r).toMatchObject({ ok: true, url: "https://warren.example.com" });
  });

  it("reports the non-Warren response when the remaining candidates are unreachable", async () => {
    const r = await engine.testHub("home", { fetchImpl: async (url: URL) => {
      if (url.protocol === "https:") return json({ unrelated: true });
      throw refused();
    } });
    expect(r).toMatchObject({ ok: false, url: "https://home" });
    expect(r.error).toMatch(/isn't a Warren server/);
  });

  it("requires a boolean needsSetup on startup, including hubs that are already set up", async () => {
    for (const body of [null, {}, { needsSetup: "false" }, "<html>"]) {
      expect(await engine.hubUp("http://hub", { fetchImpl: async () => json(body) })).toBe(false);
    }
    for (const needsSetup of [true, false]) {
      expect(await engine.hubUp("http://hub", { fetchImpl: async () => json({ needsSetup }) })).toBe(true);
    }
    expect(await engine.hubUp("http://hub", { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }) })).toBe(false);
  });
});

describe("installed services", () => {
  function fixture(platform: string, uid = 501, out = "", failed = false, dir?: string) {
    const execFile = vi.fn((_cmd, _args, _opts, done) => done(failed ? new Error("failed") : null, out));
    const filename = fileURLToPath(new URL("../src/engine.cjs", import.meta.url));
    const require = createRequire(filename);
    const module = { exports: {} as typeof engine };
    runInNewContext(readFileSync(filename, "utf8"), { module, __dirname: path.dirname(filename), URL, AbortSignal,
      process: { ...process, platform, getuid: () => uid, env: { WARREN_NODE_DIR: dir } },
      require: (name: string) => name === "node:child_process" ? { execFile } : require(name),
    });
    return { engine: module.exports, execFile };
  }

  it("uses the CLI's user and system systemd units", async () => {
    const user = fixture("linux");
    expect(await user.engine.serviceRunning("node")).toBe(true);
    expect(user.execFile.mock.calls[0].slice(0, 2)).toEqual(["systemctl", ["--user", "is-active", "--quiet", "warren-node"]]);
    expect(await user.engine.restartService("node")).toBe(true);
    expect(user.execFile.mock.calls[1][1]).toEqual(["--user", "restart", "warren-node"]);
    const root = fixture("linux", 0);
    await root.engine.serviceRunning("hub");
    expect(root.execFile.mock.calls[0][1]).toEqual(["is-active", "--quiet", "warren"]);
    expect(await fixture("linux", 501, "", true).engine.serviceRunning("node")).toBe(false);
  });

  it("uses Scheduled Task state on Windows and propagates restart failure", async () => {
    const f = fixture("win32", 501, "Running\r\n");
    expect(await f.engine.serviceRunning("hub")).toBe(true);
    expect(f.execFile.mock.calls[0].slice(0, 2)).toEqual(["powershell.exe", ["-NoProfile", "-Command", "(Get-ScheduledTask -TaskName 'Warren hub').State"]]);
    expect(await fixture("win32", 501, "Ready").engine.serviceRunning("hub")).toBe(false);
    expect(await fixture("win32", 501, "", true).engine.restartService("node")).toBe(false);
    await f.engine.restartService("node");
    expect(f.execFile.mock.calls[1][1][2]).toContain("Stop-ScheduledTask -TaskName 'Warren node'; Start-ScheduledTask -TaskName 'Warren node'");
  });

  it("preserves macOS detection and ignores services for an isolated node directory", async () => {
    expect(await fixture("darwin", 501, "state = running").engine.serviceRunning("node")).toBe(true);
    const f = fixture("linux", 501, "", false, "/isolated");
    expect(await f.engine.serviceRunning("node")).toBe(false);
    expect(f.execFile).not.toHaveBeenCalled();
  });
});

describe("device connection state", () => {
  const cfg = { token: "node-token", name: "This computer", nodeId: "n" };
  const check = (online: boolean, authenticated = true) => engine.deviceConnected("http://hub", cfg, "session", { fetchImpl: async (url: URL, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.pathname === "/api/node/agents") {
      expect(init.headers).toEqual({ authorization: "Bearer node-token" });
      return json([], authenticated ? 200 : 401);
    }
    return json([{ id: "n", name: cfg.name, mine: true, online }]);
  } });

  it("requires both authentication and the hub's live online state", async () => {
    expect(await check(false)).toBe(false);
    expect(await check(true, false)).toBe(false);
    expect(await check(true)).toBe(true);
  });

  it("uses hosted agents to identify old configurations and rejects ambiguous names", async () => {
    const fetchImpl = async (url: URL) => url.pathname === "/api/node/agents" ? json([{ nodeId: "right" }]) : json([{ id: "wrong", online: true }, { id: "right", online: false }]);
    expect(await engine.deviceConnected("http://hub", cfg, "session", { fetchImpl })).toBe(false);
    const ambiguous = async (url: URL) => url.pathname === "/api/node/agents" ? json([]) : json([1, 2].map((id) => ({ id, name: cfg.name, mine: true, online: true })));
    expect(await engine.deviceConnected("http://hub", { ...cfg, nodeId: undefined }, "session", { fetchImpl: ambiguous })).toBe(false);
  });
});
