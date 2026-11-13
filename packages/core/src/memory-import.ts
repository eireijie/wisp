/**
 * "Bring what your AI already knows": one prompt the person gives the AI they already use
 * (Claude Code, Codex, ChatGPT, Grok…), and the answer it gives back, split into lines the person
 * ticks before Wisp saves them to an agent's notes. Used by first-run setup and Settings › Memory.
 */

/** The headings the prompt asks for, in order. */
export const MEMORY_HEADINGS = ["About me", "Projects", "In progress", "Decisions", "Preferences and rules", "Tools and accounts", "People", "Routines"] as const;
export type MemoryHeading = (typeof MEMORY_HEADINGS)[number];

/** The prompt, word for word as designed. `link` is the one-time link an agent can post its answer to. */
export function memoryPrompt(link?: string | null): string {
  return [
    "I'm moving my work into Wisp, where a team of AI agents will work for me. Hand over everything a new teammate would need to pick up exactly where you left off.",
    "First, look through everything you can see: your saved memories and custom instructions, project files like CLAUDE.md or AGENTS.md, and our recent conversations.",
    'Then write it in Markdown under these headings, one fact per line starting with "- ":',
    "## About me: name, work, timezone, how I like to be talked to",
    "## Projects: for each, its name, goal, where it lives (repo, folder, URL), stack, status and next step",
    '## In progress: what we did last, open bugs, half-finished work, deadlines (real dates, not "next week")',
    "## Decisions: what was decided and why, so it isn't argued again",
    "## Preferences and rules: how I like things done, and what I've told you never to do",
    "## Tools and accounts: apps and services I use (names only)",
    "## People: who they are and what they handle",
    "## Routines: things I do or check regularly",
    "Rules:",
    "- Only what you actually know. Mark anything you're not sure of with (unsure).",
    "- Say where each fact came from when you can: (memory), (CLAUDE.md), (chat, Oct 2026).",
    "- Never include passwords, API keys, tokens, card or bank numbers, or private details about other people.",
    "- Skip things older than a year unless they still matter.",
    link ? `When you're done, send it to this one-time link if you can: ${link} (it works once). Otherwise reply with it and I'll paste it into Wisp.` : "When you're done, reply with it and I'll paste it into Wisp.",
  ].join("\n");
}

export interface MemoryLine {
  /** the heading it was under, as the prompt names it ("Other" for lines under no known heading) */
  heading: MemoryHeading | "Other";
  text: string;
  /** marked (unsure): starts unticked */
  unsure: boolean;
}

export interface ParsedMemory {
  lines: MemoryLine[];
  /** lines that looked like a password, key, token or card number, left out without being shown */
  dropped: number;
}

/** Longest answer Wisp reads (a whole chat history pasted by mistake is cut there). */
export const MEMORY_ANSWER_MAX = 60_000;
/** Most lines one import keeps. */
export const MEMORY_LINES_MAX = 300;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/, // Anthropic
  /\b(?:sk|pk|rk)[-_](?:live_|test_|proj-)?[A-Za-z0-9_-]{16,}/, // OpenAI, Stripe and the like
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/, // GitHub
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passcode|pwd|api[ _-]?key|secret|token|pin)\b\s*(?:is|=|:)\s*\S+/i,
  /\b\d(?:[ -]?\d){12,18}\b/, // card and bank numbers
  /[A-Za-z0-9+/_=-]{40,}/, // a long opaque string
];

/** Whether a line looks like it holds a secret, so it's dropped before anyone sees it. */
export function looksSecret(line: string): boolean {
  // links are long but aren't secrets; look at the rest of the line
  const bare = line.replace(/https?:\/\/\S+/g, " ");
  return SECRET_PATTERNS.some((p) => p.test(bare));
}

function headingOf(raw: string): MemoryHeading | "Other" {
  const h = raw
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .split(":")[0]
    .trim()
    .toLowerCase();
  return MEMORY_HEADINGS.find((m) => h === m.toLowerCase() || h.startsWith(m.toLowerCase())) ?? "Other";
}

/**
 * The AI's answer, by heading, one line per fact. Bullets ("- ", "* ", "1. ") become lines;
 * prose under a heading counts as one line each. Lines that look secret are dropped and counted.
 */
export function parseMemoryAnswer(answer: string): ParsedMemory {
  const lines: MemoryLine[] = [];
  let dropped = 0;
  let heading: MemoryHeading | "Other" = "Other";
  const seen = new Set<string>();
  for (const rawLine of answer.slice(0, MEMORY_ANSWER_MAX).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^```/.test(line) || /^(-{3,}|\*{3,})$/.test(line)) continue;
    if (/^#{1,6}\s/.test(line)) {
      heading = headingOf(line);
      continue;
    }
    // "**Projects**" on a line of its own is a heading too
    if (/^\*\*[^*]+\*\*:?$/.test(line) && headingOf(line.replace(/\*/g, "")) !== "Other") {
      heading = headingOf(line.replace(/\*/g, ""));
      continue;
    }
    let text = line
      .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      .trim();
    if (!text) continue;
    if (looksSecret(text)) {
      dropped++;
      continue;
    }
    const unsure = /\(unsure\)/i.test(text);
    text = text.replace(/\s*\(unsure\)\s*/gi, " ").trim().slice(0, 500);
    const key = `${heading}\n${text.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    lines.push({ heading, text, unsure });
    if (lines.length >= MEMORY_LINES_MAX) break;
  }
  return { lines, dropped };
}
