import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Rarely used settings, folded under a "More options" row where they live. Everyone sees the same
 * Wisp: nothing is hidden, the knobs are just one click away. `about` says what's inside.
 */
export function MoreOptions({ children, about, title = "More options", className }: { children: ReactNode; about?: string; title?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 min-h-8 text-xs text-muted hover:text-ink">
        <ChevronRight size={14} className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
        {title}
        {about && <span className="text-faint">: {about}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
