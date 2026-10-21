import { createRequire } from "node:module";
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

describe("join links from the web app's device step", () => {
  it("reads the hub, connection code and device name", () => {
    expect(engine.parseJoinLink("warren://join?hub=http%3A%2F%2F192.168.1.20%3A4747&code=wr_node_abc-DEF_123&name=my-mac")).toEqual({ hub: "http://192.168.1.20:4747", code: "wr_node_abc-DEF_123", name: "my-mac" });
    expect(engine.parseJoinLink("  WARREN://join?hub=https://warren.example.com&code=wr_node_x  ")).toEqual({ hub: "https://warren.example.com", code: "wr_node_x", name: "" });
  });

  it("is not fooled by a plain address, another action, or a code that isn't a device code", () => {
    expect(engine.parseJoinLink("192.168.1.20:4747")).toBeNull();
    expect(engine.parseJoinLink("warren://open?hub=http://h")).toBeNull();
    expect(engine.parseJoinLink("warren://join?hub=http://h&code=wr_session_abc")).toBeNull();
    expect(engine.parseJoinLink("warren://join?hub=ftp://h&code=wr_node_abc")).toBeNull();
    expect(engine.parseJoinLink("")).toBeNull();
  });
});
