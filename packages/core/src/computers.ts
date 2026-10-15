import { z } from "zod";

/**
 * Agents work on computers, like people do. A computer is one of:
 *   device  the screen of a device running `warren node` (a laptop, a desktop, a server with a display)
 *   vm      a virtual computer that a device runs for its agents (a Linux desktop in Docker)
 *   orgo    a cloud computer from orgo.ai
 * Several agents can share one computer (its files, browser and sign-ins), and people can watch
 * it live and take control.
 */
export type ComputerKind = "device" | "vm" | "orgo";

export interface VmConfig {
  /** container image; default is the one Warren builds from docker/computer */
  image?: string;
  /** screen size, e.g. "1280x800" */
  resolution?: string;
  cpus?: number;
  memoryGb?: number;
}

export interface OrgoConfig {
  /** Orgo computer UUID */
  computerId: string;
  /** used for its VNC address */
  instanceId?: string;
  ram?: number;
  cpu?: number;
}

export interface DeviceConfig {
  /** a VNC server already running on the device (e.g. macOS Screen Sharing), for smoother live view */
  vncPort?: number;
  /**
   * A device's own screen is its owner's. Agents may use it only while the owner lends it to them
   * (until `until`, or until they stop when `until` is null), and only for things the owner asked for.
   */
  lend?: { until: string | null };
  /**
   * An agent borrowing this screen (a person approved its request). Only that agent can use it,
   * only until `until`; the owner can take it back at any moment.
   */
  loan?: DeviceLoan;
}

/** The longest a screen is lent to one agent, even when the owner picks "until it hands it back". */
export const LOAN_MAX_MINUTES = 12 * 60;

export interface DeviceLoan {
  agentId: string;
  /** when it ends; a loan never outlives this */
  until: string;
  since: string;
  /** who approved it (the device's owner) */
  approvedBy: string;
  approvalId: string;
  /** where the agent was working, so it can be told when the loan ends */
  channelId: string;
  threadId: string | null;
  /** the person the agent was working for */
  requestedBy: string | null;
}

/** What an agent asked for with `device_request`; kept on the approval card. */
export interface DeviceLoanRequest {
  nodeId: string;
  deviceName: string;
  /** the device's owner: the only one who can decide */
  ownerId: string;
  /** what the agent needs it for */
  reason: string;
  channelId: string;
  threadId: string | null;
  requestedBy: string | null;
}

export type ComputerConfig = VmConfig & Partial<OrgoConfig> & DeviceConfig;

export type ComputerStatus = "ready" | "starting" | "stopped" | "offline" | "error";

export interface ComputerController {
  kind: "user";
  id: string;
  since: string;
}

export interface Computer {
  id: string;
  workspaceId: string;
  name: string;
  kind: ComputerKind;
  /** the device it runs on (its own screen, or the VM host); null for cloud computers */
  nodeId: string | null;
  config: ComputerConfig;
  status: ComputerStatus;
  statusText: string;
  /** a person who took control; while set, agents wait */
  controller: ComputerController | null;
  /** an agent's open request for a person ("Sign in to Zendesk"), until someone hands the computer back */
  help: { agentId: string; request: string; channelId: string; threadId: string | null; at: string } | null;
  createdAt: string;
}

