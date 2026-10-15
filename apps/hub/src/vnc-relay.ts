import type { WebSocket } from "ws";

/**
 * The hub between a browser's noVNC and a VNC server that wants a password (an Orgo cloud
 * computer): the hub signs in to the server with the password and lets the browser in without
 * one, then passes bytes straight through. The password is root on the computer, so it never
 * reaches a browser. Speaks RFB 3.3 to 3.8 with the None (1) and VNC authentication (2) types.
 */

/** Bytes from a socket, in order, for the handshake; `detach()` hands the rest over to the relay. */
class Reader {
  private buf = Buffer.alloc(0);
  private pending: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private done: Error | null = null;
  private readonly onMessage = (data: unknown) => {
    this.buf = Buffer.concat([this.buf, toBuffer(data)]);
    this.serve();
  };
  private readonly onEnd = () => {
    this.done = new Error("the connection closed during the VNC handshake");
    this.serve();
  };

  constructor(private socket: WebSocket) {
    socket.on("message", this.onMessage);
    socket.on("close", this.onEnd);
    socket.on("error", this.onEnd);
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.pending = { n, resolve, reject };
      this.serve();
    });
  }

  private serve() {
    const p = this.pending;
    if (!p) return;
    if (this.buf.length >= p.n) {
      this.pending = null;
      const out = this.buf.subarray(0, p.n);
      this.buf = this.buf.subarray(p.n);
      p.resolve(out);
    } else if (this.done) {
      this.pending = null;
      p.reject(this.done);
    }
  }

  /** Stop reading; what arrived beyond the handshake is returned so nothing is lost. */
  detach(): Buffer {
    this.socket.off("message", this.onMessage);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onEnd);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

/** RFB's failure reason: a u32 length and the text. */
async function reason(r: Reader): Promise<string> {
  const n = (await r.read(4)).readUInt32BE(0);
  return n && n < 4096 ? (await r.read(n)).toString("utf8") : "the screen refused the connection";
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    if (ws.readyState > 1) return reject(new Error("the screen's connection is closed"));
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(new Error(`couldn't reach the screen: ${(e as Error).message}`)));
  });

/**
 * Sign in to `upstream` with the password, let `browser` in with no password, then relay. Resolves
 * once bytes flow; rejects (with both sockets still the caller's to close) when the handshake fails.
 */
export async function relayVnc(browser: WebSocket, upstream: WebSocket, password: string): Promise<void> {
  const up = new Reader(upstream);
  const down = new Reader(browser);
  try {
    await opened(upstream);

    // the server's side: its version, then whichever security type we can answer
    const hello = (await up.read(12)).toString("latin1");
    const m = hello.match(/^RFB (\d{3})\.(\d{3})\n$/);
    if (!m || m[1] !== "003") throw new Error(`the screen doesn't speak VNC (${JSON.stringify(hello.slice(0, 12))})`);
    const minor = Math.min(Number(m[2]), 8);
    upstream.send(`RFB 003.00${minor}\n`);
    let type: number;
    if (minor >= 7) {
      const n = (await up.read(1))[0];
      if (n === 0) throw new Error(await reason(up));
      const offered = [...(await up.read(n))];
      type = offered.includes(1) ? 1 : offered.includes(2) ? 2 : 0;
      if (!type) throw new Error(`the screen wants a kind of sign-in Warren doesn't do (types ${offered.join(", ")})`);
      upstream.send(Buffer.from([type]));
    } else {
      type = (await up.read(4)).readUInt32BE(0);
      if (type === 0) throw new Error(await reason(up));
      if (type !== 1 && type !== 2) throw new Error(`the screen wants a kind of sign-in Warren doesn't do (type ${type})`);
    }
    if (type === 2) upstream.send(vncAuthResponse(await up.read(16), password));
    if (type === 2 || minor >= 8) {
      const result = (await up.read(4)).readUInt32BE(0);
      if (result !== 0) throw new Error(minor >= 8 ? await reason(up) : "the screen refused the password");
    }

    // the browser's side: the same conversation, with no password to give
    browser.send("RFB 003.008\n");
    await down.read(12);
    browser.send(Buffer.from([1, 1]));
    const choice = (await down.read(1))[0];
    if (choice !== 1) throw new Error("the browser asked for a kind of sign-in the relay doesn't do");
    browser.send(Buffer.from([0, 0, 0, 0]));
  } catch (err) {
    up.detach();
    down.detach();
    throw err;
  }

  // from here on, bytes go straight through, starting with any that arrived during the handshake
  const toUp = down.detach();
  const toDown = up.detach();
  if (toUp.length) upstream.send(toUp);
  if (toDown.length) browser.send(toDown);
  browser.on("message", (data) => upstream.readyState === 1 && upstream.send(toBuffer(data)));
  upstream.on("message", (data) => browser.readyState === 1 && browser.send(toBuffer(data)));
  browser.on("close", () => upstream.close());
  upstream.on("close", (code, why) => browser.readyState <= 1 && browser.close(1000, String(why ?? "").slice(0, 120) || `closed (${code})`));
  upstream.on("error", () => browser.readyState <= 1 && browser.close(4502, "the screen's connection dropped"));
  browser.on("error", () => upstream.close());
}

