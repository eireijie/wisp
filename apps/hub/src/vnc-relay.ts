import type { WebSocket } from "ws";
import { ByteReader, rfbLetIn, rfbSignIn } from "@warren/core/src/vnc.ts";

export { desEncrypt, vncAuthResponse } from "@warren/core/src/vnc.ts";

/**
 * The hub between a browser's noVNC and a VNC server that wants a password (an Orgo cloud
 * computer): the hub signs in to the server with the password and lets the browser in without
 * one, then passes bytes straight through. The password is root on the computer, so it never
 * reaches a browser.
 */

/** A WebSocket's bytes for the handshake; `detach()` stops listening and returns what came beyond it. */
function side(socket: WebSocket) {
  const reader = new ByteReader();
  const onMessage = (data: unknown) => reader.feed(toBuffer(data));
  const onEnd = () => reader.end();
  socket.on("message", onMessage);
  socket.on("close", onEnd);
  socket.on("error", onEnd);
  return {
    reader,
    send: (b: Uint8Array) => socket.send(b),
    detach() {
      socket.off("message", onMessage);
      socket.off("close", onEnd);
      socket.off("error", onEnd);
      return reader.take();
    },
  };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
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
  const up = side(upstream);
  const down = side(browser);
  try {
    await opened(upstream);
    await rfbSignIn(up, password);
    await rfbLetIn(down);
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
