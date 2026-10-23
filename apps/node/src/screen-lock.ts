import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The code that opens this device's own screen from Warren, picked at the device. Only a hash of
 * it is kept here, and the hub never stores it: someone signed in to Warren as the owner still
 * can't see or use the screen without it. The device itself counts wrong codes and locks out
 * guessing, so nothing on the hub can get around that.
 */

export type CodeKind = "pin" | "password";

export interface ScreenCode {
  kind: CodeKind;
  salt: string;
  hash: string;
}

/** Wrong codes in a row before the screen stops taking codes for a while. */
export const MAX_TRIES = 5;
/** The first lockout; each one after it is twice as long, up to a day. */
const LOCKOUT_MS = 15 * 60_000;
const MAX_LOCKOUT_MS = 24 * 60 * 60_000;
/** The longest one code entry keeps the screen open (a lend "until I stop" included). */
export const MAX_UNLOCK_MS = 24 * 60 * 60_000;

/** Is this a code people can pick? A PIN is 6 digits; a password is 8 characters or more. */
export function codeProblem(kind: CodeKind, code: string): string | null {
  if (kind === "pin") return /^\d{6}$/.test(code) ? null : "A PIN is 6 digits.";
  if (code.length < 8) return "A password is at least 8 characters.";
  if (code.length > 200) return "That password is too long.";
  if (/^\d+$/.test(code)) return "A password of only digits is a PIN; pick PIN instead, or add letters.";
  return null;
}

export function hashCode(kind: CodeKind, code: string): ScreenCode {
  const salt = crypto.randomBytes(16);
  return { kind, salt: salt.toString("base64"), hash: crypto.scryptSync(code, salt, 32).toString("base64") };
}

function matches(saved: ScreenCode, code: string): boolean {
  const want = Buffer.from(saved.hash, "base64");
  const got = crypto.scryptSync(code, Buffer.from(saved.salt, "base64"), want.length);
  return crypto.timingSafeEqual(want, got);
}

export type CheckResult = { ok: true } | { ok: false; error: string; lockedOut?: boolean; triesLeft?: number };

interface Strikes {
  fails: number;
  lockouts: number;
  lockedUntil: number;
}

export class ScreenLock {
  /** what code entries opened the screen for, and until when */
  private grants = new Map<string, number>();
  private strikes: Strikes;

  constructor(
    private dir: string,
    private code: () => ScreenCode | undefined,
    private now: () => number = Date.now,
  ) {
    // kept on disk, so restarting the device (which the hub can ask for, with an update) doesn't reset the count
    try {
      this.strikes = { fails: 0, lockouts: 0, lockedUntil: 0, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      this.strikes = { fails: 0, lockouts: 0, lockedUntil: 0 };
    }
  }

  private get file() {
    return path.join(this.dir, "screen-lock.json");
  }

  /** Is a code set at all? Without one the screen works as it always has. */
  get enabled(): boolean {
    return !!this.code();
  }

  get kind(): CodeKind | undefined {
    return this.code()?.kind;
  }

  /** Check a code. Wrong ones count toward a lockout; a right one clears the count. */
  check(code: string | undefined): CheckResult {
    const saved = this.code();
    if (!saved) return { ok: true };
    const t = this.now();
    if (this.strikes.lockedUntil > t) return { ok: false, lockedOut: true, error: `Too many wrong codes. This screen takes codes again ${inMinutes(this.strikes.lockedUntil - t)}.` };
    if (!code) return { ok: false, error: `Enter this screen's ${saved.kind === "pin" ? "PIN" : "password"}.` };
    if (matches(saved, code)) {
      if (this.strikes.fails || this.strikes.lockouts) this.save({ fails: 0, lockouts: 0, lockedUntil: 0 });
      return { ok: true };
    }
    const fails = this.strikes.fails + 1;
    if (fails >= MAX_TRIES) {
      const lockouts = this.strikes.lockouts + 1;
      const until = t + Math.min(MAX_LOCKOUT_MS, LOCKOUT_MS * 2 ** (lockouts - 1));
      this.save({ fails: 0, lockouts, lockedUntil: until });
      // a lockout closes everything the code had opened, too
      this.grants.clear();
      return { ok: false, lockedOut: true, error: `Too many wrong codes. This screen takes codes again ${inMinutes(until - t)}.` };
    }
    this.save({ ...this.strikes, fails });
    const left = MAX_TRIES - fails;
    return { ok: false, triesLeft: left, error: `Wrong ${saved.kind === "pin" ? "PIN" : "password"}. ${left} ${left === 1 ? "try" : "tries"} left before this screen locks for a while.` };
  }

  /** Open the screen for `purpose` until `until` (at most a day from now) with the code. */
  unlock(purpose: string, code: string, until: number): CheckResult & { until?: number } {
    const r = this.check(code);
    if (!r.ok) return r;
    const end = Math.min(until, this.now() + MAX_UNLOCK_MS);
    this.grants.set(purpose, end);
    return { ok: true, until: end };
  }

  /** Open the screen for `purpose` after the code was already checked (a viewer that's connected). */
  grant(purpose: string, until: number) {
    this.grants.set(purpose, Math.min(until, this.now() + MAX_UNLOCK_MS));
  }

  lock(purpose: string) {
    this.grants.delete(purpose);
  }

  /** Close everything (the code changed, the screen was turned off). */
  lockAll() {
    this.grants.clear();
  }

  /** May Warren use the screen right now (screenshots, input, files)? Always, when no code is set. */
  open(): boolean {
    if (!this.enabled) return true;
    const t = this.now();
    for (const [purpose, until] of this.grants) {
      if (until > t) return true;
      this.grants.delete(purpose);
    }
    return false;
  }

  private save(s: Strikes) {
    this.strikes = s;
    try {
      fs.writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
    } catch {}
  }
}

function inMinutes(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  return m >= 120 ? `in ${Math.round(m / 60)} hours` : `in ${m} minute${m === 1 ? "" : "s"}`;
}
