import { looksSecret } from "@wisp/core/src/memory-import.ts";
import type { Vault } from "@wisp/vault";

/**
 * "Bring what your AI already knows", saved: the lines the person ticked go into the agent's own
 * notes, one note per heading with the lines as bullets, and each project as a note of its own.
 * They live in the agent's own folder and every note links the hub note ("What I know about you"),
 * which links them all, so the graph shows them as one cluster of the agent's. A second import adds to the same notes instead of making copies.
 */

/** Where an agent's imported notes live. */
export const importDir = (agentId: string) => `agents/${agentId}/memories`;
const HUB = "What I know about you";

export interface ImportLine {
  heading: string;
  text: string;
}

/** A plain file name from a title: letters, digits, spaces, dots and dashes, at most 60 characters. */
function fileName(title: string): string {
  return (
    title
      .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[ .]+|[ .]+$/g, "")
      .slice(0, 60)
      .trim() || "Note"
  );
}

/** A project line's name: what comes before its first ":", " - ", "—" or "(" ("Wisp: an agents app" → "Wisp"). */
export function projectName(text: string): string {
  const name = text
    .replace(/[*_`]/g, "")
    .split(/:|\s[-–—]\s|—|\(/)[0]
    .trim();
  return name.slice(0, 60) || text.slice(0, 40);
}

const bullet = (t: string) => `- ${t.replace(/\s+/g, " ").trim()}`;

/**
 * Save the lines to the agent's notes, as `author`. Lines that look like a secret are dropped here
 * too. Returns how many lines were saved (new ones; a line a note already has isn't added twice)
 * and the paths of the notes written.
 */
export async function saveImportedMemory(vault: Vault, agent: { id: string; handle: string }, lines: ImportLine[], author: { name: string; email: string }): Promise<{ saved: number; notes: string[] }> {
  const dir = importDir(agent.id);
  const today = new Date().toISOString().slice(0, 10);
  // by note: its title and the lines that go in it, in order
  const notes = new Map<string, { title: string; type: string; lines: string[] }>();
  for (const l of lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    const heading = l.heading.replace(/\s+/g, " ").trim().slice(0, 60) || "Other";
    if (!text || looksSecret(text) || looksSecret(heading)) continue;
    const project = heading.toLowerCase() === "projects";
    const title = project ? `Project: ${projectName(text)}` : heading;
    const path = `${dir}/${fileName(project ? `Project - ${projectName(text)}` : heading)}.md`;
    const n = notes.get(path) ?? { title, type: project ? "project" : "reference", lines: [] };
    if (!n.lines.some((x) => x.toLowerCase() === text.toLowerCase())) n.lines.push(text);
    notes.set(path, n);
  }
  let saved = 0;
  const written: string[] = [];
  for (const [path, n] of notes) {
    const old = await vault.read(path).catch(() => null);
    const have = new Set((old?.content ?? "").split("\n").map((l) => l.trim().toLowerCase()));
    const fresh = n.lines.filter((t) => !have.has(bullet(t).toLowerCase()));
    if (!fresh.length) continue;
    const content = old
      ? `${old.content.replace(/\s+$/, "")}\n${fresh.map(bullet).join("\n")}\n`
      : [`---`, `type: ${n.type}`, `source: "imported, ${today}"`, `related: ["[[${HUB}]]"]`, `---`, `# ${n.title}`, "", ...fresh.map(bullet), "", `Part of [[${HUB}]].`, ""].join("\n");
    await vault.save(path, content, author, { message: `Import memories for @${agent.handle}: ${n.title}` });
    saved += fresh.length;
    written.push(path);
  }
  if (written.length) {
    // the hub note links every imported note
    const hubPath = `${dir}/${HUB}.md`;
    const all = vault
      .list((p) => p.startsWith(`${dir}/`) && p !== hubPath)
      .map((m) => m.path)
      .sort();
    const hub = [
      `---`,
      `type: topic`,
      `source: "imported, ${today}"`,
      `---`,
      `# ${HUB}`,
      "",
      `What @${agent.handle} brought over from the AI you used before. Edit or delete anything that's wrong.`,
      "",
      ...all.map((p) => `- [[${p.split("/").pop()!.replace(/\.md$/i, "")}]]`),
      "",
    ].join("\n");
    await vault.save(hubPath, hub, author, { message: `Import memories for @${agent.handle}` });
    written.push(hubPath);
  }
  return { saved, notes: written };
}
