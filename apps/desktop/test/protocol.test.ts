import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const { isPairingLink, registerProtocols } = createRequire(import.meta.url)("../src/protocol.cjs");

describe("desktop pairing protocol compatibility", () => {
  it.each(["wisp", "warren"])("accepts %s pairing links", (scheme) => {
    expect(isPairingLink(`${scheme}://pair?v=1&id=p&s=s&u=https%3A%2F%2Fhub.example`)).toBe(true);
  });
  it.each(["https://pair", "wisp://other", "warren://pair/other", "invalid"])("rejects %s", (input) => expect(isPairingLink(input)).toBe(false));
  it("registers both schemes in packaged and source apps", () => {
    const app = { setAsDefaultProtocolClient: vi.fn() };
    registerProtocols(app, { defaultApp: false });
    expect(app.setAsDefaultProtocolClient.mock.calls).toEqual([["wisp"], ["warren"]]);
    app.setAsDefaultProtocolClient.mockClear();
    registerProtocols(app, { defaultApp: true, executable: "/electron", entry: "/source/app" });
    expect(app.setAsDefaultProtocolClient.mock.calls).toEqual([["wisp", "/electron", ["/source/app"]], ["warren", "/electron", ["/source/app"]]]);
  });
});