/** What a device can offer as computers, reported when it connects. */
export const DeviceCapabilities = z.object({
  platform: z.string(),
  arch: z.string(),
  /** can agents see and use this device's own screen? `off`: it could, but it's turned off at the device (the default) */
  screen: z.object({ ok: z.boolean(), detail: z.string().max(500), off: z.boolean().optional() }),
  /** can this device run VMs for its agents? `engine`: what runs them; `image`: whether the VM image is here yet */
  vm: z.object({
    ok: z.boolean(),
    detail: z.string().max(500),
    engine: z.string().max(60).optional(),
    image: z.enum(["ready", "preparing", "missing", "failed"]).optional(),
  }),
  /** someone ran `warren node pause` on the device: no agent runs and no computer use until they resume */
  paused: z.boolean().optional(),
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilities>;

const coord = z.number().finite().min(0).max(100_000);
/** The size of the image the coordinates refer to. Unset: the computer's own screen pixels. */
const Space = z.object({ width: z.number().int().positive().max(100_000), height: z.number().int().positive().max(100_000) });
export const MouseButton = z.enum(["left", "right", "middle"]);
export const ScrollDirection = z.enum(["up", "down", "left", "right"]);

export const ComputerAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("click"), x: coord, y: coord, button: MouseButton.optional(), double: z.boolean().optional(), space: Space.optional() }),
  z.object({ action: z.literal("move"), x: coord, y: coord, space: Space.optional() }),
  /** press or release a button where the pointer is (live view drags) */
  z.object({ action: z.literal("mouse"), x: coord, y: coord, button: MouseButton.optional(), down: z.boolean(), space: Space.optional() }),
  z.object({ action: z.literal("drag"), x: coord, y: coord, toX: coord, toY: coord, space: Space.optional() }),
  z.object({ action: z.literal("scroll"), x: coord, y: coord, direction: ScrollDirection, amount: z.number().int().min(1).max(50).optional(), space: Space.optional() }),
  z.object({ action: z.literal("type"), text: z.string().max(10_000) }),
  /** a key or combination, e.g. "Enter", "ctrl+l", "cmd+shift+t" */
  z.object({ action: z.literal("key"), keys: z.string().min(1).max(100) }),
  /** a shell command on the computer (VMs and cloud computers) */
  z.object({ action: z.literal("run"), command: z.string().min(1).max(20_000), timeout: z.number().int().min(1).max(600).optional() }),
  /** open a URL, file or app the way double-clicking it would */
  z.object({ action: z.literal("open"), target: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("status") }),
  /** remove a VM and its disk for good */
  z.object({ action: z.literal("destroy") }),
  /** is this harness signed in inside the VM? → { signedIn: boolean | null } */
  z.object({ action: z.literal("harness_status"), harness: z.string().max(60) }),
  /** open a terminal on the VM's screen that signs this harness in; a person finishes it there */
  z.object({ action: z.literal("signin"), harness: z.string().max(60) }),
  /** the web page element at a point on the screen (VMs' browser), for recordings → { element: PageElement | null } */
  z.object({ action: z.literal("inspect"), x: coord, y: coord, space: Space.optional() }),
]);
export type ComputerAction = z.infer<typeof ComputerAction>;

export interface Screenshot {
  /** base64 JPEG */
  image: string;
  mime: string;
  /** size of the image */
  width: number;
  height: number;
}

export interface RunOutput {
  exitCode: number;
  output: string;
}

/** Is a device's screen lent to agents right now? */
export function lentNow(c: Pick<Computer, "kind" | "config">, at = Date.now()): boolean {
  if (c.kind !== "device") return true;
  const lend = (c.config as DeviceConfig).lend;
  if (!lend) return false;
  return lend.until === null || new Date(lend.until).getTime() > at;
}

/** The loan on a device's screen if it is still running, else null. */
export function activeLoan(c: Pick<Computer, "kind" | "config">, at = Date.now()): DeviceLoan | null {
  if (c.kind !== "device") return null;
  const loan = (c.config as DeviceConfig).loan;
  return loan && new Date(loan.until).getTime() > at ? loan : null;
}

/** Screenshots for agents are scaled to fit this box: big enough to read, small enough to be cheap. */
export const AGENT_SCREEN = { width: 1280, height: 800 };

