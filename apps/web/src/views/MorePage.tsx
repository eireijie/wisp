import { ChevronRight } from "lucide-react";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { UserAvatarButton, useMoreItems } from "../components/Rail.tsx";

/** Phones: the More tab, the same list the rail's More menu holds on desktops. */
export function MorePage() {
  const guest = useStore((s) => s.me?.role) === "guest";
  const items = useMoreItems(guest, 20);
  return (
    <div className="flex-1 overflow-y-auto safe-top">
      <div className="px-[18px] pt-3 space-y-4">
        <header className="flex items-center gap-3">
          <h1 className="t-title flex-1">More</h1>
          <UserAvatarButton />
        </header>
        <nav aria-label="More" className="rounded-2xl bg-card overflow-hidden">
          {items.map((i) => (
            <a key={i.label} href={href(i.to)} className="flex items-center gap-3.5 px-4 h-[54px] border-b border-line last:border-0 hover:bg-hover active:bg-hover transition-colors">
              <span className="size-5 shrink-0 grid place-items-center text-muted">{i.icon}</span>
              <span className="flex-1 text-body">{i.label}</span>
              <ChevronRight size={16} className="text-faint" aria-hidden />
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}
