import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { useAppearance } from "../theme.ts";
import { cx } from "./ui.tsx";

/**
 * Everything before you're in the app (sign in, join, setup, authorize) shares one look: the
 * Wisp ghost bobbing over a big title, tall rounded fields, and pill buttons. On phones the
 * page is the screen; on desktops it is a centered card.
 */
export function AuthPage({ children, themeToggle = true, wide }: { children: ReactNode; themeToggle?: boolean; wide?: boolean }) {
  return (
    <div className="relative min-h-full bg-panel md:bg-app flex md:items-center md:justify-center safe-top">
      {themeToggle && <ThemeToggle />}
      <div className={cx("w-full mx-auto px-[22px] pt-20 pb-8 md:my-8 md:rounded-xl md:bg-panel md:border md:border-line md:p-9", wide ? "md:max-w-[560px]" : "md:max-w-[440px]")}>{children}</div>
    </div>
  );
}

function ThemeToggle() {
  const { resolvedMode, toggleMode } = useAppearance();
  return (
    <button onClick={toggleMode} className="circle circle-sm absolute top-4 right-4 text-muted" aria-label={resolvedMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
      {resolvedMode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/** A big title and a line under it. */
export function AuthHero({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-3.5">
      <h1 className="t-title">{title}</h1>
      {children && <p className="text-base text-muted leading-[1.45] max-w-[320px]">{children}</p>}
    </div>
  );
}

/** A tall rounded field with its label above and a hint below. */
export function AuthField({ label, hint, children }: { label?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[7px]">
      {label && <span className="text-[13px] font-medium text-muted pl-1.5">{label}</span>}
      {children}
      {hint && <span className="text-[13px] leading-snug text-faint pl-1.5">{hint}</span>}
    </label>
  );
}

export function AuthInput({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-12 w-full rounded-xl border border-line bg-card px-[18px] text-body text-ink outline-none placeholder:text-faint focus:border-ring", className)} />;
}

/** The big pill: filled (primary) or a raised control (secondary). */
export function AuthButton({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return (
    <button
      {...p}
      className={cx(
        "h-12 w-full inline-flex items-center justify-center gap-2.5 rounded-full px-[22px] text-body font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 disabled:pointer-events-none",
        variant === "primary" ? "bg-accent text-accent-ink hover:bg-accent/90" : "bg-control border border-control-line text-ink hover:bg-hover",
        className,
      )}
    />
  );
}

/** A quiet text link under the buttons. */
export function AuthLink({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx("min-h-11 px-3 text-body font-medium text-info hover:underline", className)} />;
}

/** A plain error line under the fields. */
export function AuthError({ children }: { children?: ReactNode }) {
  return children ? (
    <p role="alert" className="text-sm text-bad pl-1.5">
      {children}
    </p>
  ) : null;
}
