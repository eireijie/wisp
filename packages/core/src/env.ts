/** Renamed settings take precedence, including an explicitly empty value. */
export function envVar(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[`WISP_${name}`] ?? env[`WARREN_${name}`];
}
