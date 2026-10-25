import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { ComputerInfo } from "../store.ts";
import { Input } from "./ui.tsx";

/**
 * Codes people typed for their screens in this tab, so watching a screen again doesn't ask again.
 * Only in memory: a reload or another tab asks once more. The device checks them; Wisp keeps none.
 */
const typed = new Map<string, string>();

export const screenCode = {
  get: (computerId: string) => typed.get(computerId),
  set: (computerId: string, code: string) => typed.set(computerId, code),
  forget: (computerId: string) => typed.delete(computerId),
};

/** Is a typed code complete enough to send? Screens without a code need none. */
export const codeReady = (kind: ComputerInfo["code"], code: string) => !kind || (kind === "pin" ? code.length === 6 : code.length > 0);

export const codeLabel = (kind: ComputerInfo["code"]) => (kind === "pin" ? "PIN" : "password");

/** The box for a screen's code: six digits, or a password. */
export function CodeInput({ kind, value, onChange, onSubmit, autoFocus, className }: { kind: NonNullable<ComputerInfo["code"]>; value: string; onChange: (v: string) => void; onSubmit?: () => void; autoFocus?: boolean; className?: string }) {
  return (
    <Input
      type="password"
      autoComplete="off"
      autoFocus={autoFocus}
      inputMode={kind === "pin" ? "numeric" : undefined}
      maxLength={kind === "pin" ? 6 : 200}
      placeholder={kind === "pin" ? "6-digit PIN" : "Password"}
      aria-label={`The screen's ${codeLabel(kind)}`}
      value={value}
      onChange={(e) => onChange(kind === "pin" ? e.target.value.replace(/\D/g, "") : e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && value && onSubmit?.()}
      className={className}
    />
  );
}

/** Asking for the code before a screen opens, on the dark screen background. */
export function CodePrompt({ computer, error, onSubmit }: { computer: ComputerInfo; error: string | null; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState("");
  const kind = computer.code ?? "pin";
  const ready = kind === "pin" ? code.length === 6 : code.length > 0;
  return (
    <form
      className="space-y-3 w-full max-w-64"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(code);
      }}
    >
      <KeyRound size={22} className="mx-auto opacity-70" />
      <p>Enter {computer.name}'s {codeLabel(kind)} to open it.</p>
      <CodeInput kind={kind} value={code} onChange={setCode} autoFocus className="text-center text-ink" />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button type="submit" disabled={!ready} className="inline-flex items-center rounded-lg border border-white/20 px-3 h-8 hover:bg-white/10 disabled:opacity-40">
        Open
      </button>
    </form>
  );
}
