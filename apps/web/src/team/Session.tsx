import { useState } from "react";
import { createPortal } from "react-dom";
import { migrateTeam, stepAgentId, type ChannelTeam } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import { Button, Modal } from "../components/ui.tsx";
import { TeamBuilder } from "./Builder.tsx";
import { emptyTeam, relayout, withChart } from "./flow.ts";

/** A saved team ready to edit: an older linear team becomes a flow chart (prompts on the steps, every arrow spelled out), and each step names its agent. */
export function prepareTeam(team: ChannelTeam | null | undefined, liveAgents?: Set<string>): ChannelTeam {
  const base = team ?? emptyTeam();
  const migrated = migrateTeam({ ...base, roles: base.roles ?? [], steps: base.steps ?? [] });
  const steps = (migrated.steps ?? []).map((s) => {
    const agentId = s.agentId ?? stepAgentId(migrated, s);
    // an agent that is gone needs someone new
    return { ...s, agentId: agentId && liveAgents?.size && !liveAgents.has(agentId) ? null : agentId };
  });
  const out = { ...base, roles: migrated.roles ?? [], steps };
  // steps that were never laid out (an agent drew them) get a place on the chart
  return steps.length > 1 && steps.every((s) => s.x === steps[0].x && s.y === steps[0].y) ? relayout(out) : out;
}

/** Editing how an existing team works: the builder over the team's own steps, saved to its channel. */
export function TeamEditSession({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const refreshChannels = useStore((s) => s.refreshChannels);
  const live = useStore((s) => s.channels.find((c) => c.id === channel.id)) ?? channel;
  const agents = useStore((s) => s.agents);
  const [original] = useState(() => prepareTeam(live.settings.team, new Set(agents.map((a) => a.id))));
  const [team, setTeam] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const changed = JSON.stringify(team) !== JSON.stringify(original);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // empty roles say to drop them (left out, the hub keeps the old ones)
      await api("PATCH", `/api/channels/${channel.id}`, { settings: { team: withChart({ ...team, roles: team.roles ?? [] }) } });
      await refreshChannels();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TeamBuilder team={team} onChange={setTeam} name={live.name} channelId={channel.id} saving={busy} error={error} onBack={() => (changed ? setDiscarding(true) : onClose())} onDone={() => void save()} />
      {discarding &&
        createPortal(
        <Modal title="Leave without saving?" onClose={() => setDiscarding(false)}>
          <p className="text-sm text-muted">The changes you made to how {live.name} works will be lost.</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button type="button" variant="primary" onClick={() => setDiscarding(false)} className="h-11">
              Keep editing
            </Button>
            <Button type="button" variant="danger" onClick={onClose} className="h-11">
              Discard changes
            </Button>
          </div>
        </Modal>,
        document.body,
      )}
    </>
  );
}
