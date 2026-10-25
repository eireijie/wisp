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

describe("remote desktop links", () => {
  it("opens the apps a device's page links to, and nothing that only looks like them", () => {
    for (const u of ["rustdesk://482117903", "anydesk:123456789", "anydesk:shop@ad", "teamviewer10://control?device=123456789", "rdp://full%20address=s:shop-pc.local", "vnc://192.168.1.20:5900"]) expect(trust.isRemoteDesktopLink(u)).toBe(true);
    for (const u of ["javascript:alert(1)", "vnc://x;rm -rf", "file:///etc/passwd", "rustdesk://a b", "teamviewer10://control?device=1&password=x", "rdp://full%20address=s:x&shell=y"]) expect(trust.isRemoteDesktopLink(u)).toBe(false);
  });
});

describe("obsidian links", () => {
  it("opens the vault or a note in Obsidian, and nothing that only looks like it", () => {
    for (const u of ["obsidian://open?path=%2FUsers%2Fme%2FWisp%20Vault", "obsidian://open?path=C%3A%2FUsers%2Fme%2Fvault%2Fnotes%2Fa%20b.md", `obsidian://open?path=${encodeURIComponent("/v/it's (1)/x.md")}`]) expect(trust.isObsidianLink(u)).toBe(true);
    for (const u of ["obsidian://open?path=/a&vault=x", "obsidian://new?vault=x&name=y", "obsidian://open?path=%2Fa#x", "obsidian://open?path=", "javascript:alert(1)", "https://obsidian.md/"]) expect(trust.isObsidianLink(u)).toBe(false);
  });
});
