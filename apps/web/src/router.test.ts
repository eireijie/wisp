import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { changed } = vi.hoisted(() => ({ changed: vi.fn() }));
vi.mock("react", () => ({
  useMemo: (fn: () => unknown) => fn(),
  useSyncExternalStore: (subscribe: (fn: () => void) => void, snapshot: () => unknown) => {
    subscribe(changed);
    return snapshot();
  },
}));

let router: typeof import("./router.ts");
beforeEach(async () => {
  vi.resetModules();
  changed.mockClear();
  const url = new URL("https://wisp.test/?keep=1#/vault/note.md");
  vi.stubGlobal("location", url);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("history", {
    state: { keep: true },
    replaceState: vi.fn((_state, _title, next) => { url.href = new URL(next, url).href; }),
  });
  vi.stubGlobal("confirm", vi.fn(() => false));
  router = await import("./router.ts");
  router.useRoute();
});
afterEach(() => vi.unstubAllGlobals());

describe("hash routing", () => {
  it.each([null, "thread"])("round trips a selected message in a channel or thread (%s)", (threadId) => {
    const route = { view: "chat" as const, channelId: "channel", threadId, messageId: "message /1" };
    expect(router.href(route)).toBe(`#/c/channel${threadId ? "/t/thread" : ""}/m/message%20%2F1`);
    expect(router.parseRoute(router.href(route))).toEqual(route);
  });

  it("recovers from malformed percent encodings and still decodes valid paths", () => {
    for (const hash of ["#/vault/%", "#/c/%E0%A4%A", "#/agents/%FF"])
      expect(router.parseRoute(hash)).toEqual({ view: "chat", channelId: null, threadId: null });
    expect(router.parseRoute("#/vault/shared/a%20note.md")).toEqual({ view: "vault", path: "shared/a note.md" });
  });

  it.each(["hashchange", "popstate"])("restores a refused %s without notifying views", (event) => {
    router.guardLeaving(() => "Discard changes?");
    location.hash = "#/settings";
    window.dispatchEvent(new Event(event));
    // Back/Forward can emit both events for the same transition.
    window.dispatchEvent(new Event(event === "popstate" ? "hashchange" : "popstate"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/vault/note.md");
    expect(location.search).toBe("?keep=1");
    expect(history.replaceState).toHaveBeenCalledWith({ keep: true }, "", "/?keep=1#/vault/note.md");
    expect(changed).not.toHaveBeenCalled();
    expect(router.appHashBeforeSettings()).toBe("#/vault/note.md");
    expect(router.useRoute()).toEqual({ view: "vault", path: "note.md" });
  });

  it.each(["go", "hashchange", "popstate"])("asks once for accepted navigation via %s", (event) => {
    router.guardLeaving(() => "Discard changes?");
    vi.mocked(confirm).mockReturnValue(true);
    if (event === "go") router.go({ view: "settings" });
    else {
      location.hash = "#/settings";
      window.dispatchEvent(new Event(event));
    }
    window.dispatchEvent(new Event("popstate"));
    window.dispatchEvent(new Event("hashchange"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(router.useRoute()).toEqual({ view: "settings", page: null });
    expect(router.appHashBeforeSettings()).toBe("#/vault/note.md");
  });

  it("keeps go guarded and supports unregistering a guard", () => {
    const remove = router.guardLeaving(() => "Discard changes?");
    router.go({ view: "dashboard" });
    expect(location.hash).toBe("#/vault/note.md");
    expect(changed).not.toHaveBeenCalled();
    remove();
    router.go({ view: "dashboard" });
    expect(location.hash).toBe("#/dashboard");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("guest routes", () => {
  it.each(["#/computers", "#/computers/desk", "#/computers/desk/teach/atlas"])("falls back from %s for guests", (hash) => {
    expect(router.routeForRole(router.parseRoute(hash), "guest")).toEqual({ view: "dashboard" });
  });

  it.each(["member", "owner"] as const)("keeps computer routes for a %s", (role) => {
    const route = router.parseRoute("#/computers/desk/teach/atlas");
    expect(router.routeForRole(route, role)).toEqual(route);
  });

  it("keeps guests' other pages available", () => {
    const route = router.parseRoute("#/agents/atlas");
    expect(router.routeForRole(route, "guest")).toEqual(route);
  });
});

describe("device pages", () => {
  it("opens one device inside Computers, and the old Devices addresses land there", () => {
    expect(router.parseRoute("#/computers/d/box")).toEqual({ view: "computers", computerId: null, deviceId: "box" });
    expect(router.href({ view: "computers", computerId: null, deviceId: "box" })).toBe("#/computers/d/box");
    expect(router.parseRoute("#/nodes/box")).toEqual({ view: "computers", computerId: null, deviceId: "box" });
    expect(router.parseRoute("#/nodes")).toEqual({ view: "computers", computerId: null });
  });

  it("sends the old Marketplace Agents address to All", () => {
    expect(router.parseRoute("#/marketplace/agents")).toEqual({ view: "marketplace", section: null });
    expect(router.parseRoute("#/marketplace/mods")).toEqual({ view: "marketplace", section: "mods" });
  });
});
