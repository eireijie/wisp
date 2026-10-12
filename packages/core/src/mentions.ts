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

  /** `limits` overrides the guard's own for this check (a workspace's settings). */
  allow(channelId: string, hop: number, now = Date.now(), limits: Partial<LoopGuardOptions> = {}): { ok: true } | { ok: false; reason: string } {
    const o = { ...this.opts, ...limits };
    if (hop >= o.maxHops) return { ok: false, reason: `hop limit ${o.maxHops} reached` };
    const recent = (this.runs.get(channelId) ?? []).filter((t) => now - t < o.windowMs);
    if (recent.length >= o.maxRunsPerWindow) {
      this.runs.set(channelId, recent);
      return { ok: false, reason: "channel rate limit reached" };
    }
    recent.push(now);
    this.runs.set(channelId, recent);
    return { ok: true };
  }
}
