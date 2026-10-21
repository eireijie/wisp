import { describe, expect, it } from "vitest";
import { Reach, explainTailscaleError, lanAddresses, parseJson, readStatus, tailscaleCandidates, type Run } from "../src/reach.ts";

const HOST = "box.tail1234.ts.net";
const status = (state: string, extra: Record<string, unknown> = {}) => ({
  BackendState: state,
  AuthURL: "",
  CurrentTailnet: { Name: "me@example.com" },
  Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.80.1.2", "fd7a::1"], CapMap: { https: null, funnel: null } },
  ...extra,
});
const serving = (funnel = false) => ({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4747" } } } }, ...(funnel ? { AllowFunnel: { [`${HOST}:443`]: true } } : {}) });

/** A fake tailscale: answers status from `state`, records every command, and lets tests change state. */
function fake(initial: { status: unknown; serve: unknown }, onRun?: (args: string[], s: { status: unknown; serve: unknown }) => { code?: number; stdout?: string; stderr?: string } | void) {
  const s = { ...initial };
  const calls: string[] = [];
  const run: Run = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return { code: 0, stdout: `Warning: client version != server version\n${JSON.stringify(s.status)}`, stderr: "" };
    if (args[0] === "serve" && args[1] === "status") return { code: 0, stdout: JSON.stringify(s.serve), stderr: "" };
    const r = onRun?.(args, s) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { s, calls, reach: new Reach(4747, run, (p) => p.endsWith("tailscale")) };
}

describe("reading Tailscale", () => {
  it("knows the states, the address and whether it serves this hub", () => {
    expect(readStatus(status("Running"), serving(), 4747)).toMatchObject({ state: "running", dnsName: HOST, ip: "100.80.1.2", tailnet: "me@example.com", canHttps: true, canFunnel: true, serving: true, funnel: false });
    expect(readStatus(status("Running"), serving(true), 4747)).toMatchObject({ serving: true, funnel: true });
    // serving something else doesn't count
    expect(readStatus(status("Running"), serving(), 3000).serving).toBe(false);
    expect(readStatus(status("Stopped"), {}, 4747)).toMatchObject({ state: "stopped", serving: false });
    expect(readStatus(status("NeedsLogin", { AuthURL: "https://login.tailscale.com/a/abc" }), {}, 4747)).toMatchObject({ state: "needs-login", dnsName: null, authUrl: "https://login.tailscale.com/a/abc" });
  });

  it("reads JSON after a warning line, and explains known failures", () => {
    expect(parseJson('Warning: x\n{"a":1}')).toEqual({ a: 1 });
    expect(explainTailscaleError("Access denied: serve config denied", "linux")).toMatch(/sudo tailscale set --operator=\$USER/);
    expect(explainTailscaleError("HTTPS is not enabled for this tailnet")).toMatch(/admin\/dns/);
    expect(explainTailscaleError("failed to connect to local tailscaled; it doesn't appear to be running")).toMatch(/not running/);
  });

  it("looks for the command where each system puts it", () => {
    expect(tailscaleCandidates("darwin", "/usr/bin")).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(tailscaleCandidates("win32", "")).toContain("C:\\Program Files\\Tailscale\\tailscale.exe");
  });

  it("lists home-network addresses, not loopback, Tailscale or VM bridges", () => {
    const ifs = {
      en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      utun3: [{ family: "IPv4", address: "100.80.1.2", internal: false }],
      bridge100: [{ family: "IPv4", address: "192.168.64.1", internal: false }],
    } as never;
    expect(lanAddresses(4747, ifs)).toEqual(["http://192.168.1.20:4747"]);
  });
});

describe("changing Tailscale", () => {
  it("reports missing when the command isn't there, and notices when it's installed later", async () => {
    let installed = false;
    const reach = new Reach(4747, async (_b, args) => ({ code: 0, stdout: args[0] === "status" ? JSON.stringify(status("NeedsLogin")) : "{}", stderr: "" }), () => installed);
    expect((await reach.tailscale()).state).toBe("missing");
    await expect(reach.act("serve")).rejects.toThrow(/isn't installed/);
    installed = true;
    expect((await reach.tailscale(true)).state).toBe("needs-login");
  });

  it("turns the https address on and off, privately or for everyone", async () => {
    const { s, calls, reach } = fake({ status: status("Running"), serve: {} }, (args, st) => {
      if (args[0] === "serve" && args.includes("--bg")) st.serve = serving();
      if (args[0] === "funnel" && args.includes("--bg")) st.serve = serving(true);
      if (args.join(" ") === "serve --https=443 off") st.serve = {};
      if (args.join(" ") === "funnel --https=443 off" && st.serve) st.serve = { ...(st.serve as object), AllowFunnel: {} };
    });
    expect(await reach.publicUrl()).toBeNull();
    expect(await reach.act("serve")).toMatchObject({ serving: true, funnel: false });
    expect(calls).toContain("serve --bg --yes http://127.0.0.1:4747");
    expect(await reach.publicUrl()).toBe(`https://${HOST}`);
    expect(await reach.act("funnel")).toMatchObject({ serving: true, funnel: true });
    expect(await reach.act("unfunnel")).toMatchObject({ serving: true, funnel: false });
    expect(await reach.act("unserve")).toMatchObject({ serving: false });
    expect(s.serve).toEqual({});
  });

  it("hands back the sign-in page, and says why a change failed", async () => {
    const { reach } = fake({ status: status("NeedsLogin"), serve: {} }, (args) => (args[0] === "login" ? { code: 1, stderr: "To authenticate, visit:\n\n\thttps://login.tailscale.com/a/xyz123\n\ntimeout" } : args[0] === "serve" ? { code: 1, stderr: "Access denied: serve config denied" } : undefined));
    expect((await reach.act("login")).authUrl).toBe("https://login.tailscale.com/a/xyz123");
    expect((await reach.act("serve")).error).toMatch(/isn't allowed/);
  });
});
