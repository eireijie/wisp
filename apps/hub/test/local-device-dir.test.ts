import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDeviceDir } from "../src/local-device.ts";

afterEach(() => vi.unstubAllEnvs());

describe("where the hub and its device leave notes", () => {
  it("is the hub's data, unless the device mustn't see that data (a Cloud server)", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-link-"));
    expect(localDeviceDir(data)).toBe(data);
    vi.stubEnv("WISP_LOCAL_DEVICE_DIR", "/link");
    expect(localDeviceDir(data)).toBe("/link");
    fs.rmSync(data, { recursive: true });
  });
});
