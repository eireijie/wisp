import { describe, expect, it } from "vitest";
import { formatRustdeskId } from "@wisp/core";
import { installPlan, parseRustdeskId, rustdeskBinary } from "../src/rustdesk.ts";

describe("RustDesk", () => {
  it("installs with each system's own installer, and says what to do when there isn't one", () => {
    const none = { brew: false, winget: false, apt: false };
    expect(installPlan("darwin", "arm64", { ...none, brew: true })).toMatchObject({ kind: "run", cmd: "brew", args: ["install", "--cask", "rustdesk"] });
    expect(installPlan("win32", "x64", { ...none, winget: true })).toMatchObject({ kind: "run", cmd: "winget", args: ["install", "--id", "RustDesk.RustDesk", "--exact"] });
    expect(installPlan("linux", "x64", { ...none, apt: true })).toEqual({ kind: "deb", arch: "x86_64" });
    expect(installPlan("linux", "arm64", { ...none, apt: true })).toEqual({ kind: "deb", arch: "aarch64" });
    expect(installPlan("darwin", "arm64", none).kind).toBe("manual");
    expect(installPlan("win32", "x64", none).kind).toBe("manual");
    expect(installPlan("linux", "x64", none).kind).toBe("manual");
  });

  it("reads the ID RustDesk prints, and shows it in groups of three", () => {
    expect(parseRustdeskId("482117903\n")).toBe("482117903");
    expect(parseRustdeskId("\n")).toBeNull();
    expect(parseRustdeskId("Error: service not running")).toBeNull();
    expect(formatRustdeskId("482117903")).toBe("482 117 903");
    expect(formatRustdeskId("1482117903")).toBe("1 482 117 903");
    expect(formatRustdeskId("my-shop-pc")).toBe("my-shop-pc");
  });

  it("knows where RustDesk lives on each system", () => {
    expect(rustdeskBinary("darwin")).toBe("/Applications/RustDesk.app/Contents/MacOS/rustdesk");
    expect(rustdeskBinary("win32")).toMatch(/RustDesk[\\/]rustdesk\.exe$/);
    expect(rustdeskBinary("linux")).toBe("rustdesk");
  });
});
