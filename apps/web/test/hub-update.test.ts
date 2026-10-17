import { describe, expect, it, vi } from "vitest";

vi.mock("../src/store.ts", () => ({ useStore: () => false }));
import { entryScript, hubWasUpdated } from "../src/hubUpdate.ts";

const page = (script: string) => `<!doctype html><html><head><script type="module" crossorigin src="${script}"></script><link rel="stylesheet" href="/assets/index-abc.css"></head><body></body></html>`;

describe("noticing a hub update", () => {
  it("reads the entry script from the hub's index.html", () => {
    expect(entryScript(page("/assets/index-ZKSI-DFt.js"))).toBe("/assets/index-ZKSI-DFt.js");
    expect(entryScript("<html>no scripts</html>")).toBeNull();
  });

  it("says so only when the hub serves a different build", async () => {
    expect(await hubWasUpdated("/assets/index-old.js", async () => page("/assets/index-new.js"))).toBe(true);
    expect(await hubWasUpdated("/assets/index-same.js", async () => page("/assets/index-same.js"))).toBe(false);
  });

  it("keeps quiet when it can't tell: offline, an odd page, or a dev server", async () => {
    expect(await hubWasUpdated("/assets/index-old.js", async () => Promise.reject(new Error("offline")))).toBe(false);
    expect(await hubWasUpdated("/assets/index-old.js", async () => "<html>Bad gateway</html>")).toBe(false);
    expect(await hubWasUpdated(null, async () => page("/assets/index-new.js"))).toBe(false);
  });
});
