import { x11Combo, type KeyCombo, type RunOutput } from "@wisp/core";
import { ActionError, cached, jpegSize, type Button, type Direction, type Driver, type ExecResult, type Shot, type Size } from "./driver.ts";

/** Runs a command where the X display is (locally, or inside a VM). */
export type Runner = (argv: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>;

const BUTTON: Record<Button, string> = { left: "1", middle: "2", right: "3" };
const WHEEL: Record<Direction, string> = { up: "4", down: "5", left: "6", right: "7" };

/** xdotool arguments for each input. Exported for tests. */
export const xdo = {
  move: (x: number, y: number) => ["mousemove", String(x), String(y)],
  click: (x: number, y: number, b: Button, count: number) => ["mousemove", String(x), String(y), "click", "--repeat", String(count), "--delay", "80", BUTTON[b]],
  mouse: (x: number, y: number, b: Button, down: boolean) => ["mousemove", String(x), String(y), down ? "mousedown" : "mouseup", BUTTON[b]],
  drag: (x: number, y: number, toX: number, toY: number) => [
    "mousemove", String(x), String(y), "mousedown", "1", "sleep", "0.1",
    "mousemove", String(Math.round((x + toX) / 2)), String(Math.round((y + toY) / 2)), "sleep", "0.1",
    "mousemove", String(toX), String(toY), "sleep", "0.1", "mouseup", "1",
  ],
  scroll: (x: number, y: number, d: Direction, amount: number) => ["mousemove", String(x), String(y), "click", "--repeat", String(amount), "--delay", "30", WHEEL[d]],
  type: (text: string) => ["type", "--delay", "12", "--", text],
  key: (c: KeyCombo) => ["key", "--clearmodifiers", "--", x11Combo(c)],
};

/**
 * An X11 desktop driven with xdotool and captured with ImageMagick's `import`: a Linux
 * device's own screen, or the desktop inside a VM.
 */
export class X11Driver implements Driver {
  readonly screenSize: () => Promise<Size>;

  constructor(
    readonly label: string,
    private sh: Runner,
    private shell?: (command: string, timeoutSec: number) => Promise<RunOutput>,
  ) {
    this.screenSize = cached(10_000, async () => {
      const r = await this.ok(["xdotool", "getdisplaygeometry"]);
      const [w, h] = r.toString().trim().split(/\s+/).map(Number);
      if (!w || !h) throw new ActionError("couldn't read the screen size");
      return { width: w, height: h };
    });
    if (shell) this.run = shell;
  }

  run?: (command: string, timeoutSec: number) => Promise<RunOutput>;

  private async ok(argv: string[], input?: string): Promise<Buffer> {
    const r = await this.sh(argv, { input, timeoutMs: 30_000 });
    if (r.code !== 0) throw new ActionError(r.stderr.trim().split("\n").pop() || `${argv[0]} failed (${r.code})`);
    return r.stdout;
  }

  async screenshot(box: Size = { width: 1280, height: 800 }): Promise<Shot> {
    const jpeg = await this.ok(["import", "-silent", "-window", "root", "-resize", `${box.width}x${box.height}>`, "-quality", "70", "jpg:-"]);
    const size = jpegSize(jpeg);
    if (!size) throw new ActionError("the screenshot wasn't a JPEG");
    return { jpeg, ...size };
  }

  async move(x: number, y: number) {
    await this.ok(["xdotool", ...xdo.move(x, y)]);
  }
  async click(x: number, y: number, b: Button, count: number) {
    await this.ok(["xdotool", ...xdo.click(x, y, b, count)]);
  }
  async mouse(x: number, y: number, b: Button, down: boolean) {
    await this.ok(["xdotool", ...xdo.mouse(x, y, b, down)]);
  }
  async drag(x: number, y: number, toX: number, toY: number) {
    await this.ok(["xdotool", ...xdo.drag(x, y, toX, toY)]);
  }
  async scroll(x: number, y: number, d: Direction, amount: number) {
    await this.ok(["xdotool", ...xdo.scroll(x, y, d, amount)]);
  }
  async type(text: string) {
    // long text goes in chunks so one call never runs into the timeout
    for (let i = 0; i < text.length; i += 400) await this.ok(["xdotool", ...xdo.type(text.slice(i, i + 400))]);
  }
  async key(c: KeyCombo) {
    await this.ok(["xdotool", ...xdo.key(c)]);
  }
  async open(target: string) {
    // detached, so a browser that stays open doesn't hold the call
    await this.ok(["sh", "-c", 'nohup xdg-open "$1" >/dev/null 2>&1 &', "open", target]);
  }
}
