import { describe, expect, it } from "vitest";
import path from "node:path";
import { REPO_ROOT } from "@wisp/update";
import { isService, spec, systemdUnit } from "../src/service.ts";

describe("warren service", () => {
  it("runs a device with this terminal's PATH, from the Warren folder", () => {
    const s = spec("node", "/home/sam/.warren");
    expect(s.args).toEqual([process.execPath, path.join(REPO_ROOT, "bin", "warren.mjs"), "node", "start"]);
    expect(s.env.PATH).toBe(process.env.PATH);
    expect(s.log).toBe("/home/sam/.warren/node.log");
  });

  it("writes a user systemd unit that logs to a file, and a system one that runs as a person", () => {
    const s = spec("hub", "/home/sam/.warren");
    const user = systemdUnit(s, false);
    expect(user).toContain(`ExecStart=${process.execPath} ${path.join(REPO_ROOT, "bin", "warren-hub.mjs")}`);
    expect(user).toContain("StandardOutput=append:/home/sam/.warren/hub.log");
    expect(user).toContain("WantedBy=default.target");
    expect(user).not.toContain("User=");
    const system = systemdUnit(s, true);
    expect(system).toMatch(/^User=\S+$/m);
    expect(system).toContain("WantedBy=multi-user.target");
    expect(system).not.toContain("StandardOutput=");
  });

  it("quotes values with spaces", () => {
    const s = { ...spec("node", "/tmp/w"), env: { PATH: "/a b:/c" } };
    expect(systemdUnit(s, false)).toContain('Environment="PATH=/a b:/c"');
  });
});

describe("one daemon per device", () => {
  it("marks the service's own daemon, so `warren node start` by hand can tell it's already running", () => {
    expect(spec("node", "/home/sam/.warren").env.WARREN_SERVICE).toBe("1");
  });

  it("knows it's the service even when an older install doesn't say so", () => {
    const saved = process.env.WARREN_SERVICE;
    delete process.env.WARREN_SERVICE;
    try {
      expect(isService({ name: "ai.warren.node", pid: process.pid })).toBe(true);
      // the keeper is the service's process; the daemon is its child
      expect(isService({ name: "ai.warren.node", pid: process.ppid })).toBe(true);
      expect(isService({ name: "ai.warren.node", pid: 999_999_999 })).toBe(false);
      expect(isService({ name: "ai.warren.node" })).toBe(process.platform === "darwin" && process.env.XPC_SERVICE_NAME === "ai.warren.node");
    } finally {
      if (saved !== undefined) process.env.WARREN_SERVICE = saved;
    }
  });
});
