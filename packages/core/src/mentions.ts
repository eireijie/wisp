/** Extract unique, lowercased @handles from a message body. Ignores emails and code spans. */
export function parseMentions(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const found = new Set<string>();
  for (const m of withoutCode.matchAll(/(^|[^\w@.])@([a-zA-Z][\w-]{0,31})/g)) {
    found.add(m[2].toLowerCase());
  }
  return [...found];
}

export interface LoopGuardOptions {
  maxHops: number;
  /** max agent runs triggered per channel per window */
  maxRunsPerWindow: number;
  windowMs: number;
}

export const DEFAULT_LOOP_GUARD: LoopGuardOptions = { maxHops: 6, maxRunsPerWindow: 20, windowMs: 60_000 };

/** Prevents agents from pinging each other forever. */
export class LoopGuard {
  private runs = new Map<string, number[]>();
  constructor(private opts: LoopGuardOptions = DEFAULT_LOOP_GUARD) {}

  allow(channelId: string, hop: number, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    if (hop >= this.opts.maxHops) return { ok: false, reason: `hop limit ${this.opts.maxHops} reached` };
    const recent = (this.runs.get(channelId) ?? []).filter((t) => now - t < this.opts.windowMs);
    if (recent.length >= this.opts.maxRunsPerWindow) {
      this.runs.set(channelId, recent);
      return { ok: false, reason: "channel rate limit reached" };
    }
    recent.push(now);
    this.runs.set(channelId, recent);
    return { ok: true };
  }
}
