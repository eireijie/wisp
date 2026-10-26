import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import { Button, Modal } from "../components/ui.tsx";
import { TeamBuilder } from "./Builder.tsx";
import { prepareTeam, withChart } from "./flow.ts";

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
