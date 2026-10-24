import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fitInto, type KeyCombo } from "@wisp/core";
import { ActionError, cached, exec, must, type Button, type Direction, type Driver, type Shot, type Size } from "./driver.ts";

/**
 * The Mac's own screen. Screenshots with `screencapture`, resized with `sips`; the mouse through
 * CoreGraphics events and the keyboard through System Events, both from JavaScript for
 * Automation (osascript), so nothing extra needs installing. The app running `wisp node`
 * needs Screen Recording and Accessibility permission (System Settings → Privacy & Security).
 */

/** JXA that performs one input op given as JSON. Coordinates are in points. */
const INPUT_SCRIPT = String.raw`
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
function run(argv) {
  const op = JSON.parse(argv[0]);
  if (op.op === "size") {
    const f = $.NSScreen.mainScreen.frame;
    return JSON.stringify({ width: f.size.width, height: f.size.height, trusted: $.AXIsProcessTrusted() });
  }
  if (!$.AXIsProcessTrusted()) throw new Error("NO_ACCESSIBILITY");
  const src = $.CGEventSourceCreate(1);
  const post = (e) => $.CGEventPost(0, e);
  const BTN = { left: [1, 2, 0, 6], right: [3, 4, 1, 7], middle: [25, 26, 2, 27] };
  const mouse = (type, x, y, button, clicks) => {
    const e = $.CGEventCreateMouseEvent(src, type, $.CGPointMake(x, y), button);
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
    post(e);
  };
  const pause = (s) => delay(s);
  const b = BTN[op.button || "left"];
  switch (op.op) {
    case "move": mouse(5, op.x, op.y, 0); break;
    case "click":
      mouse(5, op.x, op.y, 0);
      for (let i = 1; i <= op.count; i++) { mouse(b[0], op.x, op.y, b[2], i); mouse(b[1], op.x, op.y, b[2], i); if (i < op.count) pause(0.05); }
      break;
    case "mouse": mouse(op.down ? b[0] : b[1], op.x, op.y, b[2], 1); break;
    case "drag": {
      mouse(5, op.x, op.y, 0);
      mouse(1, op.x, op.y, 0, 1);
      const steps = 12;
      for (let i = 1; i <= steps; i++) { mouse(6, op.x + ((op.toX - op.x) * i) / steps, op.y + ((op.toY - op.y) * i) / steps, 0); pause(0.015); }
      mouse(2, op.toX, op.toY, 0, 1);
      break;
    }
    case "scroll": {
      mouse(5, op.x, op.y, 0);
      const dy = op.direction === "up" ? op.amount : op.direction === "down" ? -op.amount : 0;
      const dx = op.direction === "left" ? op.amount : op.direction === "right" ? -op.amount : 0;
      post($.CGEventCreateScrollWheelEvent2(src, 1, 2, dy, dx, 0));
      break;
    }
    case "keys": {
      const se = Application("System Events");
      const using = op.mods.map((m) => ({ ctrl: "control down", alt: "option down", shift: "shift down", meta: "command down" })[m]);
      if (op.code !== null) se.keyCode(op.code, { using });
      else se.keystroke(op.char, { using });
      break;
    }
    case "text": {
      const se = Application("System Events");
      for (const piece of op.pieces) {
        if (piece.code !== undefined) se.keyCode(piece.code);
        else se.keystroke(piece.text);
      }
      break;
    }
  }
  return "ok";
}`;

