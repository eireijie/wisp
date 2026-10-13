import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Workflow } from "lucide-react";
import { useStore } from "../../store.ts";
import { go } from "../../router.ts";
import { Button, Pill } from "../../components/ui.tsx";
import { OrchestrationChecklist, saveOrchestration } from "../../components/Orchestration.tsx";
import { OwnersOnly, PageHeader, SavedNote, Select, Toggle, useSavedFlash } from "./parts.tsx";

/**
 * Optional features, off until someone turns them on. Each is a card: what it does, a switch, and
 * the steps it needs before it works. Orchestration is the first.
 */
export function AddonsPage() {
  const owner = useStore((s) => s.me)?.role === "owner";
  return (
    <>
      <PageHeader title="Addons">Extra features for when you need them. Each one is off until you turn it on, and walks you through what it needs.</PageHeader>
      <OwnersOnly show={!owner} />
      <div className="space-y-4">
        <OrchestrationCard />
      </div>
    </>
  );
}

function AddonCard({ icon, title, status, toggle, children }: { icon: ReactNode; title: string; status: ReactNode; toggle: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center gap-3 px-4 py-3.5 border-b border-line">
        <span className="grid place-items-center size-8 rounded-lg bg-accent-soft text-accent-text shrink-0">{icon}</span>
        <h3 className="text-sm font-semibold flex-1 min-w-0 flex items-center gap-2">
          {title} {status}
        </h3>
        {toggle}
      </header>
      <div className="p-4 space-y-4">{children}</div>
    </section>
  );
}

function OrchestrationCard() {
  const owner = useStore((s) => s.me)?.role === "owner";
  const status = useStore((s) => s.orchestration);
  const agents = useStore((s) => s.agents);
  const [saved, flash] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    useStore.getState().refreshOrchestration();
  }, []);

  const save = async (patch: Parameters<typeof saveOrchestration>[0]) => {
    setError(null);
    try {
      await saveOrchestration(patch);
      flash();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const picker = (
    <Select label="Dispatcher" value={status?.dispatcherId ?? ""} onChange={(v) => save({ dispatcherId: v || null })} disabled={!owner || !agents.length} className="max-w-56">
      <option value="">{agents.length ? "Pick an agent…" : "Add an agent first"}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} (@{a.handle}){a.settings.role ? `: ${a.settings.role}` : ""}
        </option>
      ))}
    </Select>
  );

  return (
    <AddonCard
      icon={<Workflow size={17} />}
      title="Orchestration"
      status={!status?.enabled ? <Pill>Off</Pill> : status.ready ? <Pill tone="ok">On</Pill> : <Pill tone="warn">Setting up</Pill>}
      toggle={
        <span className="flex items-center gap-2">
          <SavedNote shown={saved} />
          <Toggle label="Orchestration" on={!!status?.enabled} disabled={!owner || !status} onChange={(on) => save({ enabled: on })} />
        </span>
      }
    >
      <p className="text-sm text-muted max-w-2xl">
        Turns Tasks into a place where work gets planned and handed out. One agent, the dispatcher, takes every task nobody assigned, breaks it into pieces and hands each piece to the agent whose role fits (or to a team's lead). The pieces show up under the task as subtasks, so you can see who's on what and how far along it is. Without it, Tasks stays off and agents still hand each other work in chat.
      </p>
      {status && (
        <>
          <OrchestrationChecklist status={status} dispatcherPicker={owner ? picker : undefined} />
          {status.enabled && status.dispatcherId && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted">Dispatcher</span>
              {picker}
            </div>
          )}
        </>
      )}
      {status?.ready && (
        <Button onClick={() => go({ view: "tasks" })}>
          Open Tasks <ArrowRight size={14} />
        </Button>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </AddonCard>
  );
}
