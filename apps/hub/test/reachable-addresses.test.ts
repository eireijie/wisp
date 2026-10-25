import { describe, expect, it } from "vitest";
import { httpOrigin, isLocalJoinAddress, reachableAddresses } from "../src/reachable-addresses.ts";
import { pairingAddresses } from "../src/pairing.ts";
import { lanAddresses } from "../src/reach.ts";

describe("reachable addresses", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "0:0:0:0:0:0:0:1", "10.255.1.2", "172.16.0.1", "172.31.255.255", "192.168.1.2", "100.64.0.1", "100.127.255.255", "fc00::1", "fdff::1", "fe80::1", "febf::1", "::ffff:192.168.1.2", "::ffff:c0a8:0102"])("allows local joins from %s", (ip) => expect(isLocalJoinAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "169.254.1.2", "2001:db8::1", "fec0::1", "::", "::ffff:8.8.8.8", "not-an-ip"])("requires an invite from %s", (ip) => expect(isLocalJoinAddress(ip)).toBe(false));
  it("uses the same filtered addresses for pairing and reach settings", () => {
    const nic = (address: string, internal = false) => [{ family: "IPv4", address, internal }];
    const interfaces = { en0: nic("192.168.1.20"), en1: nic("192.168.1.20"), docker0: nic("172.17.0.1"), "br-abcd": nic("172.18.0.1"), veth23: nic("172.19.0.1"), bridge100: nic("192.168.64.1"), vmnet2: nic("192.168.65.1"), utun1: nic("10.20.0.1"), utun2: nic("100.80.1.2"), eth9: nic("169.254.2.3"), lo0: nic("127.0.0.1", true) } as never;
    const expected = ["https://home.example", "http://192.168.1.20:4747", "http://100.80.1.2:4747"];
    expect(reachableAddresses("https://home.example/path", 4747, interfaces)).toEqual(expected);
    expect(pairingAddresses("https://home.example/path", 4747, interfaces)).toEqual(expected);
    expect(lanAddresses(4747, interfaces)).toEqual([expected[1]]);
    for (const origin of ["http://localhost:4747", "http://127.0.0.1:4747", "http://[::1]:4747", "http://[::ffff:127.0.0.1]:4747", "http://192.168.64.1:4747", "http://169.254.1.1:4747", "javascript:alert(1)", "https://user:pass@example.com"]) expect(reachableAddresses(origin, 4747, interfaces)).toEqual(expected.slice(1));
  });
  it("rejects non-web or credential-bearing origins", () => {
    expect(httpOrigin("file:///etc/passwd")).toBeNull();
    expect(httpOrigin("https://user:pass@wisp.example")).toBeNull();
    expect(httpOrigin("https://wisp.example/path?q=1")).toBe("https://wisp.example");
  });
});
