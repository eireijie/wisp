import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const trust = createRequire(import.meta.url)("../src/trust.cjs");

describe("which pages the app trusts", () => {
  it("matches the hub by its exact origin, not by how the address starts", () => {
    const hub = "https://hub.example";
    expect(trust.onOrigin("https://hub.example/#/nodes", hub)).toBe(true);
    expect(trust.onOrigin("https://hub.example.evil.test/", hub)).toBe(false);
    expect(trust.onOrigin("https://hub.example@evil.test/", hub)).toBe(false);
    expect(trust.onOrigin("https://hub.example:8443/", hub)).toBe(false);
    expect(trust.onOrigin("http://hub.example/", hub)).toBe(false);
    expect(trust.onOrigin("not a url", hub)).toBe(false);
    expect(trust.onOrigin("https://hub.example/", null)).toBe(false);
  });

  it("trusts only the setup page itself among file: pages", () => {
    const file = "/Applications/Wisp.app/Contents/Resources/app.asar/src/setup.html";
    const page = pathToFileURL(file).href;
    expect(trust.isPage(`${page}?state=%7B%7D`, file)).toBe(true);
    expect(trust.isPage(`${page}#x`, file)).toBe(true);
    expect(trust.isPage(pathToFileURL("/tmp/setup.html").href, file)).toBe(false);
    expect(trust.isPage("file:///Users/someone/Downloads/evil.html", file)).toBe(false);
    expect(trust.isPage("https://hub.example/setup.html", file)).toBe(false);
  });

  it("takes IPC only from the main frame of the main window", () => {
    const mainFrame = { url: "https://hub.example/" };
    const webContents = { mainFrame };
    const win = { webContents, isDestroyed: () => false };
    expect(trust.mainFrameUrl({ sender: webContents, senderFrame: mainFrame }, win)).toBe("https://hub.example/");
    expect(trust.mainFrameUrl({ sender: webContents, senderFrame: { url: "https://hub.example/" } }, win)).toBeNull(); // an iframe
    expect(trust.mainFrameUrl({ sender: { mainFrame }, senderFrame: mainFrame }, win)).toBeNull(); // another window
    expect(trust.mainFrameUrl({ sender: webContents, senderFrame: null }, win)).toBeNull();
    expect(trust.mainFrameUrl({ sender: webContents, senderFrame: mainFrame }, null)).toBeNull();
  });
});
