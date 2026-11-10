import { useMemo, useState, type FormEvent } from "react";
import { harnessLabel } from "@wisp/core";
import { api } from "../api.ts";
import { Modal, agentColor, cx } from "../components/ui.tsx";
import { useStore, useTeams } from "../store.ts";
import { href } from "../router.ts";
import { GhostIcon } from "./AgentPane.tsx";
import { repoName } from "./data.ts";

/**
 * New coding task: what to build and which team builds it. The team's lead splits the work, each
 * builder gets its own branch, and someone else reviews before anything merges.
 */
export function NewTaskSheet({ onClose, onStarted }: { onClose: () => void; onStarted: (taskId: string) => void }) {
  const teams = useTeams().filter((t) => !!t.repo && !!t.leadId);
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = teams.find((t) => t.id === teamId);
  const crew = useMemo(() => (team ? team.members.map((m) => ({ m, a: agents.find((a) => a.id === m.agentId) })).filter((x) => !!x.a) : []), [team, agents]);

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = what.trim();
    if (!team || !text || busy) return;
    setBusy(true);
    setError(null);
    const first = text.split("\n")[0].replace(/[.!]+$/, "");
    const title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
    try {
      const r = await api<{ task?: { id: string }; id?: string }>("POST", "/api/tasks", { to: `team:${team.name}`, title, brief: text });
      onStarted(r.task?.id ?? r.id ?? "");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New coding task" onClose={onClose} wide className="!bg-[#141417] !border-white/[.08] text-[#f2f2f4]">
      <form onSubmit={start} className="flex flex-col gap-4 px-5 pb-5" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start()}>
        {teams.length === 0 ? (
          <p className="text-[13px] text-[#a1a1aa]">
            Link a repo to a team first: open the team's chat, then its settings.{" "}
            <a href={href({ view: "chats" })} className="text-[#6aa2ff] hover:text-[#9cc2ff]">
              Chats
            </a>
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-[#a1a1aa]">What should get built?</span>
              <textarea
                autoFocus
                value={what}
                onChange={(e) => setWhat(e.target.value)}
                rows={4}
                className="resize-none rounded-lg border border-white/[.09] bg-[#0f0f11] px-3 py-2.5 text-[13.5px] leading-[1.5] text-[#f2f2f4] outline-none transition-colors focus:border-white/25"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-[#a1a1aa]">Team</span>
              <div className="flex flex-wrap gap-1.5">
                {teams.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTeamId(t.id)}
                    aria-pressed={t.id === teamId}
                    className={cx(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-[background-color,border-color,transform] active:scale-[.98]",
                      t.id === teamId ? "border-[#f2f2f4] bg-white/[.06]" : "border-white/[.08] bg-[#0f0f11] hover:border-white/20",
                    )}
                  >
                    <span className="font-medium">#{t.name}</span>
                    <span className="font-mono text-[11.5px] text-[#8e8e96]">
                      {repoName(t.repo)} · {t.baseBranch}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {crew.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-[#a1a1aa]">Agents</span>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {crew.map(({ m, a }) => (
                    <div key={a!.id} className="flex items-center gap-2.5 rounded-lg border border-white/[.08] bg-[#0f0f11] px-3 py-2" style={{ borderColor: `${agentColor(a)}66` }}>
                      <GhostIcon color={agentColor(a)} size={16} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">
                          {a!.name} <span className="font-normal text-[#8e8e96]">{m.lead ? "leads" : (m.role || "builds").toLowerCase()}</span>
                        </div>
                        <div className="truncate text-[11.5px] text-[#8e8e96]">
                          {harnessLabel(a!.harness)}
                          {a!.computerId ? ` · ${computers.find((c) => c.id === a!.computerId)?.name ?? "computer"}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && <p className="text-[12.5px] text-[#ff6b6b]">{error}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="inline-flex h-8 items-center rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-3 text-[13px] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96]">
                Cancel
              </button>
              <button type="submit" disabled={!what.trim() || busy} className="inline-flex h-8 items-center gap-2 rounded-[7px] border border-[#f2f2f4] bg-[#f2f2f4] px-3 text-[13px] font-semibold text-[#0c0c0e] transition-[background-color,transform] hover:bg-white active:scale-[.96] disabled:opacity-40">
                Start <span className="text-[11px] font-normal opacity-60">⌘↵</span>
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
