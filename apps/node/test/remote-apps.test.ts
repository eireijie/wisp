import { describe, expect, it } from "vitest";
import { appPaths } from "../src/remote-apps.ts";

describe("remote desktop apps on a device", () => {
  it("looks for each app where it installs on each system", () => {
    expect(appPaths("darwin").anydesk).toContain("/Applications/AnyDesk.app");
    expect(appPaths("win32", { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" }).teamviewer).toContain("C:\\Program Files\\TeamViewer");
    expect(appPaths("linux").chrome).toContain("/opt/google/chrome-remote-desktop");
  });
});
