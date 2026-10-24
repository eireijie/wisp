import { execFile, spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import { AGENT_SCREEN, MAX_TRANSFER_BYTES, parseKeys, toScreen, type ComputerAction, type FileData, type KeyCombo, type PageElement, type RunOutput, type Screenshot } from "@wisp/core";
import type { Clipboard, Files } from "./transfer.ts";

export interface Size {
  width: number;
  height: number;
}

export type Button = "left" | "right" | "middle";
export type Direction = "up" | "down" | "left" | "right";

/** A JPEG of the screen, already scaled to fit the requested box. */
export interface Shot {
  jpeg: Buffer;
  width: number;
  height: number;
}

/**
 * One computer's screen, mouse and keyboard. Coordinates are in the computer's own input space
 * (points on macOS, pixels elsewhere); `screenSize` reports that space.
 */
export interface Driver {
  readonly label: string;
  screenSize(): Promise<Size>;
  screenshot(box?: Size): Promise<Shot>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: Button, count: number): Promise<void>;
  mouse(x: number, y: number, button: Button, down: boolean): Promise<void>;
  drag(x: number, y: number, toX: number, toY: number): Promise<void>;
  scroll(x: number, y: number, direction: Direction, amount: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: KeyCombo): Promise<void>;
  open(target: string): Promise<void>;
  /** a shell command on the computer; undefined where agents use their own shell */
  run?(command: string, timeoutSec: number): Promise<RunOutput>;
  start?(onStatus?: (text: string) => void): Promise<void>;
  stop?(): Promise<void>;
  destroy?(): Promise<void>;
  status?(): Promise<{ status: "ready" | "stopped" | "starting" | "error"; detail: string }>;
  /** a connection to its VNC server, for smooth live view; absent = live view uses screenshots */
  vnc?(): Promise<Duplex>;
  /** VMs: whether a harness that comes with the VM is signed in there (null: it doesn't come with it) */
  signedIn?(harness: string): Promise<boolean | null>;
  /** VMs: open a terminal on the screen that signs a harness in */
  openSignIn?(harness: string): Promise<void>;
  /** VMs: the web page element under a screen point, in the browser people see */
  inspectAt?(x: number, y: number): Promise<PageElement | null>;
  /** its clipboard, to copy and paste between it and people's devices */
  clipboard?: Clipboard;
  /** its files, to move them between it and people's devices */
  files?: Files;
}

export class ActionError extends Error {}

