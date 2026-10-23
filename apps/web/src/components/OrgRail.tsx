import { useState } from "react";
import { Plus } from "lucide-react";
import { useStore } from "../store.ts";
import { switchOrg } from "../orgs.ts";
import { NewOrgDialog, OrgTile, useOrgs } from "./OrgSwitcher.tsx";
import { cx } from "./ui.tsx";

/**
 * A thin column of organizations left of the sidebar, like a community rail. It only appears once
 * you're in two or more; the open one has a bar beside it, and a dot marks one with something new.
 */
export function OrgRail() {
  const me = useStore((s) => s.me)!;
  const { orgs, homeId } = useOrgs();
  const [creating, setCreating] = useState(false);
  if (orgs.length < 2) return null;
  return (
    <nav aria-label="Organizations" className="w-[60px] shrink-0 flex flex-col items-center gap-2.5 py-3 overflow-y-auto safe-top">
      {orgs.map((o) => {
        const current = o.current || o.id === me.workspace.id;
        return (
          <div key={o.id} className="relative flex items-center">
            <span className={cx("absolute -left-[10px] w-1 rounded-r-full bg-ink transition-[height]", current ? "h-7" : "h-0")} aria-hidden />
            <button
              onClick={() => !current && switchOrg(o.id).catch((e) => alert(`Couldn't switch: ${(e as Error).message}`))}
              aria-label={o.name}
              aria-current={current ? "true" : undefined}
              title={o.name}
              className={cx("relative rounded-[14px] outline-none focus-visible:ring-3 focus-visible:ring-ring/40 transition-opacity", !current && "opacity-80 hover:opacity-100")}
            >
              <OrgTile org={o} home={o.id === homeId} size={40} />
              {o.unread && !current && <span className="absolute -top-1 -right-1 size-3 rounded-full bg-bad ring-2 ring-app" aria-label="New messages" />}
            </button>
          </div>
        );
      })}
      <button onClick={() => setCreating(true)} aria-label="New organization" title="New organization" className="size-10 rounded-[14px] border-[1.5px] border-dashed border-faint text-muted hover:text-ink hover:border-muted grid place-items-center">
        <Plus size={16} strokeWidth={2.2} />
      </button>
      {creating && <NewOrgDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}
