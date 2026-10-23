import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { vncAuthResponse } from "@warren/core/src/vnc.ts";
import { signedInVnc, tightVncMsiArgs, x11vncArgs, newRemoteDesktop } from "../src/computers/remote-desktop.ts";
import { MAX_TRIES, ScreenLock, codeProblem, hashCode } from "../src/screen-lock.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "warren-lock-"));

describe("the screen's code", () => {
  it("takes a 6-digit PIN or a password of 8+ characters", () => {
    expect(codeProblem("pin", "123456")).toBeNull();
    expect(codeProblem("pin", "12345")).not.toBeNull();
    expect(codeProblem("pin", "12345a")).not.toBeNull();
    expect(codeProblem("password", "correct horse")).toBeNull();
    expect(codeProblem("password", "short")).not.toBeNull();
    expect(codeProblem("password", "12345678")).not.toBeNull();
  });

  it("keeps only a hash", () => {
    const saved = hashCode("pin", "246810");
    expect(JSON.stringify(saved)).not.toContain("246810");
  });

  it("without a code, the screen is open as before", () => {
    const lock = new ScreenLock(tmp(), () => undefined);
    expect(lock.enabled).toBe(false);
    expect(lock.open()).toBe(true);
    expect(lock.check(undefined).ok).toBe(true);
  });

  it("opens for a purpose until its time, and closes again", () => {
    let t = 1_000_000;
    const code = hashCode("pin", "246810");
    const lock = new ScreenLock(tmp(), () => code, () => t);
    expect(lock.open()).toBe(false);
    expect(lock.unlock("lend", "000000", t + 60_000).ok).toBe(false);
    expect(lock.open()).toBe(false);
    const r = lock.unlock("lend", "246810", t + 60_000);
    expect(r.ok && r.until).toBe(t + 60_000);
    expect(lock.open()).toBe(true);
    t += 61_000;
    expect(lock.open()).toBe(false);
    lock.unlock("view:a", "246810", t + 60_000);
    lock.lock("view:a");
    expect(lock.open()).toBe(false);
  });

  it("never opens for more than a day, whatever it's asked for", () => {
    const t = 5_000_000;
    const code = hashCode("password", "open sesame");
    const lock = new ScreenLock(tmp(), () => code, () => t);
    const r = lock.unlock("lend", "open sesame", t + 30 * 24 * 60 * 60_000);
    expect(r.ok && r.until).toBe(t + 24 * 60 * 60_000);
  });

  it("locks out guessing, remembers it across restarts, and doubles the wait", () => {
    let t = 10_000_000;
    const dir = tmp();
    const code = hashCode("pin", "246810");
    const lock = new ScreenLock(dir, () => code, () => t);
    for (let i = 1; i < MAX_TRIES; i++) {
      const r = lock.check("111111");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.triesLeft).toBe(MAX_TRIES - i);
    }
    const last = lock.check("111111");
    expect(!last.ok && last.lockedOut).toBe(true);
    // even the right code is turned away while locked out, and a restart doesn't reset it
    const again = new ScreenLock(dir, () => code, () => t);
    expect(again.check("246810").ok).toBe(false);
    t += 15 * 60_000 + 1;
    for (let i = 0; i < MAX_TRIES; i++) again.check("111111");
    const second = again.check("246810");
    expect(!second.ok && second.error).toMatch(/30 minutes/);
    t += 30 * 60_000 + 1;
    expect(again.check("246810").ok).toBe(true);
  });

  it("a lockout closes what the code had opened", () => {
    const t = 20_000_000;
    const code = hashCode("pin", "246810");
    const lock = new ScreenLock(tmp(), () => code, () => t);
    lock.unlock("lend", "246810", t + 60_000);
    for (let i = 0; i < MAX_TRIES; i++) lock.check("999999");
    expect(lock.open()).toBe(false);
  });
});

/** A VNC server that wants a password (RFB 3.8, VNC authentication), then echoes what it gets. */
function fakeVncServer(password: string) {
  const server = net.createServer((sock) => {
    let step = 0;
    let buf = Buffer.alloc(0);
    const challenge = crypto.randomBytes(16);
    sock.write("RFB 003.008\n");
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (step === 0 && buf.length >= 12) {
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 2]));
          step = 1;
        } else if (step === 1 && buf.length >= 1) {
          buf = buf.subarray(1);
          sock.write(challenge);
          step = 2;
        } else if (step === 2 && buf.length >= 16) {
          const ok = buf.subarray(0, 16).equals(vncAuthResponse(challenge, password));
          buf = buf.subarray(16);
          if (!ok) {
            const why = Buffer.from("wrong password");
            const len = Buffer.alloc(4);
            len.writeUInt32BE(why.length);
            sock.end(Buffer.concat([Buffer.from([0, 0, 0, 1]), len, why]));
            return;
          }
          sock.write(Buffer.from([0, 0, 0, 0]));
          step = 3;
        } else if (step === 3 && buf.length) {
          sock.write(buf);
          buf = Buffer.alloc(0);
        } else return;
      }
    });
  });
  return new Promise<{ port: number; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })));
}

/** Read from a stream until `n` bytes came. */
function readN(s: NodeJS.ReadableStream, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let got = Buffer.alloc(0);
    const on = (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= n) {
        s.off("data", on);
        resolve(got);
      }
    };
    s.on("data", on);
  });
}

describe("Remote Desktop's relay", () => {
  it("signs in with the server's password and lets the viewer in without one", async () => {
    const srv = await fakeVncServer("s3cretpw");
    try {
      const viewer = await signedInVnc({ server: "x11vnc", port: srv.port, password: "s3cretpw" });
      // the viewer sees a server that wants no password
      expect((await readN(viewer, 12)).toString()).toBe("RFB 003.008\n");
      viewer.write("RFB 003.008\n");
      expect([...(await readN(viewer, 2))]).toEqual([1, 1]);
      viewer.write(Buffer.from([1]));
      expect([...(await readN(viewer, 4))]).toEqual([0, 0, 0, 0]);
      // then bytes go straight through to the real server
      viewer.write(Buffer.from("hello"));
      expect((await readN(viewer, 5)).toString()).toBe("hello");
      viewer.destroy();
    } finally {
      srv.close();
    }
  });

  it("fails when the server's password is wrong", async () => {
    const srv = await fakeVncServer("s3cretpw");
    try {
      await expect(signedInVnc({ server: "x11vnc", port: srv.port, password: "nope" })).rejects.toThrow(/wrong password/);
    } finally {
      srv.close();
    }
  });

  it("says Remote Desktop isn't running when nothing listens", async () => {
    await expect(signedInVnc({ server: "x11vnc", port: 1, password: "x" })).rejects.toThrow(/isn't running/);
  });

  it("keeps the VNC servers on this device only", () => {
    const rd = newRemoteDesktop("x11vnc");
    expect(rd.password).toHaveLength(8);
    expect(x11vncArgs(rd, "/tmp/p", ":0")).toEqual(expect.arrayContaining(["-localhost", "-passwdfile", "/tmp/p"]));
    const msi = tightVncMsiArgs(newRemoteDesktop("tightvnc"));
    expect(msi).toEqual(expect.arrayContaining(["VALUE_OF_LOOPBACKONLY=1", "VALUE_OF_ACCEPTHTTPCONNECTIONS=0", "VALUE_OF_USEVNCAUTHENTICATION=1"]));
  });
});
