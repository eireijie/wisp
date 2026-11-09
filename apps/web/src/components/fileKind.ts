/** How a file opens from a chat: shown in a preview (text, images, PDFs) or downloaded. */
export type FileKind = "image" | "pdf" | "text" | "other";

const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|bash|sql|tex|srt|vtt)$/i;

/** Which way a file opens, from its name (the hub may send any type as plain bytes). */
export function fileKind(name: string): FileKind {
  if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name)) return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (TEXT.test(name)) return "text";
  return "other";
}
