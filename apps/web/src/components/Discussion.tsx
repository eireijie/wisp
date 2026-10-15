import { useEffect, useState } from "react";
import { BookOpen, Check, Clock, Loader2, MessagesSquare, Square, X } from "lucide-react";
import type { Discussion } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type DiscussionInfo } from "../store.ts";
import { go } from "../router.ts";
import { AgentAvatar, Pill } from "./ui.tsx";

const STATUS: Record<Discussion["status"], { label: string; tone: "info" | "accent" | "ok" | "neutral" }> = {
  running: { label: "in progress", tone: "info" },
  summarizing: { label: "writing the decision", tone: "accent" },
  done: { label: "decided", tone: "ok" },
  cancelled: { label: "stopped", tone: "neutral" },
};

/** Live progress of a discussion: which round, who has answered, and the decision once it's written. */
export function DiscussionCard({ id }: { id: string }) {
  const d = useStore((s) => s.discussions[id]);
  const load = useStore((s) => s.loadDiscussion);
  const agents = useStore((s) => s.agents);
  const isGuest = useStore((s) => s.me?.role === "guest");
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!d) load(id);
  }, [d, id, load]);
  if (!d) return null;

  const live = d.status === "running" || d.status === "summarizing";
  const phase = d.status === "summarizing" ? "Writing the decision" : d.status === "running" ? `Round ${Math.max(d.round, 1)} of ${d.rounds}` : null;
  const state = (agentId: string) => d.progress.find((p) => p.agentId === agentId)?.status;
  const who = d.status === "summarizing" ? [d.moderatorId] : d.participants;

  return (
    <div className="mt-2 max-w-xl rounded-xl border border-line bg-bg p-3 text-sm">
      <div className="flex items-center gap-2">
        <MessagesSquare size={15} className="text-accent-text shrink-0" />
        <span className="font-medium truncate flex-1">{d.topic}</span>
        <Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill>
      </div>
      {live && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">{phase}:</span>
          {who.map((a) => {
            const agent = agents.find((x) => x.id === a);
            const s = state(a);
            return (
              <span key={a} className="inline-flex items-center gap-1 rounded-full bg-hover pl-0.5 pr-2 h-6 text-xs" title={s === "running" ? "answering" : s === "queued" ? "waiting for its device" : s ?? ""}>
                <AgentAvatar agent={agent} size={20} badge={false} />@{agent?.handle}
                {s === "done" ? <Check size={12} className="text-ok" /> : s === "running" ? <Loader2 size={12} className="animate-spin text-info" /> : s === "queued" ? <Clock size={12} className="text-warn" /> : s ? <X size={12} className="text-muted" /> : null}
              </span>
            );
          })}
          {!isGuest && (
            <button
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                await api("POST", `/api/discussions/${d.id}/cancel`).catch(() => {});
                await load(d.id);
                setStopping(false);
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 h-6 text-xs text-muted hover:text-bad hover:bg-hover"
            >
              <Square size={11} /> Stop
            </button>
          )}
        </div>
      )}
      {d.decisionPath && (
        <button onClick={() => go({ view: "vault", path: d.decisionPath })} className="mt-2 inline-flex items-center gap-1.5 text-accent-text hover:underline text-sm">
          <BookOpen size={14} /> Read the decision
        </button>
      )}
    </div>
  );
}
