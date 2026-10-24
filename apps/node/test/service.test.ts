import { describe, expect, it } from "vitest";
import path from "node:path";
import { REPO_ROOT } from "@wisp/update";
import { isService, spec, systemdUnit, servicePortFromDefinition } from "../src/service.ts";

describe("wisp service", () => {
  it("runs a device with this terminal's PATH, from the Wisp folder", () => {
    const s = spec("node", "/home/sam/.wisp");
    expect(s.args).toEqual([process.execPath, path.join(REPO_ROOT, "bin", "wisp.mjs"), "node", "start"]);
    expect(s.env.PATH).toBe(process.env.PATH);
    expect(s.log).toBe("/home/sam/.wisp/node.log");
  });

  it("writes a user systemd unit that logs to a file, and a system one that runs as a person", () => {
    const s = spec("hub", "/home/sam/.wisp");
    const user = systemdUnit(s, false);
    expect(user).toContain(`ExecStart=${process.execPath} ${path.join(REPO_ROOT, "bin", "wisp-hub.mjs")}`);
    expect(user).toContain("StandardOutput=append:/home/sam/.wisp/hub.log");
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
  it("marks the service's own daemon, so `wisp node start` by hand can tell it's already running", () => {
    expect(spec("node", "/home/sam/.wisp").env.WISP_SERVICE).toBe("1");
  });

  it("knows it's the service even when an older install doesn't say so", () => {
    const saved = process.env.WISP_SERVICE;
    delete process.env.WISP_SERVICE;
    try {
      expect(isService({ name: "ai.wisp.node", pid: process.pid })).toBe(true);
      // the keeper is the service's process; the daemon is its child
      expect(isService({ name: "ai.wisp.node", pid: process.ppid })).toBe(true);
      expect(isService({ name: "ai.wisp.node", pid: 999_999_999 })).toBe(false);
      expect(isService({ name: "ai.wisp.node" })).toBe(process.platform === "darwin" && process.env.XPC_SERVICE_NAME === "ai.wisp.node");
    } finally {
      if (saved !== undefined) process.env.WISP_SERVICE = saved;
    }
  });
});


describe("migrated service listen port", () => {
  it("reads launchd, systemd and scheduled-task definitions without exposing secrets", () => {
    expect(servicePortFromDefinition('<key>PORT</key><string>9876</string>')).toBe(9876);
    expect(servicePortFromDefinition('Environment="PORT=9876"')).toBe(9876);
    expect(servicePortFromDefinition("$env:PORT='9876'; $env:WISP_NODE_TOKEN='secret'")).toBe(9876);
    expect(servicePortFromDefinition("Environment=PORT=99999")).toBeUndefined();
  });
});
