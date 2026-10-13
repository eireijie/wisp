import { useEffect, useState } from "react";
import { BookOpen, Check, Clock, Loader2, MessagesSquare, Square, X } from "../icons.tsx";
import type { Discussion } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type DiscussionInfo } from "../store.ts";
import { go } from "../router.ts";
import { AgentAvatar, Button, Field, Input, Modal, Pill, Textarea, cx } from "./ui.tsx";

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

/** Pick a topic and the agents to talk it through; with a team, its members and lead are the defaults. */
export function StartDiscussion({ channelId, teamId, onClose }: { channelId?: string; teamId?: string; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const channels = useStore((s) => s.channels);
  const team = teams.find((t) => t.id === teamId) ?? teams.find((t) => t.channelId && t.channelId === channelId);
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("");
  const [picked, setPicked] = useState<string[]>(team ? team.members.map((m) => m.agentId) : []);
  const [moderator, setModerator] = useState(team?.leadId ?? "");
  const [rounds, setRounds] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const where = channels.find((c) => c.id === (channelId ?? team?.channelId));
  return (
    <Modal title="Start a discussion" onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const d = await api<DiscussionInfo>("POST", "/api/discussions", {
              topic,
              goal,
              participants: picked,
              moderator: moderator || undefined,
              rounds,
              team: team?.id,
              channelId: channelId ?? team?.channelId ?? undefined,
            });
            useStore.getState().setDiscussion(d);
            onClose();
            go({ view: "chat", channelId: d.channelId, threadId: d.threadId });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <p className="text-sm text-muted">
          Round 1, everyone answers on their own; after that they respond to each other. Then the moderator writes the decision, which is saved to {team ? `${team.folder}/decisions/` : "shared/decisions/"}, and hands out tasks. It happens in a thread{where ? ` in #${where.name}` : ""}.
        </p>
        <Field label="Topic">
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="How should we build sign-in?" required />
        </Field>
        <Field label="What it should decide (optional)">
          <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Pick an approach and split the work." />
        </Field>
        <div>
          <div className="text-sm font-medium mb-1.5">Who takes part</div>
          <div className="flex flex-wrap gap-1.5">
            {agents.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => toggle(a.id)}
                aria-pressed={picked.includes(a.id)}
                className={cx("inline-flex items-center gap-1.5 rounded-full border pl-0.5 pr-2.5 h-8 text-sm", picked.includes(a.id) ? "border-accent bg-accent-soft text-ink" : "border-line text-muted hover:text-ink")}
              >
                <AgentAvatar agent={a} size={26} badge={false} />@{a.handle}
              </button>
            ))}
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Moderator" hint="Writes the decision and hands out the tasks.">
            <select value={moderator} onChange={(e) => setModerator(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
              <option value="">{team?.leadId ? "The team lead" : "The first participant"}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.handle}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rounds" hint="Each round every participant answers once.">
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} round{n === 1 ? "" : "s"} ({n * picked.length + 1} replies)
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!topic.trim() || picked.length < 2}>
            Start discussion
          </Button>
        </div>
      </form>
    </Modal>
  );
}