/** Do one action on a driver. Coordinates arrive in the space of the screenshot the caller saw. */
export async function perform(driver: Driver, a: ComputerAction): Promise<unknown> {
  const at = async (x: number, y: number, space?: Size) => toScreen(x, y, space, space ? await driver.screenSize() : { width: 0, height: 0 });
  switch (a.action) {
    case "screenshot": {
      const shot = await driver.screenshot(AGENT_SCREEN);
      return { image: shot.jpeg.toString("base64"), mime: "image/jpeg", width: shot.width, height: shot.height } satisfies Screenshot;
    }
    case "click": {
      const p = await at(a.x, a.y, a.space);
      await driver.click(p.x, p.y, a.button ?? "left", a.double ? 2 : 1);
      return { ok: true };
    }
    case "move": {
      const p = await at(a.x, a.y, a.space);
      await driver.move(p.x, p.y);
      return { ok: true };
    }
    case "mouse": {
      const p = await at(a.x, a.y, a.space);
      await driver.mouse(p.x, p.y, a.button ?? "left", a.down);
      return { ok: true };
    }
    case "drag": {
      const [p, q] = await Promise.all([at(a.x, a.y, a.space), at(a.toX, a.toY, a.space)]);
      await driver.drag(p.x, p.y, q.x, q.y);
      return { ok: true };
    }
    case "scroll": {
      const p = await at(a.x, a.y, a.space);
      await driver.scroll(p.x, p.y, a.direction, a.amount ?? 3);
      return { ok: true };
    }
    case "type":
      await driver.type(a.text);
      return { ok: true };
    case "key": {
      let combo: KeyCombo;
      try {
        combo = parseKeys(a.keys);
      } catch (err) {
        throw new ActionError((err as Error).message);
      }
      await driver.key(combo);
      return { ok: true };
    }
    case "open":
      await driver.open(a.target);
      return { ok: true };
    case "run":
      if (!driver.run) throw new ActionError(`${driver.label} doesn't take shell commands from Wisp; use your own shell tool`);
      return driver.run(a.command, a.timeout ?? 120);
    case "start":
      await driver.start?.();
      return driver.status ? driver.status() : { status: "ready", detail: "" };
    case "stop":
      if (!driver.stop) throw new ActionError(`${driver.label} can't be stopped from Wisp`);
      await driver.stop();
      return { ok: true };
    case "destroy":
      await driver.destroy?.();
      return { ok: true };
    case "status":
      return driver.status ? driver.status() : { status: "ready", detail: "" };
    case "harness_status":
      return { signedIn: driver.signedIn ? await driver.signedIn(a.harness) : null };
    case "signin":
      if (!driver.openSignIn) throw new ActionError(`${driver.label} can't sign harnesses in`);
      await driver.openSignIn(a.harness);
      return { ok: true };
    case "inspect": {
      if (!driver.inspectAt) return { element: null };
      const p = await at(a.x, a.y, a.space);
      return { element: await driver.inspectAt(p.x, p.y).catch(() => null) };
    }
    case "clipboard_get":
      return { text: await clipboardOf(driver).get() };
    case "clipboard_set":
      await clipboardOf(driver).set(a.text);
      return { ok: true };
    case "files_list":
      return filesOf(driver).list(a.path);
    case "file_read": {
      const f = await filesOf(driver).read(a.path);
      return { name: f.name, size: f.data.length, data: f.data.toString("base64") } satisfies FileData;
    }
    case "file_write": {
      const data = Buffer.from(a.data, "base64");
      if (data.length > MAX_TRANSFER_BYTES) throw new ActionError(`files bigger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB can't be sent`);
      return { path: await filesOf(driver).write(a.folder, a.name, data) };
    }
    case "file_mkdir":
      return { path: await filesOf(driver).mkdir(a.folder, a.name) };
  }
}

function clipboardOf(driver: Driver): Clipboard {
  if (!driver.clipboard) throw new ActionError(`${driver.label} can't share its clipboard`);
  return driver.clipboard;
}

function filesOf(driver: Driver): Files {
  if (!driver.files) throw new ActionError(`${driver.label} can't share its files`);
  return driver.files;
}

// --- process helpers ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Run a command to completion and collect its output; never throws for a non-zero exit. */
export function exec(cmd: string, args: string[], opts: { input?: string | Buffer; timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (err = (err + c).slice(-8000)));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? -1 : (code ?? -1), stdout: Buffer.concat(out), stderr: killed ? `${err}\n(timed out)`.trim() : err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** exec, but a non-zero exit is an error carrying the last line of stderr. */
export async function must(cmd: string, args: string[], opts: Parameters<typeof exec>[2] = {}): Promise<Buffer> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw new ActionError(r.stderr.trim().split("\n").pop() || `${cmd} exited with code ${r.code}`);
  return r.stdout;
}

/** Is this binary on PATH? */
export function has(binary: string): Promise<boolean> {
  return new Promise((resolve) => execFile(process.platform === "win32" ? "where" : "which", [binary], (err) => resolve(!err)));
}

/** Width and height from a JPEG's frame header. */
export function jpegSize(buf: Buffer): Size | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** Caches a value for `ms`. */
export function cached<T>(ms: number, load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  let at = 0;
  return () => {
    if (!value || Date.now() - at > ms) {
      at = Date.now();
      value = load().catch((e) => {
        value = null;
        throw e;
      });
    }
    return value;
  };
}