/** The size an image of a `w`×`h` screen gets when scaled down to fit `box` (never up). */
export function fitInto(w: number, h: number, box = AGENT_SCREEN): { width: number; height: number } {
  const s = Math.min(1, box.width / w, box.height / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Map a point in `space` (e.g. the screenshot the agent saw) onto a screen of `screen` size. */
export function toScreen(x: number, y: number, space: { width: number; height: number } | undefined, screen: { width: number; height: number }) {
  if (!space) return { x: Math.round(x), y: Math.round(y) };
  return { x: Math.round((x * screen.width) / space.width), y: Math.round((y * screen.height) / space.height) };
}

// --- keys ------------------------------------------------------------------------------------

export type Modifier = "ctrl" | "alt" | "shift" | "meta";

/** A key combination, normalized: modifiers plus one key name ("Enter", "a", "F5", "Up"). */
export interface KeyCombo {
  mods: Modifier[];
  key: string;
}

const MOD_ALIASES: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  windows: "meta",
};

const KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  kp_enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  back_space: "Backspace",
  delete: "Delete",
  del: "Delete",
  space: "Space",
  " ": "Space",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  page_up: "PageUp",
  prior: "PageUp",
  pagedown: "PageDown",
  page_down: "PageDown",
  next: "PageDown",
  insert: "Insert",
  capslock: "CapsLock",
  caps_lock: "CapsLock",
  plus: "+",
  minus: "-",
};

const MOD_KEY: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };

/** Parse "cmd+shift+t", "ctrl-c", "Return" or "ctrl++" into a combo. Throws on nonsense. */
export function parseKeys(input: string): KeyCombo {
  const norm = input.trim().replace(/\+\+$/, "+plus");
  if (norm === "+" || norm === "-") return { mods: [], key: norm };
  const parts = norm.split(/\s*\+\s*|(?<=[a-z])-(?=\w)/i).filter((p) => p !== "");
  if (!parts.length) throw new Error("no key given");
  const mods: Modifier[] = [];
  for (const raw of parts.slice(0, -1)) {
    const mod = MOD_ALIASES[raw.toLowerCase()];
    if (!mod) throw new Error(`"${raw}" in "${input}" isn't ctrl, alt, shift or cmd`);
    if (!mods.includes(mod)) mods.push(mod);
  }
  const last = parts[parts.length - 1];
  const lower = last.toLowerCase();
  const asMod = MOD_ALIASES[lower];
  // a lone modifier ("shift") is a press of that key
  let key = asMod ? MOD_KEY[asMod] : (KEY_ALIASES[lower] ?? (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower) ? lower.toUpperCase() : last.length === 1 ? last : null));
  if (!key) throw new Error(`unknown key "${last}"`);
  // ctrl+C means ctrl+c; shift is its own modifier
  if (mods.length && key.length === 1) key = key.toLowerCase();
  return { mods, key };
}

/** X11 keysym for a normalized key name (xdotool and Orgo both take these). */
export function x11Key(key: string): string {
  const map: Record<string, string> = {
    Enter: "Return",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "BackSpace",
    Delete: "Delete",
    Space: "space",
    Up: "Up",
    Down: "Down",
    Left: "Left",
    Right: "Right",
    Home: "Home",
    End: "End",
    PageUp: "Prior",
    PageDown: "Next",
    Insert: "Insert",
    CapsLock: "Caps_Lock",
    Ctrl: "Control_L",
    Alt: "Alt_L",
    Shift: "Shift_L",
    Meta: "Super_L",
    "+": "plus",
    "-": "minus",
    ".": "period",
    ",": "comma",
    "/": "slash",
    "\\": "backslash",
    ";": "semicolon",
    "'": "apostrophe",
    "[": "bracketleft",
    "]": "bracketright",
    "`": "grave",
    "=": "equal",
  };
  return map[key] ?? key;
}

/** "ctrl+shift+t" as an X11 combo string: "ctrl+shift+t", with Super for meta. */
export function x11Combo(c: KeyCombo): string {
  return [...c.mods.map((m) => (m === "meta" ? "super" : m)), x11Key(c.key)].join("+");
}
