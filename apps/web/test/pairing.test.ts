import { describe, expect, it } from "vitest";
import { pairingLink } from "../src/pairing.ts";

describe("pairing links shown and copied by the web app", () => {
  it.each(["wisp", "warren"])("accepts %s links and generates the public scheme without losing addresses or secrets", (scheme) => {
    const query = "?v=1&id=pair_1&s=secret&u=https%3A%2F%2Fhub.example&u=http%3A%2F%2F192.168.1.2%3A4747";
    expect(pairingLink(`${scheme}://pair${query}`)).toBe(`wisp://pair${query}`);
  });
  it.each(["https://pair", "wisp://elsewhere", "wisp://pair/other", "invalid"])("rejects %s", (link) => {
    expect(() => pairingLink(link)).toThrow();
  });
});
