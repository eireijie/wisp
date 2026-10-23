import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { ByteReader, rfbLetIn, rfbSignIn } from "@warren/core/src/vnc.ts";
import { exec, has } from "./driver.ts";

/**
 * Remote Desktop: a real VNC server on this device for its own screen, so live view streams only
 * what changed instead of screenshots. The server only listens on this device (127.0.0.1) and has
 * a random password that never leaves it: Warren's device program signs in with it and relays the
 * connection to the hub, after the person's own screen code was checked (see screen-lock.ts).
 *
 *   Linux    x11vnc, started and kept running by `warren node` (X11 only)
 *   Windows  TightVNC, installed as a Windows service
 *   macOS    not yet: Screen Sharing can't be set to listen on this device alone
 */

export interface RemoteDesktopConfig {
  server: "x11vnc" | "tightvnc";
  port: number;
  /** the VNC server's own password; VNC only uses the first 8 characters */
  password: string;
}

/** Off the usual 5900, so it doesn't clash with a VNC server someone already runs. */
export const REMOTE_DESKTOP_PORT = 5931;

export function newRemoteDesktop(server: RemoteDesktopConfig["server"]): RemoteDesktopConfig {
  // 8 characters is all VNC authentication looks at
  return { server, port: REMOTE_DESKTOP_PORT, password: crypto.randomBytes(6).toString("base64url").slice(0, 8) };
}

/** Is something listening on the port, on this device? */
export function listening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Connect to the VNC server and sign in with its password, then hand back a connection that lets
 * the viewer in without one. The viewer's half of the handshake runs once bytes flow.
 */
export async function signedInVnc(rd: RemoteDesktopConfig): Promise<Duplex> {
  const sock = net.connect(rd.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", (e) => reject(new Error(`Remote Desktop isn't running on this device (${e.message}). Run \`warren node screen remote\` here to set it up again.`)));
  });
  const up = new ByteReader();
  const feedUp = (b: Buffer) => up.feed(b);
  const endUp = () => up.end();
  sock.on("data", feedUp);
  sock.on("close", endUp);
  sock.on("error", endUp);
  try {
    await rfbSignIn({ reader: up, send: (b) => sock.write(b) }, rd.password);
  } catch (err) {
    sock.destroy();
    throw err;
  }
  sock.off("data", feedUp);

  const down = new ByteReader();
  let flowing = false;
  const viewer = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      if (flowing) sock.write(chunk, cb);
      else {
        down.feed(chunk);
        cb();
      }
    },
    destroy(err, cb) {
      down.end();
      sock.destroy();
      cb(err);
    },
  });
  void rfbLetIn({ reader: down, send: (b) => viewer.push(Buffer.from(b)) }).then(
    () => {
      flowing = true;
      const toServer = down.take();
      if (toServer.length) sock.write(toServer);
      const toViewer = up.take();
      if (toViewer.length) viewer.push(toViewer);
      sock.on("data", (b: Buffer) => viewer.push(b));
      sock.on("close", () => viewer.destroy());
    },
    (err) => viewer.destroy(err as Error),
  );
  sock.on("error", (e) => viewer.destroy(e));
  return viewer;
}

/** x11vnc's arguments: this display, this device only, its password from a file only this user can read. */
export function x11vncArgs(rd: RemoteDesktopConfig, passFile: string, display: string): string[] {
  const args = ["-display", display, "-localhost", "-rfbport", String(rd.port), "-passwdfile", passFile, "-forever", "-shared", "-noxdamage", "-quiet"];
  if (!process.env.XAUTHORITY) args.push("-auth", "guess");
  return args;
}

/**
 * Keeps x11vnc running on Linux while the screen is on (and restarts it if it stops). On Windows
 * the TightVNC service runs itself, so there is nothing to keep running here.
 */
export class RemoteDesktopServer {
  private child: ChildProcess | null = null;
  private wanted = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(
    private dir: string,
    private log: (m: string) => void,
  ) {}

  private get passFile() {
    return path.join(this.dir, "remote-desktop.pass");
  }

  /** Run (or keep running) the server for this config; null stops it. */
  set(rd: RemoteDesktopConfig | undefined | null) {
    if (!rd || rd.server !== "x11vnc" || process.platform !== "linux") return this.stop();
    if (this.wanted && this.child) return;
    this.wanted = true;
    fs.writeFileSync(this.passFile, `${rd.password}\n`, { mode: 0o600 });
    this.spawn(rd);
  }

  private spawn(rd: RemoteDesktopConfig) {
    if (!this.wanted) return;
    const display = process.env.DISPLAY ?? ":0";
    const child = spawn("x11vnc", x11vncArgs(rd, this.passFile, display), { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, DISPLAY: display } });
    this.child = child;
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (err = (err + c).slice(-2000)));
    const started = Date.now();
    const again = (why: string) => {
      if (this.child === child) this.child = null;
      if (!this.wanted) return;
      this.failures = Date.now() - started > 60_000 ? 1 : this.failures + 1;
      const wait = Math.min(60_000, 2000 * 2 ** Math.min(this.failures - 1, 5));
      if (this.failures <= 2 || this.failures % 5 === 0) this.log(`Remote Desktop (x11vnc) stopped${why ? `: ${why}` : ""}; starting it again in ${Math.round(wait / 1000)}s`);
      this.retry = setTimeout(() => this.spawn(rd), wait);
    };
    child.on("error", (e) => again(e.message));
    child.on("exit", () => again(err.trim().split("\n").pop() ?? ""));
  }

  stop() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.child?.kill();
    this.child = null;
  }
}

