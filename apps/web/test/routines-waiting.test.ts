import { describe, expect, it, vi } from "vitest";
vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

import { routinesWaitingFor } from "../src/views/AgentComputer.tsx";
import type { DeviceInfo } from "../src/devices.ts";

const dev = (o: Partial<DeviceInfo>) => ({ id: "d1", name: "Kitchen Mac", online: true, paused: false, ...o }) as DeviceInfo;
const agent = { nodeId: "d1", harness: "claude" };

describe("routinesWaitingFor", () => {
  it("is null when the device is online", () => expect(routinesWaitingFor(agent, [dev({})])).toBeNull());
  it("is null while devices load", () => expect(routinesWaitingFor(agent, null)).toBeNull());
  it("names an offline device", () => expect(routinesWaitingFor(agent, [dev({ online: false })])).toBe("Kitchen Mac"));
  it("names a paused device", () => expect(routinesWaitingFor(agent, [dev({ paused: true })])).toBe("Kitchen Mac"));
  it("says a device when there is none", () => expect(routinesWaitingFor({ nodeId: null, harness: "claude" } as never, [])).toBe("a device"));
});
