import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

const join = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * A password, key or code field with an eye on the right: tap it to show what you typed, and it
 * turns into the crossed eye. Every secret field in the app goes through this one.
 * `className` styles the field itself; `wrapClassName` places the whole thing (flex-1, a margin).
 * `tone="dark"` is for the always-dark screen and terminal overlays.
 */
export function PasswordInput({ className, wrapClassName, tone, type: _type, ...p }: InputHTMLAttributes<HTMLInputElement> & { wrapClassName?: string; tone?: "dark" }) {
  const [shown, setShown] = useState(false);
  const label = shown ? "Hide password" : "Show password";
  return (
    <span className={join("relative block", wrapClassName ?? "w-full")}>
      <input {...p} type={shown ? "text" : "password"} className={join(className, "pr-10!")} />
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={shown}
        disabled={p.disabled}
        // keep the caret in the field while tapping the eye
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((s) => !s)}
        className={join(
          "absolute right-1 top-1/2 -translate-y-1/2 grid size-8 place-items-center rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
          tone === "dark" ? "text-[#8e8e96] hover:text-[#f2f2f4]" : "text-faint hover:text-ink",
        )}
      >
        {shown ? <EyeOff size={16} strokeWidth={1.8} aria-hidden /> : <Eye size={16} strokeWidth={1.8} aria-hidden />}
      </button>
    </span>
  );
}