// --- setting it up, at the device ------------------------------------------------------------------

export interface SetupIO {
  ask(question: string): Promise<boolean>;
  /** run a command with the terminal attached (sudo and installers can ask things) */
  run(cmd: string, args: string[]): boolean;
  say(line: string): void;
}

/** Can Remote Desktop be set up on this device, and if not, why. */
export function remoteDesktopSupport(): { ok: boolean; detail: string } {
  if (process.platform === "darwin") return { ok: false, detail: "Remote Desktop isn't ready on Macs yet: live view uses screenshots, and your code still protects this screen." };
  if (process.platform === "win32") return { ok: true, detail: "TightVNC, as a Windows service" };
  if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return { ok: false, detail: "Remote Desktop needs an X11 session; Wayland isn't supported yet." };
  if (!process.env.DISPLAY) return { ok: false, detail: "There's no display here." };
  return { ok: true, detail: "x11vnc" };
}

/** The command that installs a package with this Linux's package manager. */
async function linuxInstall(pkg: string): Promise<[string, string[]] | null> {
  const sudo = process.getuid?.() === 0 ? [] : ["sudo"];
  const withSudo = (args: string[]): [string, string[]] => (sudo.length ? ["sudo", args] : [args[0], args.slice(1)]);
  if (await has("apt-get")) return withSudo(["apt-get", "install", "-y", pkg]);
  if (await has("dnf")) return withSudo(["dnf", "install", "-y", pkg]);
  if (await has("pacman")) return withSudo(["pacman", "-S", "--noconfirm", pkg]);
  if (await has("zypper")) return withSudo(["zypper", "--non-interactive", "install", pkg]);
  return null;
}

/** TightVNC's installer settings: VNC password on, this device only, no web viewer, on our port. */
export function tightVncMsiArgs(rd: RemoteDesktopConfig): string[] {
  const set = (name: string, value: string | number) => [`SET_${name}=1`, `VALUE_OF_${name}=${value}`];
  return [
    "/quiet",
    "/norestart",
    "ADDLOCAL=Server",
    ...set("USEVNCAUTHENTICATION", 1),
    ...set("PASSWORD", rd.password),
    ...set("ALLOWLOOPBACK", 1),
    ...set("LOOPBACKONLY", 1),
    ...set("ACCEPTHTTPCONNECTIONS", 0),
    ...set("RFBPORT", rd.port),
  ];
}

/**
 * Install or switch on the VNC server for this OS, asking first. Returns its config, or null when
 * it couldn't be set up (the reason was said).
 */
export async function setUpRemoteDesktop(dir: string, io: SetupIO): Promise<RemoteDesktopConfig | null> {
  const support = remoteDesktopSupport();
  if (!support.ok) {
    io.say(`   ${support.detail}`);
    return null;
  }

  if (process.platform === "win32") {
    const installed = (await exec("sc", ["query", "tvnserver"]).catch(() => null))?.code === 0;
    if (installed) {
      io.say("   TightVNC is already installed here with its own settings, so Warren leaves it alone.");
      io.say("   To let Warren set it up: uninstall TightVNC (Settings → Apps), then run `warren node screen remote` again.");
      return null;
    }
    if (!(await has("winget"))) {
      io.say("   Warren installs TightVNC with winget, which isn't here. Install \"App Installer\" from the Microsoft Store, then run `warren node screen remote` again.");
      return null;
    }
    io.say("   TightVNC is a free, open-source VNC server. Warren sets it to listen on this computer only.");
    if (!(await io.ask("   Install it now? Windows asks for permission once."))) return null;
    const rd = newRemoteDesktop("tightvnc");
    if (!io.run("winget", ["install", "--id", "GlavSoft.TightVNC", "--exact", "--override", tightVncMsiArgs(rd).join(" ")])) {
      io.say("   The install didn't finish. Run `warren node screen remote` to try again.");
      return null;
    }
    for (let i = 0; i < 10 && !(await listening(rd.port)); i++) await new Promise((r) => setTimeout(r, 1000));
    if (!(await listening(rd.port))) {
      io.say("   TightVNC is installed but isn't answering yet. Restart this computer, then check with `warren doctor`.");
    }
    return rd;
  }

  // Linux (X11)
  if (!(await has("x11vnc"))) {
    const cmd = await linuxInstall("x11vnc");
    if (!cmd) {
      io.say("   Install x11vnc with your package manager, then run `warren node screen remote` again.");
      return null;
    }
    io.say("   x11vnc is a free, open-source VNC server. Warren runs it for this screen, on this computer only.");
    if (!(await io.ask(`   Install it now (${[cmd[0], ...cmd[1]].join(" ")})?`))) return null;
    if (!io.run(cmd[0], cmd[1]) || !(await has("x11vnc"))) {
      io.say("   x11vnc didn't install. Run `warren node screen remote` to try again.");
      return null;
    }
  }
  const rd = newRemoteDesktop("x11vnc");
  // a quick start, so a problem shows here rather than later in the device's log
  const passFile = path.join(dir, "remote-desktop.pass");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(passFile, `${rd.password}\n`, { mode: 0o600 });
  const trial = spawn("x11vnc", x11vncArgs(rd, passFile, process.env.DISPLAY ?? ":0"), { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  trial.stderr?.setEncoding("utf8");
  trial.stderr?.on("data", (c: string) => (err = (err + c).slice(-2000)));
  let up = false;
  for (let i = 0; i < 8 && !up && trial.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await listening(rd.port, 500);
  }
  trial.kill();
  if (!up) {
    io.say(`   x11vnc didn't start${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""}.`);
    return null;
  }
  return rd;
}
