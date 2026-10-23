import { frontMatter, linkedSkillContent, skillBody, skillLicense, skillTitle, type StoreSkill } from "@warren/core";
import type { Hub } from "./hub.ts";

/** Public SKILL.md repos the store reads live. Each skill links back to its folder there. */
export const SKILL_SOURCES = [
  { id: "anthropic", label: "Anthropic", repo: "anthropics/skills", branch: "main", root: "skills/" },
  { id: "openai", label: "OpenAI", repo: "openai/skills", branch: "main", root: "skills/.curated/" },
] as const;
type Source = (typeof SKILL_SOURCES)[number];

const TTL = 6 * 60 * 60_000;
const MAX_SKILL = 100_000;

interface Found {
  skill: StoreSkill;
  /** the SKILL.md as published */
  text: string;
  raw: string;
}

/**
 * Skills from public repos (Anthropic's and OpenAI's), read from GitHub and kept for a few hours.
 * Only the list and each SKILL.md are fetched; a skill's other files stay at its source, and only
 * skills under an open-source license can be added to agents (the rest link to where they live).
 */
export class PublicSkills {
  private cache: { at: number; value: Promise<{ found: Found[]; errors: string[] }> } | null = null;

  constructor(private hub: Hub) {}

  private async fetch(url: string, json: boolean): Promise<any> {
    const res = await this.hub.fetchImpl(url, { headers: { accept: json ? "application/vnd.github+json" : "text/plain", "user-agent": "warren-hub" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return json ? res.json() : res.text();
  }

  private async fromSource(s: Source): Promise<Found[]> {
    const tree = (await this.fetch(`https://api.github.com/repos/${s.repo}/git/trees/${s.branch}?recursive=1`, true)) as { tree?: { path: string; type: string }[] };
    const paths = (tree.tree ?? []).map((t) => t.path);
    const repoLicense = await this.fetch(`https://api.github.com/repos/${s.repo}`, true).then((r) => (r?.license?.spdx_id as string | undefined) ?? undefined, () => undefined);
    const folders = paths.filter((p) => p.startsWith(s.root) && p.endsWith("/SKILL.md") && p.slice(s.root.length).split("/").length === 2).map((p) => p.slice(0, -"/SKILL.md".length));
    const out: Found[] = [];
    // a few at a time, so a big repo doesn't open a hundred connections at once
    for (let i = 0; i < folders.length; i += 8) {
      const batch = await Promise.all(
        folders.slice(i, i + 8).map(async (folder): Promise<Found | null> => {
          const raw = `https://raw.githubusercontent.com/${s.repo}/${s.branch}/${folder}`;
          const text = (await this.fetch(`${raw}/SKILL.md`, false).catch(() => null)) as string | null;
          if (!text || text.length > MAX_SKILL) return null;
          const fm = frontMatter(text);
          const licenseFile = paths.find((p) => p.startsWith(`${folder}/`) && /^LICEN[CS]E(\.\w+)?$/i.test(p.slice(folder.length + 1)));
          const decided = skillLicense(fm.license, undefined);
          const licenseText = licenseFile && (!fm.license || !decided.open) ? ((await this.fetch(`https://raw.githubusercontent.com/${s.repo}/${s.branch}/${licenseFile}`, false).catch(() => "")) as string) : undefined;
          const dir = folder.split("/").pop()!;
          return {
            skill: {
              id: `${s.id}:${dir}`,
              name: skillTitle(fm.name || dir),
              description: (fm.description || "").replace(/\s+/g, " ").trim().slice(0, 1000),
              source: { id: s.id, label: s.label },
              url: `https://github.com/${s.repo}/tree/${s.branch}/${folder}`,
              license: skillLicense(fm.license, licenseText, repoLicense),
            },
            text,
            raw,
          };
        }),
      );
      out.push(...batch.filter((f): f is Found => !!f));
    }
    return out;
  }

  private load() {
    if (!this.cache || Date.now() - this.cache.at > TTL) {
      const value = Promise.all(
        SKILL_SOURCES.map((s) =>
          this.fromSource(s).then(
            (found) => ({ found, error: null }),
            (e) => ({ found: [] as Found[], error: `Couldn't read ${s.label}'s skills: ${(e as Error).message}` }),
          ),
        ),
      ).then((r) => ({ found: r.flatMap((x) => x.found), errors: r.flatMap((x) => (x.error ? [x.error] : [])) }));
      this.cache = { at: Date.now(), value };
      // a source that couldn't be reached is tried again in a few minutes, not hours
      void value.then((v) => {
        if (v.errors.length && this.cache?.value === value) this.cache.at = Date.now() - TTL + 5 * 60_000;
      });
    }
    return this.cache.value;
  }

  async list(): Promise<{ skills: StoreSkill[]; errors: string[] }> {
    const { found, errors } = await this.load();
    return { skills: found.map((f) => f.skill), errors };
  }

  /** One skill with its SKILL.md, or undefined. */
  async get(id: string): Promise<{ skill: StoreSkill; text: string } | undefined> {
    const f = (await this.load()).found.find((x) => x.skill.id === id);
    return f && { skill: f.skill, text: f.text };
  }

  /** What an agent gets: the skill's own instructions, linked to its source. Throws when its license doesn't allow copying. */
  async installable(id: string): Promise<{ skill: StoreSkill; name: string; description: string; content: string; tags: string[] } | undefined> {
    const f = (await this.load()).found.find((x) => x.skill.id === id);
    if (!f) return undefined;
    if (!f.skill.license.open) throw Object.assign(new Error(`${f.skill.name} isn't open source (${f.skill.license.label}), so Warren links to it instead of copying it: ${f.skill.url}`), { status: 403 });
    return {
      skill: f.skill,
      name: f.skill.name,
      description: f.skill.description.slice(0, 500),
      content: linkedSkillContent(skillBody(f.text), f.skill.url, f.raw, f.skill.license, `${f.skill.source.label}'s public skills`),
      tags: [f.skill.source.id],
    };
  }
}
