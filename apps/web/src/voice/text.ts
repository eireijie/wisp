/** A small spoken answer; the complete Markdown stays in chat. */
export function spokenReply(markdown: string): string {
  const plain = markdown
    .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1|$)/g, "")
    .replace(/^(?: {4}|\t).*$/gm, "")
    .replace(/^.*\|.*$/gm, "")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!?\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
    .replace(/https?:\/\/\S+|www\.\S+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+]\s+|\d+[.)]\s+)/gm, "")
    .trim();
  const paragraph = plain.split(/\n\s*\n/).find((p) => p.trim())?.replace(/\s+/g, " ").trim() ?? "";
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.slice(0, 2).join("").trim() ?? paragraph;
  return sentences.length > 480 ? `${sentences.slice(0, 477).replace(/\s+\S*$/, "")}…` : sentences;
}

export function voiceIndex(seed: string, count: number): number {
  let hash = 0;
  for (const c of seed) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  return count ? hash % count : 0;
}

/** Recognition can hear the speakers; don't send the ghost's own words back to it. */
export function isSpeechEcho(heard: string, spoken: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  const a = words(heard), b = words(spoken);
  return a.length > 0 && b.join(" ").includes(a.join(" "));
}
