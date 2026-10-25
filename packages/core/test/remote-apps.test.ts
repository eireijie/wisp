import { describe, expect, it } from "vitest";
import { OwnRemoteDesktop, remoteDesktopLink } from "../src/computers.ts";

describe("a device's own remote desktop app", () => {
  it("takes an ID, an address or an https link, by app", () => {
    expect(OwnRemoteDesktop.safeParse({ app: "anydesk", value: "123456789" }).success).toBe(true);
    expect(OwnRemoteDesktop.safeParse({ app: "rdp", value: "shop-pc.local:3389" }).success).toBe(true);
    expect(OwnRemoteDesktop.safeParse({ app: "chrome", value: "https://remotedesktop.google.com/access" }).success).toBe(true);
    const bad = OwnRemoteDesktop.safeParse({ app: "rdp", value: "javascript:alert(1)" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toMatch(/computer name or address/);
    expect(OwnRemoteDesktop.safeParse({ app: "other", value: "http://plain.example" }).success).toBe(false);
    expect(OwnRemoteDesktop.safeParse({ app: "teamviewer", value: "1 2" }).success).toBe(false);
  });

  it("opens each app with its own link, or none when it has no link", () => {
    expect(remoteDesktopLink({ app: "anydesk", value: "123456789" })).toBe("anydesk:123456789");
    expect(remoteDesktopLink({ app: "teamviewer", value: "123456789" })).toBe("teamviewer10://control?device=123456789");
    expect(remoteDesktopLink({ app: "teamviewer", value: "shop-alias" })).toBeNull();
    expect(remoteDesktopLink({ app: "rdp", value: "shop-pc.local" })).toBe("rdp://full%20address=s:shop-pc.local");
    expect(remoteDesktopLink({ app: "screen-sharing", value: "my-mac.local" })).toBe("vnc://my-mac.local");
    expect(remoteDesktopLink({ app: "chrome", value: "https://remotedesktop.google.com/access" })).toBe("https://remotedesktop.google.com/access");
  });
});
