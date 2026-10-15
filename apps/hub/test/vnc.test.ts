import { describe, expect, it } from "vitest";
import { desEncrypt, vncAuthResponse } from "../src/vnc-relay.ts";

describe("VNC authentication on the hub", () => {
  it("DES gives the FIPS 46 example answer", () => {
    expect(desEncrypt(Buffer.from("133457799BBCDFF1", "hex"), Buffer.from("0123456789ABCDEF", "hex")).toString("hex")).toBe("85e813540f0ab405");
  });

  it("answers a challenge with the password's bits reversed as the key, 8 characters at most", () => {
    const challenge = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    // "password" with each byte's bits reversed
    const key = Buffer.from([...Buffer.from("password")].map((b) => Number.parseInt(b.toString(2).padStart(8, "0").split("").reverse().join(""), 2)));
    const expected = Buffer.concat([desEncrypt(key, challenge.subarray(0, 8)), desEncrypt(key, challenge.subarray(8))]);
    expect(vncAuthResponse(challenge, "password").equals(expected)).toBe(true);
    expect(vncAuthResponse(challenge, "password123").equals(expected)).toBe(true);
    expect(vncAuthResponse(challenge, "pw").equals(expected)).toBe(false);
    expect(vncAuthResponse(challenge, "pw").length).toBe(16);
  });
});
