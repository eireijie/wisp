import { describe, expect, it } from "vitest";
import { Terminals, deviceShell, sessionName, vmShell, type Pty, type ShellCommand } from "../src/terminals.ts";

/** A pretend terminal: records what it was asked, and prints or exits when told to. */
function fakes() {
  const made: { cmd: ShellCommand; size: number[]; written: string[]; killed: boolean; print: (s: string) => void; exit: (code: number) => void }[] = [];
  const spawn = () => (cmd: ShellCommand, cols: number, rows: number): Pty => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p = { cmd, size: [cols, rows], written: [] as string[], killed: false, print: (s: string) => onData(s), exit: (code: number) => onExit({ exitCode: code }) };
    made.push(p);
    return {
      onData: (cb) => (onData = cb),
      onExit: (cb) => (onExit = cb),
      write: (d) => p.written.push(String(d)),
      resize: (c, r) => (p.size = [c, r]),
      kill: () => (p.killed = true),
    };
  };
  return { made, spawn };
}

const viewer = () => {
  const v = { out: "", closed: [] as (string | undefined)[], send: (b: Buffer) => (v.out += b.toString()), close: (err?: string) => v.closed.push(err ?? "ok") };
  return v;
};
const cmd = async (): Promise<ShellCommand> => ({ file: "/bin/sh", args: [] });

describe("terminals on a device", () => {
  it("keeps a shell running after its viewer goes, and shows the next one its recent screen", async () => {
    const f = fakes();
    const t = new Terminals(f.spawn, 60_000);
    const a = viewer();
    expect((await t.attach("dev:c:main", "term_a", { cols: 80, rows: 24 }, cmd, a.send, a.close)).resumed).toBe(false);
    f.made[0].print("hello\r\n");
    t.write("term_a", Buffer.from("ls\r"));
    expect(f.made[0].written).toEqual(["ls\r"]);
    t.detach("term_a");
    expect(f.made[0].killed).toBe(false);
    const b = viewer();
    const again = await t.attach("dev:c:main", "term_b", { cols: 120, rows: 40 }, cmd, b.send, b.close);
    expect(again.resumed).toBe(true);
    expect(b.out).toBe("");
    again.replay();
    expect(b.out).toBe("hello\r\n");
    expect(f.made[0].size).toEqual([120, 40]);
    expect(f.made).toHaveLength(1);
  });

  it("lets the newest viewer have it, like tmux", async () => {
    const f = fakes();
    const t = new Terminals(f.spawn);
    const a = viewer();
    const b = viewer();
    await t.attach("k", "term_a", { cols: 80, rows: 24 }, cmd, a.send, a.close);
    await t.attach("k", "term_b", { cols: 80, rows: 24 }, cmd, b.send, b.close);
    expect(a.closed).toEqual(["opened somewhere else"]);
    // the old one can't type into it any more
    t.write("term_a", Buffer.from("x"));
    expect(f.made[0].written).toEqual([]);
  });

  it("stops a shell nobody comes back to, and one whose pane was closed", async () => {
    const f = fakes();
    const t = new Terminals(f.spawn, 20);
    const a = viewer();
    await t.attach("one", "term_a", { cols: 80, rows: 24 }, cmd, a.send, a.close);
    t.detach("term_a");
    await new Promise((r) => setTimeout(r, 60));
    expect(f.made[0].killed).toBe(true);
    expect(t.count).toBe(0);
    const stopped: string[] = [];
    await t.attach("two", "term_b", { cols: 80, rows: 24 }, async () => ({ file: "tmux", args: [], stop: () => stopped.push("tmux") }), a.send, a.close);
    t.detach("term_b", true);
    expect(f.made[1].killed).toBe(true);
    expect(stopped).toEqual(["tmux"]);
  });

  it("tells the viewer when the shell exits", async () => {
    const f = fakes();
    const t = new Terminals(f.spawn);
    const a = viewer();
    await t.attach("k", "term_a", { cols: 80, rows: 24 }, cmd, a.send, a.close);
    f.made[0].exit(0);
    expect(a.closed).toEqual(["ok"]);
    expect(t.count).toBe(0);
  });

  it("keeps only the recent screen", async () => {
    const f = fakes();
    const t = new Terminals(f.spawn);
    const a = viewer();
    await t.attach("k", "term_a", { cols: 80, rows: 24 }, cmd, a.send, a.close);
    for (let i = 0; i < 400; i++) f.made[0].print(`${i}`.padEnd(1024, "."));
    t.detach("term_a");
    const b = viewer();
    (await t.attach("k", "term_b", { cols: 80, rows: 24 }, cmd, b.send, b.close)).replay();
    expect(b.out.length).toBeLessThanOrEqual(256 * 1024);
    expect(b.out.startsWith("0.")).toBe(false);
    expect(b.out).toContain("399.");
  });

  it("closes only the shells it's told to", async () => {
    const f = fakes();
    const t = new Terminals(f.spawn);
    const a = viewer();
    await t.attach("vm:x:main", "term_a", { cols: 80, rows: 24 }, cmd, a.send, a.close);
    await t.attach("dev:y:main", "term_b", { cols: 80, rows: 24 }, cmd, viewer().send, () => {});
    t.killAll("vm:x:");
    expect(a.closed).toEqual(["the terminal was closed"]);
    expect(t.count).toBe(1);
  });
});

describe("which shell opens", () => {
  it("names sessions safely", () => {
    expect(sessionName("My Pane; rm -rf /")).toBe("my-pane-rm-rf");
    expect(sessionName("")).toBe("main");
  });

  it("uses tmux on the device when it's there, otherwise the person's shell", () => {
    const env = { SHELL: "/bin/sh" };
    expect(deviceShell("main", { platform: "linux", env, has: () => true })).toMatchObject({ file: "tmux", args: ["new-session", "-A", "-s", "wisp-main", ";", "set-option", "-t", "wisp-main", "status", "off"] });
    expect(deviceShell("main", { platform: "linux", env, has: () => false })).toMatchObject({ file: "/bin/sh", args: ["-l"] });
    expect(deviceShell("main", { platform: "win32", env, has: () => false }).file).toBe("powershell.exe");
  });

  it("opens a VM's shell as the agent's user, with a terminal", () => {
    const c = vmShell({ bin: "docker", name: "wisp-c1", user: "wisp", home: "/home/wisp" }, "main");
    expect(c.file).toBe("docker");
    expect(c.args.slice(0, 7)).toEqual(["exec", "-i", "-t", "-u", "wisp", "-w", "/home/wisp"]);
    // the session name goes in as an argument, never into the script
    expect(c.args.at(-1)).toBe("main");
    expect(c.args.join(" ")).toContain("wisp-c1");
  });
});
