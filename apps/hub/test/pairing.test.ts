import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import { pairingAddresses, pairingLink } from "../src/pairing.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;
let owner: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

/** what a phone reads out of the QR code */
const fromLink = (link: string) => {
  const q = new URL(link).searchParams;
  return { id: q.get("id")!, secret: q.get("s")!, addresses: q.getAll("u") };
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-pairing-"));
  const built = await buildHub({ dataDir: dir });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Yug", password: "password123", workspaceName: "Lab" }, "")).data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("pairing a phone", () => {
  it("lists the page's address first, then Wi-Fi, then Tailscale, and never loopback", () => {
    const nics = {
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      utun4: [{ family: "IPv4", address: "100.90.1.2", internal: false }],
      en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
      en9: [{ family: "IPv4", address: "169.254.3.3", internal: false }],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    expect(pairingAddresses("https://warren.example.com", 4747, nics)).toEqual(["https://warren.example.com", "http://192.168.1.20:4747", "http://100.90.1.2:4747"]);
    expect(pairingAddresses("http://localhost:4747", 4747, nics)).toEqual(["http://192.168.1.20:4747", "http://100.90.1.2:4747"]);
    expect(pairingLink({ id: "a", secret: "b", addresses: ["http://x:1"] })).toBe("warren://pair?v=1&id=a&s=b&u=http%3A%2F%2Fx%3A1");
  });

  it("gives the phone a sign-in only after the codes match and you confirm", async () => {
    const started = (await api("POST", "/api/pair", { origin: "https://warren.example.com" })).data;
    expect(started.state).toBe("waiting");
    expect(started.addresses[0]).toBe("https://warren.example.com");
    const qr = fromLink(started.link);

    // a wrong secret gets nothing
    expect((await api("POST", `/api/pair/${qr.id}/claim`, { secret: "guess", deviceName: "Mallory" }, "")).status).toBe(404);

    const claimed = await api("POST", `/api/pair/${qr.id}/claim`, { secret: qr.secret, deviceName: "Yug's iPhone", platform: "ios" }, "");
    expect(claimed.status).toBe(200);
    expect(claimed.data.code).toMatch(/^\d{6}$/);
    expect(claimed.data).toMatchObject({ userName: "Yug", workspaceName: "Lab" });

    // a second phone with the same QR code is turned away
    expect((await api("POST", `/api/pair/${qr.id}/claim`, { secret: qr.secret, deviceName: "Other" }, "")).status).toBe(409);

    // the computer sees the same code
    const seen = (await api("GET", `/api/pair/${qr.id}`)).data;
    expect(seen).toMatchObject({ state: "claimed", code: claimed.data.code, deviceName: "Yug's iPhone" });

    // nothing for the phone until you confirm
    expect((await api("POST", `/api/pair/${qr.id}/status`, { secret: qr.secret }, "")).data).toEqual({ state: "claimed" });
    expect((await api("POST", `/api/pair/${qr.id}/confirm`)).data.state).toBe("approved");

    const done = (await api("POST", `/api/pair/${qr.id}/status`, { secret: qr.secret }, "")).data;
    expect(done.state).toBe("approved");
    const me = (await api("GET", "/api/me", undefined, done.token)).data;
    expect(me.user.name).toBe("Yug");
    // handed over once
    expect((await api("POST", `/api/pair/${qr.id}/status`, { secret: qr.secret }, "")).status).toBe(404);
    // and it's a sign-in you can see and sign out
    const sessions = (await api<any[]>("GET", "/api/me/sessions")).data;
    expect(sessions.map((s) => s.label)).toContain("Warren on Yug's iPhone");
  });

  it("can be cancelled, needs a signed-in person to start, and is only visible to them", async () => {
    expect((await api("POST", "/api/pair", {}, "")).status).toBe(401);
    const started = (await api("POST", "/api/pair", {})).data;
    const qr = fromLink(started.link);
    expect((await api("POST", `/api/pair/${qr.id}/confirm`)).status).toBe(409);
    await api("POST", `/api/pair/${qr.id}/cancel`);
    expect((await api("POST", `/api/pair/${qr.id}/claim`, { secret: qr.secret }, "")).status).toBe(409);
    expect((await api("POST", `/api/pair/${qr.id}/status`, { secret: qr.secret }, "")).data).toEqual({ state: "rejected" });
  });

  it("starting again ends the last pairing", async () => {
    const first = fromLink((await api("POST", "/api/pair", {})).data.link);
    await api("POST", "/api/pair", {});
    expect((await api("POST", `/api/pair/${first.id}/claim`, { secret: first.secret }, "")).status).toBe(410);
  });
});
