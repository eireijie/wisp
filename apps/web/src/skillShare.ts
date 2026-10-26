/**
 * Sharing a skill without a server in between: a skill is small, so "a link" carries the skill
 * itself ("wisp-skill:" and the text, encoded), and a file is the SKILL.md anyone's harness reads.
 * Bringing one in reads either back, or any SKILL.md someone sends.
 */
import { skillTitle } from "@wisp/core";

export interface SharedSkill {
  name: string;
  description: string;
  content: string;
  tags: string[];
}

const PREFIX = "wisp-skill:";

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64 = (text: string) => {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** A link anyone can paste into "Bring one in". */
export function skillLink(s: SharedSkill): string {
  return PREFIX + toBase64(JSON.stringify({ n: s.name, d: s.description, c: s.content, t: s.tags }));
}

/** The skill inside a link made by skillLink, or null when the text isn't one. */
export function readSkillLink(text: string): SharedSkill | null {
  const raw = text.trim();
  const at = raw.indexOf(PREFIX);
  if (at < 0) return null;
  try {
    const v = JSON.parse(fromBase64(raw.slice(at + PREFIX.length).split(/\s/)[0])) as { n?: unknown; d?: unknown; c?: unknown; t?: unknown };
    if (typeof v.n !== "string" || typeof v.c !== "string" || !v.n.trim() || !v.c.trim()) return null;
    return {
      name: v.n.slice(0, 60),
      description: typeof v.d === "string" ? v.d.slice(0, 500) : "",
      content: v.c,
      tags: Array.isArray(v.t) ? v.t.filter((t): t is string => typeof t === "string").slice(0, 10) : [],
    };
  } catch {
    return null;
  }
}

/** A front matter value: quoted (as skillFile writes it) or plain. */
function value(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  return v.replace(/^'(.*)'$/, "$1");
}

/** "frontend-design.md" or "my skill/SKILL.md" → a readable name. */
function nameFromFile(fileName: string): string {
  const parts = fileName.replace(/\\/g, "/").split("/");
  let base = parts.pop() ?? "";
  if (/^skill\.md$/i.test(base) && parts.length) base = parts.pop()!;
  const words = base.replace(/\.md$/i, "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "New skill";
}

/** A SKILL.md (front matter with a name and description, then instructions) as a skill. */
export function readSkillFile(text: string, fileName = ""): SharedSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  const fields: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1].toLowerCase()] = value(kv[2]);
    }
  }
  const body = (m ? m[2] : text).trim();
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const name = fields.title || (fields.name ? skillTitle(fields.name) : "") || heading || nameFromFile(fileName);
  const tags = (fields.tags ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
  return { name: name.slice(0, 60).trim() || "New skill", description: (fields.description ?? "").replace(/\s+/g, " ").slice(0, 500), content: body, tags };
}
