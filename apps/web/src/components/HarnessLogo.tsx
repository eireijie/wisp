import { Bot, Plug } from "lucide-react";

const LOGOS: Record<string, { file: string; mono?: boolean }> = {
  "claude-code": { file: "claude-color" },
  codex: { file: "codex-color" },
  cursor: { file: "cursor", mono: true },
  gemini: { file: "gemini-color" },
  hermes: { file: "hermesagent", mono: true },
  opencode: { file: "opencode", mono: true },
  goose: { file: "goose", mono: true },
  kimi: { file: "kimi-color" },
  qwen: { file: "qwen-color" },
  openclaw: { file: "openclaw-color" },
  grok: { file: "grok", mono: true },
};

/** Whether Warren ships a brand mark for this harness. */
export const hasHarnessLogo = (harness: string) => harness in LOGOS;

/** Source brand marks, kept locally so the picker never calls a third party. */
export function HarnessLogo({
  harness,
  size = 28,
}: {
  harness: string;
  size?: number;
}) {
  const logo = LOGOS[harness];
  if (!logo)
    return harness.startsWith("acp:") ? (
      <Plug size={size} aria-hidden="true" />
    ) : (
      <Bot size={size} aria-hidden="true" />
    );
  const src = `/harnesses/${logo.file}.svg`;
  return logo.mono ? (
    <span
      aria-hidden="true"
      className="inline-block bg-current shrink-0"
      style={{
        width: size,
        height: size,
        mask: `url(${src}) center / contain no-repeat`,
        WebkitMask: `url(${src}) center / contain no-repeat`,
      }}
    />
  ) : (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
    />
  );
}
