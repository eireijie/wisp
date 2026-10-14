import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-install-"));
  const built = await buildHub({ dataDir: dir });
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
    expect(text).toMatch(/^WARREN_REPO="\$\{WARREN_REPO:-https:\/\/[^}]+\}"$/m);
  });

  it("serves install.ps1", async () => {
    const text = await (await fetch(`${base}/install.ps1`)).text();
    expect(text).toMatch(/^\$Repo = if \(\$env:WARREN_REPO\) \{ \$env:WARREN_REPO \} else \{ "https:\/\/[^"]+" \}$/m);
  });
});
