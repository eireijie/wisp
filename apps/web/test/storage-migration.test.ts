import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../public/storage-migration.js", import.meta.url), "utf8");
function storage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return { values, get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("storage rename before startup", () => {
  it("preserves sessions, preferences and drafts in both stores without overwriting Wisp choices", () => {
    const localStorage = storage({ "warren.token": "session", "warren.mode": "dark", "warren.theme": "iris", "wisp.theme": "mint", unrelated: "keep", "warrenish.key": "keep too" });
    const sessionStorage = storage({ "warren.draft": "unsent message" });
    const window = { localStorage, sessionStorage };
    runInNewContext(script, { window });
    expect(Object.fromEntries(localStorage.values)).toEqual({ "wisp.token": "session", "wisp.mode": "dark", "wisp.theme": "mint", unrelated: "keep", "warrenish.key": "keep too" });
    expect(Object.fromEntries(sessionStorage.values)).toEqual({ "wisp.draft": "unsent message" });
    runInNewContext(script, { window });
    expect(localStorage.getItem("wisp.token")).toBe("session");
    expect(localStorage.values.size).toBe(5);
  });

  it("keeps the old key if its copy fails and tolerates blocked storage", () => {
    const localStorage = storage({ "warren.token": "session" });
    localStorage.setItem = () => { throw new Error("quota"); };
    runInNewContext(script, { window: { localStorage, get sessionStorage() { throw new Error("denied"); } } });
    expect(localStorage.getItem("warren.token")).toBe("session");
    expect(localStorage.getItem("wisp.token")).toBeNull();
  });

  it("loads the migration before the very first theme read", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html.indexOf('src="/storage-migration.js"')).toBeLessThan(html.indexOf('localStorage.getItem("wisp.mode")'));
  });
});

describe("service worker cache migration", () => {
  it("deletes old Warren and obsolete Wisp caches while retaining unrelated caches", async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const deleted: string[] = [];
    const code = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    runInNewContext(code, {
      self: { addEventListener: (name: string, fn: (event: unknown) => void) => handlers.set(name, fn), clients: { claim: () => {} } },
      caches: { keys: async () => ["warren-shell-v2", "warren-old", "wisp-shell-v1", "wisp-shell-v2", "wisp-shell-v3", "another-app"], delete: async (key: string) => { deleted.push(key); } },
    });
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get("activate")!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(deleted.sort()).toEqual(["warren-old", "warren-shell-v2", "wisp-shell-v1", "wisp-shell-v2"]);
  });
});
