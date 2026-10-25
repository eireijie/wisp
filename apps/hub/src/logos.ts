import { logoIndex, logoSlug, type LogoIndex } from "@wisp/core";
import type { Hub } from "./hub.ts";

/** Simple Icons (simpleicons.org, CC0): brand logos as one-color SVGs, with each brand's color. */
export const SIMPLE_ICONS = "https://cdn.jsdelivr.net/npm/simple-icons@15";
const INDEX_TTL = 24 * 60 * 60_000;
const RETRY = 5 * 60_000;

/**
 * Real brand logos for apps without one of their own in the MCP Registry. The hub looks the brand
 * up in Simple Icons' list and serves its SVG in the brand's color, so the page never shows a
 * letter in a box where a logo should be.
 */
export class Logos {
  private index: { at: number; value: Promise<LogoIndex | null> } | null = null;
  private svgs = new Map<string, Promise<string | null>>();

  constructor(private hub: Hub) {}

  private async fetchText(url: string): Promise<string | null> {
    const res = await this.hub.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? res.text() : null;
  }

  private loadIndex(): Promise<LogoIndex | null> {
    const fresh = this.index && Date.now() - this.index.at < INDEX_TTL;
    if (!fresh) {
      const value = this.fetchText(`${SIMPLE_ICONS}/data/simple-icons.json`).then(
        (t) => (t ? logoIndex(JSON.parse(t)) : null),
        () => null,
      );
      this.index = { at: Date.now(), value };
      // a failed load is tried again after a few minutes, not a day
      void value.then((v) => {
        if (!v && this.index?.value === value) this.index.at = Date.now() - INDEX_TTL + RETRY;
      });
    }
    return this.index!.value;
  }

  /** The Simple Icons slug for the first of `names` that is a brand. */
  async slug(names: string[]): Promise<string | null> {
    const index = await this.loadIndex();
    return index ? logoSlug(names, index) : null;
  }

  /** The logo for the first of `names` that is a brand, as SVG in its color; null when none is. */
  async svg(names: string[]): Promise<string | null> {
    const index = await this.loadIndex();
    const slug = index && logoSlug(names, index);
    if (!index || !slug) return null;
    let hit = this.svgs.get(slug);
    if (!hit) {
      hit = this.fetchText(`${SIMPLE_ICONS}/icons/${slug}.svg`).then(
        (t) => (t && /^<svg[\s>]/.test(t) ? colored(t, index.hex.get(slug) ?? "000000") : null),
        () => null,
      );
      if (this.svgs.size > 1000) this.svgs.clear();
      this.svgs.set(slug, hit);
      void hit.then((v) => v === null && this.svgs.delete(slug));
    }
    return hit;
  }
}

/** The SVG filled with the brand's color; a color too pale for the light tile it sits on becomes near-black. */
function colored(svg: string, hex: string): string {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const pale = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.82;
  return svg.replace(/^<svg/, `<svg fill="#${pale ? "1c1c1e" : hex}"`);
}