// --- VNC authentication: DES on the challenge, keyed with the password -------------------------

/**
 * The 16-byte answer to a VNC authentication challenge: each 8-byte half DES-encrypted with the
 * password (padded or cut to 8 bytes) as the key, with the bits of each key byte reversed, as VNC
 * servers have always done it. Exported for tests.
 */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "utf8").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(key[i]);
  return Buffer.concat([desEncrypt(key, challenge.subarray(0, 8)), desEncrypt(key, challenge.subarray(8, 16))]);
}

function reverseBits(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
  return r;
}

// DES (FIPS 46-3): just enough for one block, since Node's OpenSSL no longer ships DES. Exported for tests.
// prettier-ignore
const IP = [58,50,42,34,26,18,10,2, 60,52,44,36,28,20,12,4, 62,54,46,38,30,22,14,6, 64,56,48,40,32,24,16,8, 57,49,41,33,25,17,9,1, 59,51,43,35,27,19,11,3, 61,53,45,37,29,21,13,5, 63,55,47,39,31,23,15,7];
// prettier-ignore
const FP = [40,8,48,16,56,24,64,32, 39,7,47,15,55,23,63,31, 38,6,46,14,54,22,62,30, 37,5,45,13,53,21,61,29, 36,4,44,12,52,20,60,28, 35,3,43,11,51,19,59,27, 34,2,42,10,50,18,58,26, 33,1,41,9,49,17,57,25];
// prettier-ignore
const E = [32,1,2,3,4,5, 4,5,6,7,8,9, 8,9,10,11,12,13, 12,13,14,15,16,17, 16,17,18,19,20,21, 20,21,22,23,24,25, 24,25,26,27,28,29, 28,29,30,31,32,1];
// prettier-ignore
const P = [16,7,20,21,29,12,28,17, 1,15,23,26,5,18,31,10, 2,8,24,14,32,27,3,9, 19,13,30,6,22,11,4,25];
// prettier-ignore
const PC1 = [57,49,41,33,25,17,9, 1,58,50,42,34,26,18, 10,2,59,51,43,35,27, 19,11,3,60,52,44,36, 63,55,47,39,31,23,15, 7,62,54,46,38,30,22, 14,6,61,53,45,37,29, 21,13,5,28,20,12,4];
// prettier-ignore
const PC2 = [14,17,11,24,1,5, 3,28,15,6,21,10, 23,19,12,4,26,8, 16,7,27,20,13,2, 41,52,31,37,47,55, 30,40,51,45,33,48, 44,49,39,56,34,53, 46,42,50,36,29,32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
// prettier-ignore
const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8, 4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5, 0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1, 13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9, 10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6, 4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8, 9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6, 1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2, 7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const bits = (buf: Buffer): number[] => [...buf].flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
const bytes = (b: number[]): Buffer => Buffer.from(Array.from({ length: b.length / 8 }, (_, i) => b.slice(i * 8, i * 8 + 8).reduce((v, bit) => (v << 1) | bit, 0)));
const permute = (b: number[], table: number[]) => table.map((i) => b[i - 1]);
const xor = (a: number[], b: number[]) => a.map((v, i) => v ^ b[i]);

function roundKeys(key: Buffer): number[][] {
  const k = permute(bits(key), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  const out: number[][] = [];
  for (const s of SHIFTS) {
    c = [...c.slice(s), ...c.slice(0, s)];
    d = [...d.slice(s), ...d.slice(0, s)];
    out.push(permute([...c, ...d], PC2));
  }
  return out;
}

function feistel(r: number[], k: number[]): number[] {
  const x = xor(permute(r, E), k);
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    const b = x.slice(i * 6, i * 6 + 6);
    const row = (b[0] << 1) | b[5];
    const col = (b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4];
    const v = S[i][row * 16 + col];
    out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return permute(out, P);
}

/** One DES block, for the VNC handshake above. Exported for tests. */
export function desEncrypt(key: Buffer, block: Buffer): Buffer {
  const keys = roundKeys(key);
  const ip = permute(bits(block), IP);
  let l = ip.slice(0, 32);
  let r = ip.slice(32);
  for (const k of keys) [l, r] = [r, xor(l, feistel(r, k))];
  return bytes(permute([...r, ...l], FP));
}
