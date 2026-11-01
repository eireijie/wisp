import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const init = yaml.load(fs.readFileSync(path.join(root, "docker/cloud-init.yaml"), "utf8")) as { write_files: { path: string; content: string }[] };
const file = (p: string) => init.write_files.find((f) => f.path === p)!.content;
const compose = yaml.load(file("/opt/wisp/compose.yaml")) as { services: Record<string, any> };

/** start.sh on a pretend server: every outside command is a stub, and /opt/wisp and /etc/motd are a scratch folder. */
function runStart(key: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-cloud-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("docker", `echo "$@" >> "${dir}/docker.log"`);
  stub("curl", "echo 203.0.113.7");
  stub("stat", "echo 988");
  stub("chown", `echo "$@" >> "${dir}/chown.log"`);
  fs.writeFileSync(path.join(dir, "setup-key"), key);
  const script = file("/opt/wisp/start.sh").replace("cd /opt/wisp", `cd "${dir}"`).replace("/etc/motd", `"${dir}/motd"`);
  fs.writeFileSync(path.join(dir, "start.sh"), script);
  execFileSync("sh", [path.join(dir, "start.sh")], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { dir, read: (f: string) => fs.readFileSync(path.join(dir, f), "utf8") };
}

describe("a Cloud server's first boot", () => {
  it("keeps the image's name, with or without a setup key (compose can't pull without it)", () => {
    for (const key of ["a-key", "__WISP_SETUP_KEY__"]) {
      const s = runStart(key);
      expect(s.read(".env")).toContain("WISP_REPO=eireijie/wisp");
      expect(s.read(".env")).toContain("DOCKER_GID=988");
      expect(s.read(".env").includes("WISP_SETUP_CODE=a-key")).toBe(key === "a-key");
      expect(s.read("docker.log")).toContain("compose up -d");
      expect(s.read("chown.log")).toContain("1000:1000 device link");
      fs.rmSync(s.dir, { recursive: true });
    }
  });
  it("runs a device beside the hub, so agents live on the server", () => {
    const d = compose.services.device;
    expect(d.command).toEqual(["node", "bin/wisp.mjs", "node", "start", "--local"]);
    expect(d.restart).toBe("unless-stopped");
    expect(d.image).toBe(compose.services.wisp.image);
  });
  it("keeps the device away from the hub's data, and off root", () => {
    const d = compose.services.device;
    expect(d.volumes.some((v: string) => v.startsWith("./data"))).toBe(false);
    expect(d.user).not.toMatch(/^0|root/);
    // the same note folder from both sides
    expect(compose.services.wisp.volumes).toContain("./link:/link");
    expect(compose.services.wisp.environment.WISP_LOCAL_DEVICE_DIR).toBe("/link");
    expect(d.volumes).toContain("./link:/opt/wisp/link");
    expect(d.environment.WISP_LOCAL_DEVICE_DIR).toBe("/opt/wisp/link");
  });
  it("lets the device reach the hub without opening it to the internet", () => {
    expect(compose.services.device.network_mode).toBe("host");
    expect(compose.services.wisp.ports).toEqual(["127.0.0.1:4747:4747"]);
  });
  it("keeps harnesses Wisp installs across image updates, and VM folders at the host's path", () => {
    const d = compose.services.device;
    expect(d.volumes).toContain("./device:/opt/wisp/device");
    expect(d.environment.HOME).toBe("/opt/wisp/device");
    expect(d.environment.PATH.startsWith(`${d.environment.NPM_CONFIG_PREFIX}/bin:`)).toBe(true);
  });
});

describe("the desktop app's Cloud setup", () => {
  const html = fs.readFileSync(path.join(root, "apps/desktop/src/setup.html"), "utf8");
  it("doesn't make the laptop the device: the server is", () => {
    expect(html).toMatch(/setup\.cloudCreate\([^)]*device: false/);
  });
  it("recommends a size that fits an agent's computer", () => {
    expect(html).toContain("p.memory >= 8");
  });
});
