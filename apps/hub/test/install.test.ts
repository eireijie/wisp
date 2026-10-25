import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-install-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("installers", () => {
  it("serves install.sh without signing in, cloning from a repo", async () => {
    const res = await fetch(`${base}/install.sh`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(text).toContain('WISP_REPO="${WISP_REPO-${WARREN_REPO-https://');
  });

  it("serves install.ps1", async () => {
    const text = await (await fetch(`${base}/install.ps1`)).text();
    expect(text).toContain("elseif (Test-Path Env:WARREN_REPO) { $env:WARREN_REPO }");
  });
});

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("install.sh", () => {
  it.skipIf(process.platform === "win32")("says what's missing for an option given without its value, instead of dying", async () => {
    const script = fileURLToPath(new URL("../../../install.sh", import.meta.url));
    const run = (args: string[]) => new Promise<{ code: number; stderr: string }>((resolve) => execFile("bash", [script, ...args], (err, _stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stderr })));
    const hub = await run(["--hub"]);
    expect(hub.code).toBe(1);
    expect(hub.stderr).toContain("--hub needs a value, for example: --hub http://my-server:4747");
    const token = await run(["--hub", "http://h:4747", "--token"]);
    expect(token.code).toBe(1);
    expect(token.stderr).toContain("--token needs a value");
  });
});

import { execFileSync } from "node:child_process";
import { joinInstaller } from "../src/app.ts";

describe("hub installer join compatibility", () => {
  it("rewrites old installers for join with and without an invite, including when piped to sh", async () => {
    const fixture = `#!/usr/bin/env bash
set -euo pipefail
MODE="" HUB="" TOKEN=""
wisp() { printf '<%s>' "$@"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-server) MODE=hub ;;
    *) exit 9 ;;
  esac
  shift
done
if [ "$MODE" = hub ]; then
  printf hub
else
  printf default
fi
`;
    const rewritten = joinInstaller(fixture);
    const invite = "https://wisp.example/join/abc'$(exit 7)";
    expect(execFileSync("sh", ["-s", "--", "join", invite], { input: rewritten, encoding: "utf8" })).toBe(`<join><${invite}>`);
    expect(execFileSync("sh", ["-s", "--", "join"], { input: rewritten, encoding: "utf8" })).toBe("<join>");
    expect(execFileSync("sh", ["-s", "--", "--hub-server"], { input: rewritten, encoding: "utf8" })).toBe("hub");
    const served = await (await fetch(`${base}/install.sh`)).text();
    expect(served).toMatch(/^\s*join\)/m);
    expect(served).toContain("exec bash -s --");
  });
  it("leaves an installer with native join support intact inside its sh wrapper", () => {
    const native = '#!/usr/bin/env bash\ncase "$1" in\njoin) printf "native:%s" "${2:-}" ;;\nesac\n';
    expect(execFileSync("sh", ["-s", "--", "join", "https://wisp.example/join/a"], { input: joinInstaller(native), encoding: "utf8" })).toBe("native:https://wisp.example/join/a");
  });
});
