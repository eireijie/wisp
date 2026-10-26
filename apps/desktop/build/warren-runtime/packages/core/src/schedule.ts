/**
 * Five-field cron schedules ("min hour day-of-month month day-of-week") for routines, matched in
 * the routine's own time zone. Supports *, lists (1,3), ranges (1-5) and steps (*\/15, 9-17/2).
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 }, // 0 and 7 are Sunday
] as const;

const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export interface Cron {
  fields: Set<number>[];
  /** whether day-of-month / day-of-week were restricted (cron ORs them when both are) */
  domStar: boolean;
  dowStar: boolean;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a schedule has 5 fields: minute hour day-of-month month day-of-week");
  const fields = parts.map((p, i) => {
    const { min, max, name } = FIELDS[i];
    const out = new Set<number>();
    for (const item of p.split(",")) {
      const [range, stepRaw] = item.split("/");
      const step = stepRaw === undefined ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${name}: "${item}"`);
      let lo: number, hi: number;
      if (range === "*") [lo, hi] = [min, max];
      else {
        const [a, b] = range.split("-").map((v) => (NAMES[v.toLowerCase()] ?? Number(v)));
        lo = a;
        hi = b ?? (stepRaw === undefined ? a : max);
      }
      if (![lo, hi].every((n) => Number.isInteger(n) && n >= min && n <= max) || lo > hi) throw new Error(`bad ${name}: "${item}"`);
      for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return { fields, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export interface ClockParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    const opts = { hourCycle: "h23", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" } as const;
    try {
      fmt = new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
    } catch {
      fmt = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
    }
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock parts of `date` in `timeZone` (an IANA name; falls back to UTC if unknown). */
export function zonedParts(date: Date, timeZone: string): ClockParts {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), weekday: NAMES[String(p.weekday).toLowerCase().slice(0, 3)] ?? 0 };
}

export function cronMatches(cron: Cron, t: ClockParts): boolean {
  const [min, hour, dom, month, dow] = cron.fields;
  if (!min.has(t.minute) || !hour.has(t.hour) || !month.has(t.month)) return false;
  const domOk = dom.has(t.day);
  const dowOk = dow.has(t.weekday);
  // standard cron: when both day fields are restricted, either may match
  if (!cron.domStar && !cron.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** The next minute (after `from`) that the schedule fires, searching up to a year ahead. */
export function nextRun(expr: string, timeZone: string, from = new Date()): Date | null {
  const cron = parseCron(expr);
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++, t.setTime(t.getTime() + 60_000)) {
    if (cronMatches(cron, zonedParts(t, timeZone))) return new Date(t);
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(h: number, m: number) {
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

/** A plain-English reading of common schedules; falls back to the expression itself. */
export function describeCron(expr: string): string {
  let c: Cron;
  try {
    c = parseCron(expr);
  } catch {
    return expr;
  }
  const one = (s: Set<number>) => (s.size === 1 ? [...s][0] : null);
  const [min, hour, dom, month, dow] = c.fields;
  const m = one(min);
  const h = one(hour);
  if (month.size !== 12) return expr;
  if (m !== null && hour.size === 24 && c.domStar && c.dowStar) return m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}`;
  if (m === null || h === null) {
    if (min.size > 1 && hour.size === 24 && c.domStar && c.dowStar) {
      const step = [...min][1] - [...min][0];
      if ([...min].every((v, i) => v === i * step)) return `Every ${step} minutes`;
    }
    return expr;
  }
  const at = clock(h, m);
  if (c.domStar && c.dowStar) return `Every day at ${at}`;
  if (c.domStar) {
    const days = [...dow].sort();
    if (days.join() === "1,2,3,4,5") return `Every weekday at ${at}`;
    if (days.join() === "0,6") return `Every weekend day at ${at}`;
    return `Every ${days.map((d) => DAY_NAMES[d]).join(", ")} at ${at}`;
  }
  if (c.dowStar && dom.size === 1) {
    const d = [...dom][0];
    const suffix = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
    return `On the ${d}${suffix} of every month at ${at}`;
  }
  return expr;
}
