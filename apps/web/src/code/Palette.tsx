import { useMemo, useState, type ReactNode } from "react";
import { Modal, cx } from "../components/ui.tsx";

export interface PaletteItem {
  id: string;
  label: string;
  sub?: string;
  keys?: string;
  icon?: ReactNode;
  run: () => void;
}

/** ⌘K: go to a pane or a task, or do something, by typing a few letters. */
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => words.every((w) => `${i.label} ${i.sub ?? ""}`.toLowerCase().includes(w))).slice(0, 12);
  }, [items, q]);
  const pick = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };
  return (
    <Modal title="Commands" headerless onClose={onClose} className="!bg-[#141417] !border-white/[.08] text-[#f2f2f4] sm:!max-w-[520px]">
      <div className="flex flex-col">
        <input
          autoFocus
          value={q}
          onChange={(e) => (setQ(e.target.value), setAt(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setAt((n) => Math.min(shown.length - 1, n + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setAt((n) => Math.max(0, n - 1)));
            else if (e.key === "Enter") (e.preventDefault(), pick(shown[at]));
          }}
          placeholder="Go to a pane or task, or run a command"
          aria-label="Search commands"
          className="h-12 border-b border-white/[.07] bg-transparent px-4 text-[14px] text-[#f2f2f4] outline-none placeholder:text-[#6b6b75]"
        />
        <div role="listbox" className="max-h-[360px] overflow-y-auto p-1.5">
          {shown.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-[#8e8e96]">Nothing matches.</div>}
          {shown.map((i, n) => (
            <button
              key={i.id}
              type="button"
              role="option"
              aria-selected={n === at}
              onMouseEnter={() => setAt(n)}
              onClick={() => pick(i)}
              className={cx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors", n === at ? "bg-white/[.07]" : "")}
            >
              <span className="grid w-4 shrink-0 place-items-center text-[#8e8e96]">{i.icon}</span>
              <span className="min-w-0 flex-1 truncate">
                {i.label}
                {i.sub && <span className="ml-2 text-[12px] text-[#8e8e96]">{i.sub}</span>}
              </span>
              {i.keys && <span className="font-mono text-[11px] text-[#8e8e96]">{i.keys}</span>}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
