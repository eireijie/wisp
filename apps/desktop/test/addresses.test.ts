import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { reachableAddresses } = createRequire(import.meta.url)("../src/addresses.cjs");
const address = (value: string, internal = false) => ({ address: value, internal });

describe("addresses other computers can use", () => {
  it("drops VM bridges, containers, link-local and non-Tailscale utun addresses", () => {
    const interfaces = {
      lo0: [address("127.0.0.1", true), address("::1", true)],
      en0: [address("192.168.1.2"), address("169.254.1.1"), address("fe80::1"), address("fd12::2")],
      docker0: [address("172.17.0.1")], "br-abc": [address("172.18.0.1")], veth42: [address("10.1.1.1")],
      bridge100: [address("192.168.64.1")], bridge101: [address("192.168.65.1")], vmnet8: [address("192.168.66.1")],
      utun0: [address("10.9.0.1"), address("fd00::1")], utun1: [address("100.64.0.1"), address("100.127.255.254")],
      utun2: [address("100.63.255.255"), address("100.128.0.1")],
    };
    expect(reachableAddresses(4747, interfaces)).toEqual([
      "http://192.168.1.2:4747", "http://[fd12::2]:4747", "http://100.64.0.1:4747", "http://100.127.255.254:4747",
    ]);
  });

  it("keeps ordinary LAN interfaces, deduplicates and supports custom ports", () => {
    expect(reachableAddresses(5000, { eth0: [address("10.0.0.2")], bridge0: [address("172.16.0.2")], wlan0: [address("10.0.0.2")] }))
      .toEqual(["http://10.0.0.2:5000", "http://172.16.0.2:5000"]);
  });
});
