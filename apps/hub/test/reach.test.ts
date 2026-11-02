import { describe, expect, it } from "vitest";
import { CONNECTOR_PATHS, Reach, explainTailscaleError, lanAddresses, parseJson, readStatus, tailscaleCandidates, type Run } from "../src/reach.ts";

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
    expect(explainTailscaleError("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=abc")).toBe("Tailscale Serve is off for your tailnet. Turn it on, then try again: https://login.tailscale.com/f/serve?node=abc");
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

describe("the door for Grok, ChatGPT and Claude", () => {
  const door = (extra: Record<string, { Proxy: string }> = {}) => ({
    ...serving(),
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: { ...serving().Web, [`${HOST}:8443`]: { Handlers: { ...Object.fromEntries(CONNECTOR_PATHS.map((p) => [p, { Proxy: `http://127.0.0.1:4747${p}` }])), ...extra } } },
    AllowFunnel: { [`${HOST}:8443`]: true },
  });
  /** a tailscale that keeps serve config the way `funnel --set-path` does */
  const door443 = () => fake({ status: status("Running"), serve: serving() }, (args, st) => {
    const cfg = st.serve as { Web?: unknown; AllowFunnel?: Record<string, boolean> };
    const path = args.find((a) => a.startsWith("--set-path="))?.slice("--set-path=".length);
    if (args[0] !== "funnel" || !args.includes("--https=8443") || !path) return;
    const web = (cfg.Web ??= {} as never) as Record<string, { Handlers: Record<string, { Proxy: string }> }>;
    const handlers = (web[`${HOST}:8443`] ??= { Handlers: {} }).Handlers;
    if (args.at(-1) === "off") delete handlers[path];
    else handlers[path] = { Proxy: args.at(-1)! };
    cfg.AllowFunnel = Object.keys(handlers).length ? { [`${HOST}:8443`]: true } : {};
  });

  it("is open only when every connector path goes to this hub, publicly", () => {
    expect(readStatus(status("Running"), serving(), 4747).connectors).toBe(false);
    expect(readStatus(status("Running"), door(), 4747)).toMatchObject({ connectors: true, funnel: false, serving: true });
    expect(readStatus(status("Running"), { ...door(), AllowFunnel: {} }, 4747).connectors).toBe(false);
    expect(readStatus(status("Running"), door(), 3000).connectors).toBe(false);
  });

  it("opens just the connector paths on 8443 and closes them again, leaving the private address", async () => {
    const { calls, reach } = door443();
    const opened = await reach.act("connectors");
    expect(opened).toMatchObject({ connectors: true, funnel: false, serving: true, error: null });
    expect(calls.filter((c) => c.startsWith("funnel"))).toEqual(CONNECTOR_PATHS.map((p) => `funnel --bg --yes --https=8443 --set-path=${p} http://127.0.0.1:4747${p}`));
    // the whole hub is never made public
    expect(calls.some((c) => c.startsWith("funnel") && !c.includes("--https=8443"))).toBe(false);
    expect(await reach.connectorUrl()).toBe(`https://${HOST}:8443`);
    const closed = await reach.act("unconnectors");
    expect(closed).toMatchObject({ connectors: false, serving: true });
    expect(await reach.connectorUrl()).toBeNull();
  });

  it("turns on the private address first, since the approval page opens there", async () => {
    const { calls, reach } = fake({ status: status("Running"), serve: {} }, (args, st) => {
      if (args[0] === "serve" && args.includes("--bg")) st.serve = serving();
    });
    await reach.act("connectors");
    expect(calls.find((c) => !c.includes("status"))).toBe("serve --bg --yes http://127.0.0.1:4747");
  });

  it("won't take over port 8443 when something else uses it", async () => {
    const { calls, reach } = fake({ status: status("Running"), serve: { ...serving(), Web: { ...serving().Web, [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } } } });
    const r = await reach.act("connectors");
    expect(r.error).toMatch(/already shares something else on port 8443/);
    expect(calls.filter((c) => c.startsWith("funnel"))).toEqual([]);
  });

  it("closes what it opened when Funnel refuses partway, and links the fix", async () => {
    let opened = 0;
    const { calls, reach } = fake({ status: status("Running"), serve: serving() }, (args) => {
      if (args[0] === "funnel" && args.at(-1) !== "off" && ++opened === 2) return { code: 1, stderr: "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/funnel?node=abc" };
    });
    const r = await reach.act("connectors");
    expect(r.error).toBe("Funnel is off for your tailnet. Turn it on, then try again: https://login.tailscale.com/f/funnel?node=abc");
    expect(calls.filter((c) => c.endsWith("off"))).toEqual(CONNECTOR_PATHS.map((p) => `funnel --https=8443 --set-path=${p} off`));
  });

  it("closes with the private address, so nothing is left pointing at this port", async () => {
    const { calls, reach } = door443();
    await reach.act("connectors");
    await reach.act("unserve");
    expect(calls).toEqual(expect.arrayContaining(CONNECTOR_PATHS.map((p) => `funnel --https=8443 --set-path=${p} off`)));
    expect((await reach.tailscale(true)).connectors).toBe(false);
  });
});
