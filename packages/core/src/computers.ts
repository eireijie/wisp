import { z } from "zod";

/**
 * Agents work on computers, like people do. A computer is one of:
 *   device  the screen of a device running `wisp node` (a laptop, a desktop, a server with a display)
 *   vm      a virtual computer that a device runs for its agents (a Linux desktop in Docker)
 *   orgo    a cloud computer from orgo.ai
 * Several agents can share one computer (its files, browser and sign-ins), and people can watch
 * it live and take control.
 */
export type ComputerKind = "device" | "vm" | "orgo";

export interface VmConfig {
  /** container image; default is the one Wisp builds from docker/computer */
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
  screen: z.object({
    ok: z.boolean(),
    detail: z.string().max(500),
    off: z.boolean().optional(),
    /** Remote Desktop is set up at the device: live view goes through its own VNC server */
    remote: z.boolean().optional(),
    /** opening the screen from Wisp needs the code picked at the device (a 6-digit PIN or a password) */
    code: z.enum(["pin", "password"]).optional(),
  }),
  /** can this device run VMs for its agents? `engine`: what runs them; `image`: whether the VM image is here yet */
  vm: z.object({
    ok: z.boolean(),
    detail: z.string().max(500),
    engine: z.string().max(60).optional(),
    image: z.enum(["ready", "preparing", "missing", "failed"]).optional(),
  }),
  /** someone ran `wisp node pause` on the device: no agent runs and no computer use until they resume */
  paused: z.boolean().optional(),
  /** which commands connectors need are on the device's PATH (npx, uvx, docker…), so a connector that can't start is caught before it's enabled */
  commands: z.record(z.string().max(100), z.boolean()).optional(),
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilities>;

const coord = z.number().finite().min(0).max(100_000);
/** The size of the image the coordinates refer to. Unset: the computer's own screen pixels. */
const Space = z.object({ width: z.number().int().positive().max(100_000), height: z.number().int().positive().max(100_000) });
export const MouseButton = z.enum(["left", "right", "middle"]);
export const ScrollDirection = z.enum(["up", "down", "left", "right"]);

/** The biggest file moved to or from a computer in one go. */
export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

/** A file or folder name: one path segment. */
export const FileName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !/[/\\\0]/.test(n) && n !== "." && n !== "..", "a name can't contain / or \\, or be . or ..");

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
  // --- keeping a computer in step with yours: its clipboard and files ---
  /** the text on its clipboard → { text } */
  z.object({ action: z.literal("clipboard_get") }),
  z.object({ action: z.literal("clipboard_set"), text: z.string().max(1_000_000) }),
  /** what's in a folder ("~" or unset: its home folder) → FolderListing */
  z.object({ action: z.literal("files_list"), path: z.string().max(4000).optional() }),
  /** a file's contents → FileData */
  z.object({ action: z.literal("file_read"), path: z.string().min(1).max(4000) }),
  /** put a file in a folder (made if missing); a name that's taken gets " (1)" → { path } */
  z.object({ action: z.literal("file_write"), folder: z.string().max(4000), name: FileName, data: z.string().max(Math.ceil(MAX_TRANSFER_BYTES / 3) * 4) }),
  /** make a folder inside `folder` → { path } */
  z.object({ action: z.literal("file_mkdir"), folder: z.string().max(4000), name: FileName }),
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

/** Actions that move things between a person's device and a computer, not input on its screen. */
export const TRANSFER_ACTIONS = ["clipboard_get", "clipboard_set", "files_list", "file_read", "file_write", "file_mkdir"] as const;

export interface FileEntry {
  name: string;
  dir: boolean;
  /** bytes; 0 for folders */
  size: number;
  modified: string | null;
}

export interface FolderListing {
  /** the folder, absolute */
  path: string;
  /** the folder above it, or null at the top */
  parent: string | null;
  home: string;
  entries: FileEntry[];
}

export interface FileData {
  name: string;
  size: number;
  /** base64 */
  data: string;
}

/** `~` or `~/x` and a home folder → an absolute path (POSIX or Windows). */
export function expandHome(p: string | undefined, home: string): string {
  if (!p || p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home.replace(/[/\\]+$/, "") + p.slice(1);
  return p;
}

/**
 * Shell scripts for files on a Linux computer (a VM, a cloud computer), run as `sh -c SCRIPT sh ARGS…`.
 * Each takes the folder or file as $1, with ~ meaning the home folder.
 */
const HOME_ARG = 'p="$1"; case "$p" in ""|"~") p="$HOME";; "~/"*) p="$HOME/${p#??}";; esac';
export const POSIX_FILES = {
  /** prints the folder, the home folder, then one "type\tsize\tmtime\tname" line per entry */
  list: [HOME_ARG, 'cd -- "$p" 2>/dev/null || { echo "There is no folder $p" >&2; exit 2; }', "pwd", 'printf "%s\\n" "$HOME"', "find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%s\\t%T@\\t%f\\n' 2>/dev/null; true"].join("\n"),
  /** the file's bytes; `base64` prints them as base64 (for shells that only return text) */
  read: (maxBytes: number, base64 = false) =>
    [HOME_ARG, '[ -f "$p" ] || { echo "There is no file $p" >&2; exit 2; }', `[ "$(wc -c < "$p")" -le ${maxBytes} ] || { echo "It's bigger than ${Math.round(maxBytes / 1024 / 1024)} MB" >&2; exit 3; }`, base64 ? 'base64 < "$p" | tr -d "\\n"' : 'cat -- "$p"'].join("\n"),
  /** $2 is the name; stdin is the contents; prints where it went */
  write: [HOME_ARG, 'mkdir -p -- "$p" || exit 2', 'n="$2"; b="$n"; e=""', 'case "$n" in ?*.*) b="${n%.*}"; e=".${n##*.}";; esac', 'f="$p/$n"; i=1', 'while [ -e "$f" ]; do f="$p/$b ($i)$e"; i=$((i+1)); done', 'cat > "$f" && printf "%s\\n" "$f"'].join("\n"),
  /** $2 is the new folder's name; prints its path */
  mkdir: [HOME_ARG, 'f="$p/$2"', '[ -e "$f" ] && { echo "$2 already exists" >&2; exit 2; }', 'mkdir -p -- "$f" && printf "%s\\n" "$f"'].join("\n"),
};

/** Read POSIX_FILES.list's output. */
export function parseListing(out: string): FolderListing {
  const [dir = "/", home = "/", ...lines] = out.split("\n");
  const entries: FileEntry[] = [];
  for (const line of lines) {
    const [type, size, mtime, ...rest] = line.split("\t");
    const name = rest.join("\t");
    if (!name) continue;
    const dirEntry = type === "d";
    entries.push({ name, dir: dirEntry, size: dirEntry ? 0 : Number(size) || 0, modified: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null });
  }
  return { path: dir, parent: dir === "/" ? null : dir.replace(/\/[^/]*$/, "") || "/", home, entries: sortEntries(entries) };
}

/** Folders first, then by name. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
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