/** macOS virtual key codes for keys that aren't characters. */
const KEY_CODES: Record<string, number> = {
  Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121,
  Left: 123, Right: 124, Down: 125, Up: 126, CapsLock: 57, Ctrl: 59, Alt: 58, Shift: 56, Meta: 55,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

/** Split text into keystroke runs and Return/Tab presses. Exported for tests. */
export function textPieces(text: string): ({ text: string } | { code: number })[] {
  const out: ({ text: string } | { code: number })[] = [];
  for (const part of text.replace(/\r\n?/g, "\n").split(/([\n\t])/)) {
    if (part === "\n") out.push({ code: KEY_CODES.Enter });
    else if (part === "\t") out.push({ code: KEY_CODES.Tab });
    else if (part) out.push({ text: part });
  }
  return out;
}

const NEEDS_ACCESS = "Wisp needs Accessibility permission to use this Mac's mouse and keyboard: System Settings → Privacy & Security → Accessibility → turn on the app that runs `wisp node` (e.g. Terminal), then try again.";

export class MacDesktop implements Driver {
  readonly label = "this Mac";
  readonly screenSize: () => Promise<Size>;

  constructor() {
    this.screenSize = cached(10_000, async () => {
      const r = JSON.parse((await this.jxa({ op: "size" })).trim());
      return { width: Math.round(r.width), height: Math.round(r.height) };
    });
  }

  private async jxa(op: object): Promise<string> {
    const r = await exec("osascript", ["-l", "JavaScript", "-e", INPUT_SCRIPT, JSON.stringify(op)], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (/NO_ACCESSIBILITY|not allowed assistive access|1002|-25211/.test(r.stderr)) throw new ActionError(NEEDS_ACCESS);
      throw new ActionError(r.stderr.trim().split("\n").pop() || "osascript failed");
    }
    return r.stdout.toString();
  }

  async screenshot(box: Size = { width: 1280, height: 800 }): Promise<Shot> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-shot-"));
    const raw = path.join(dir, "raw.jpg");
    const out = path.join(dir, "out.jpg");
    try {
      // -x no sound, -C include the cursor, -m main display only
      await must("screencapture", ["-x", "-C", "-m", "-t", "jpg", raw], { timeoutMs: 20_000 });
      const info = (await must("sips", ["-g", "pixelWidth", "-g", "pixelHeight", raw])).toString();
      const w = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1]);
      const h = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1]);
      if (!w || !h) throw new ActionError("couldn't read the screenshot");
      const fit = fitInto(w, h, box);
      await must("sips", ["-z", String(fit.height), String(fit.width), "-s", "format", "jpeg", "-s", "formatOptions", "70", raw, "--out", out]);
      return { jpeg: await fs.readFile(out), ...fit };
    } catch (err) {
      if (/could not create image|not authorized|screen recording/i.test((err as Error).message))
        throw new ActionError("Wisp needs Screen Recording permission to see this Mac's screen: System Settings → Privacy & Security → Screen Recording → turn on the app that runs `wisp node`.");
      throw err;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async move(x: number, y: number) {
    await this.jxa({ op: "move", x, y });
  }
  async click(x: number, y: number, button: Button, count: number) {
    await this.jxa({ op: "click", x, y, button, count });
  }
  async mouse(x: number, y: number, button: Button, down: boolean) {
    await this.jxa({ op: "mouse", x, y, button, down });
  }
  async drag(x: number, y: number, toX: number, toY: number) {
    await this.jxa({ op: "drag", x, y, toX, toY });
  }
  async scroll(x: number, y: number, direction: Direction, amount: number) {
    await this.jxa({ op: "scroll", x, y, direction, amount });
  }

  async type(text: string) {
    // System Events types what's on the keyboard layout; anything else (emoji, accents) goes in by pasting
    if (/^[\x20-\x7e\n\t\r]*$/.test(text)) {
      for (let i = 0; i < text.length; i += 500) await this.jxa({ op: "text", pieces: textPieces(text.slice(i, i + 500)) });
      return;
    }
    const saved = await exec("pbpaste", []).then((r) => r.stdout, () => null);
    await must("pbcopy", [], { input: text });
    await this.jxa({ op: "keys", mods: ["meta"], code: null, char: "v" });
    await new Promise((r) => setTimeout(r, 300));
    if (saved) await exec("pbcopy", [], { input: saved });
  }

  async key(c: KeyCombo) {
    const code = KEY_CODES[c.key] ?? null;
    if (code === null && c.key.length !== 1) throw new ActionError(`can't press "${c.key}" on a Mac`);
    await this.jxa({ op: "keys", mods: c.mods, code, char: code === null ? c.key : "" });
  }

  async open(target: string) {
    // URLs and paths open with their default app; a bare name like "Safari" is an app
    const app = !/^[a-z][a-z0-9+.-]*:|^[/~.]/i.test(target);
    await must("open", app ? ["-a", target] : [target.replace(/^~(?=\/)/, os.homedir())], { timeoutMs: 30_000 });
  }

}
