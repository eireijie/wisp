import { useEffect, useState, type ReactNode } from "react";
import { Check } from "../icons.tsx";
import { Button, cx } from "../components/ui.tsx";

/** Sticky save bar. ⌘/Ctrl+S saves while the panel is visible. */
export function SaveBar({ dirty, saving, onSave, onDiscard, active, note }: { dirty: boolean; saving: boolean; onSave: () => Promise<void> | void; onDiscard: () => void; active: boolean; note?: ReactNode }) {
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !saving) onSave();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [active, dirty, saving, onSave]);
  useEffect(() => {
    if (!saving && !dirty) return;
    setJustSaved(false);
  }, [dirty, saving]);
  const save = async () => {
    await onSave();
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1800);
  };
  return (
    <div className="sticky bottom-0 -mx-4 md:-mx-8 mt-6 px-4 md:px-8 py-3 bg-panel/95 backdrop-blur border-t border-line flex items-center gap-3 safe-bottom">
      <span className="text-sm text-muted flex-1 min-w-0 truncate">{dirty ? "Unsaved changes" : justSaved ? <span className="text-ok inline-flex items-center gap-1"><Check size={14} /> Saved</span> : note}</span>
      {dirty && (
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      )}
      <Button variant="primary" onClick={save} disabled={!dirty || saving}>
        {saving ? "Saving…" : "Save"}
        <kbd className="hidden md:inline text-[10px] opacity-70 ml-1">⌘S</kbd>
      </Button>
    </div>
  );
}

export function Intro({ title, children, compact }: { title: string; children: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("max-w-2xl", compact ? "mb-2.5" : "mb-5")}>
      <h3 className={cx("font-semibold", compact && "text-sm")}>{title}</h3>
      <div className={cx("text-muted space-y-1", compact ? "text-xs mt-0.5" : "text-sm mt-1")}>{children}</div>
    </div>
  );
}

