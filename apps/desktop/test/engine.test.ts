import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
