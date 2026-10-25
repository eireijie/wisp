import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Letters and digits that can't be mistaken for each other when read off a screen (no 0/o, 1/l/i). */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const SETUP_CODE_FILE = "setup-code";

/** A new setup code: 12 characters (about 59 bits) in groups of four, like k7qm-29xd-hp4c. */
export function newSetupCode(): string {
  const chars = Array.from(crypto.randomBytes(12), (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

const normalize = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Until the first account exists, whoever reaches this Wisp could make it, and a tunnel can make it
 * public before its owner gets there. So making the first account needs a code that's only on this
 * computer: in <data>/setup-code, in the hub's log, and in the link the desktop app and installer open.
 */
export class SetupCode {
  private value: string | null;
  private file: string;

  /** `given` false: no code needed (tests). A string: that code (a cloud server's key). */
  constructor(dataDir: string, needsSetup: boolean, given?: string | false) {
    this.file = path.join(dataDir, SETUP_CODE_FILE);
    if (!needsSetup || given === false) {
      this.value = null;
      if (!needsSetup) fs.rmSync(this.file, { force: true });
      return;
    }
    // the same code across restarts, so a link printed earlier keeps working
    let saved = "";
    try { saved = fs.readFileSync(this.file, "utf8").trim(); } catch {}
    this.value = given || (normalize(saved).length >= 12 ? saved : newSetupCode());
    fs.writeFileSync(this.file, this.value + "\n", { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  get code() { return this.value; }
  get required() { return this.value !== null; }

  matches(attempt: unknown): boolean {
    if (this.value === null) return true;
    if (typeof attempt !== "string" || attempt.length > 200) return false;
    const a = Buffer.from(normalize(attempt));
    const b = Buffer.from(normalize(this.value));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** The first account exists: the code is spent. */
  used() {
    fs.rmSync(this.file, { force: true });
    this.value = null;
  }
}
