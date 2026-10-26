import { useStore } from "../../store.ts";
import { undoChange, useChanges } from "../../changes.ts";
import { AskAgent } from "../../components/AskAgent.tsx";
import { AgentAvatar, Button, timeAgo } from "../../components/ui.tsx";

/** The top of Settings: ask an agent to change anything, and what agents changed lately, with Undo. */
export function AskAndChanges() {
  const agents = useStore((s) => s.agents);
  const changes = useChanges();
  const recent = (changes ?? []).slice(0, 5);
  return (
    <div className="mb-10 space-y-6">
      <AskAgent placeholder="Ask {name} to change anything" />
      {recent.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-body font-semibold text-muted">Recently changed</h3>
          {recent.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId);
            return (
              <div key={c.id} className="flex items-center gap-3 min-h-11 border-b border-line text-sm">
                {agent && <AgentAvatar agent={agent} size={18} badge={false} />}
                <span className={c.undoneAt ? "flex-1 text-muted line-through" : "flex-1"}>
                  {agent ? `${agent.name}: ` : ""}
                  {c.lines.join(", ")}
                </span>
                <span className="text-xs text-muted">{timeAgo(c.createdAt)}</span>
                {!c.undoneAt && (
                  <Button className="h-7 px-3 text-xs" onClick={() => void undoChange(c.id).catch((e) => alert((e as Error).message))}>
                    Undo
                  </Button>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
