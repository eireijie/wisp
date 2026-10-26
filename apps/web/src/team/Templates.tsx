import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { TEAM_TEMPLATES, type TeamTemplate } from "@wisp/core";
import { api } from "../api.ts";
import { Button, Modal, cx } from "../components/ui.tsx";
import { MiniChart } from "./How.tsx";
import { SeedGhost, useIsPhone } from "./parts.tsx";

/** The ready-made teams, then the ones people here saved from their own. */
export function useTemplates(): { all: TeamTemplate[]; own: Set<string>; remove: (id: string) => Promise<void> } {
  const [own, setOwn] = useState<TeamTemplate[]>([]);
  useEffect(() => {
    api<TeamTemplate[]>("GET", "/api/team-templates")
      .then(setOwn)
      .catch(() => {});
  }, []);
  const builtIn = new Set(TEAM_TEMPLATES.map((t) => t.id));
  return {
    all: [...TEAM_TEMPLATES, ...own.filter((t) => !builtIn.has(t.id))],
    own: new Set(own.map((t) => t.id)),
    remove: async (id) => {
      await api("DELETE", `/api/team-templates/${id}`);
      setOwn((cur) => cur.filter((t) => t.id !== id));
    },
  };
}

function Sample({ template }: { template: TeamTemplate }) {
  if (!template.sample?.length) return null;
  return (
    <div className="space-y-2.5">
      {template.sample.map((line, i) => {
        const you = line.who === "You";
        return (
          <div key={i} className={cx("flex items-end gap-2", you && "justify-end")}>
            {!you && <SeedGhost seed={line.who} size={26} />}
            <div className={cx("max-w-[80%]", you && "text-right")}>
              {!you && <div className="px-2 pb-0.5 text-[12px] text-faint">{line.who}</div>}
              <div className={cx("inline-block rounded-[14px] px-3.5 py-2 text-left text-[14px] leading-snug", you ? "bg-badge text-badge-ink" : "bg-chip")}>{line.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Detail({ template, index, count, onPrev, onNext, own, onDelete }: { template: TeamTemplate; index: number; count: number; onPrev: () => void; onNext: () => void; own: boolean; onDelete: () => void }) {
  return (
    <div className="min-w-0 flex-1 space-y-5">
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h3 className="t-title">{template.name}</h3>
          <p className="mt-1 text-sm text-muted">{template.blurb}</p>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <span className="hidden text-sm tabular-nums text-muted sm:inline">
            {index + 1} of {count}
          </span>
          <button type="button" onClick={onPrev} disabled={index === 0} aria-label="Previous template" className="circle circle-sm disabled:opacity-35">
            <ChevronLeft size={17} />
          </button>
          <button type="button" onClick={onNext} disabled={index >= count - 1} aria-label="Next template" className="circle circle-sm disabled:opacity-35">
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <section aria-label="Who hands to whom" className="space-y-2">
        <h4 className="text-sm font-semibold text-muted">Who hands to whom</h4>
        <div className="rounded-3xl border border-line bg-card px-4 py-3">
          <MiniChart steps={template.steps} />
        </div>
      </section>
      {!!template.sample?.length && (
        <section aria-label="How a request goes" className="space-y-2">
          <h4 className="text-sm font-semibold text-muted">How a request goes</h4>
          <div className="rounded-3xl border border-line bg-card p-4">
            <Sample template={template} />
          </div>
        </section>
      )}
      {own && (
        <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 text-sm text-bad">
          <Trash2 size={14} /> Delete this template
        </button>
      )}
    </div>
  );
}

/** Ready-made teams, one at a time: a small flowchart and a sample of how it sounds. A list on the left on desktops. */
export function TemplateBrowser({ title = "Templates", onClose, onUse }: { title?: string; onClose: () => void; onUse: (t: TeamTemplate) => void }) {
  const { all, own, remove } = useTemplates();
  const phone = useIsPhone();
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const current = all[Math.min(page, all.length - 1)];
  return (
    <Modal title={phone ? `${title} ${Math.min(page + 1, all.length)}/${all.length}` : title} onClose={onClose} label={title} className="sm:max-w-[1120px]!">
      <div className={cx("flex gap-8", phone ? "flex-col" : "min-h-[520px]")}>
        {!phone && (
          <div role="listbox" aria-label="Templates" className="w-[280px] shrink-0 space-y-1">
            {all.map((t, i) => (
              <button key={t.id} type="button" role="option" aria-selected={i === page} onClick={() => setPage(i)} className={cx("w-full rounded-2xl px-3.5 py-2.5 text-left", i === page ? "bg-card" : "hover:bg-hover")}>
                <span className="block text-body font-medium">{t.name}</span>
                <span className="block text-[13px] text-muted">{t.blurb}</span>
              </button>
            ))}
          </div>
        )}
        {current && (
          <Detail
            template={current}
            index={Math.min(page, all.length - 1)}
            count={all.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(all.length - 1, p + 1))}
            own={own.has(current.id)}
            onDelete={() => remove(current.id).then(() => setPage((p) => Math.max(0, p - 1)), (e) => setError((e as Error).message))}
          />
        )}
      </div>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="sticky bottom-0 -mx-5 mt-5 flex justify-end gap-2.5 bg-panel px-5 pb-1 pt-3">
        <Button type="button" onClick={onClose} className="h-[42px]">
          Back
        </Button>
        <Button type="button" variant="primary" onClick={() => current && onUse(current)} disabled={!current} className="h-[42px]">
          Use this template
        </Button>
      </div>
    </Modal>
  );
}
