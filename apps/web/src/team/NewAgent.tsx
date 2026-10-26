import { createContext, useContext, useEffect, useState } from "react";
import type { Agent } from "@wisp/core";
import { CreateAgent } from "../views/CreateAgent.tsx";
import { useDevices } from "../devices.ts";
import { useStore } from "../store.ts";

export const DEVICES_WAIT_MS = 3000;
/** The devices to open the dialog with: the list once it arrives, none once waiting has gone on too long, else null (keep waiting). */
export const devicesToShow = <T,>(devices: T[] | null, gaveUp: boolean): T[] | null => devices ?? (gaveUp ? [] : null);

/** The New agent dialog for a team being built: it hands the agent back instead of opening its page. */
export function NewAgentForTeam({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
  const devices = useDevices(15_000);
  // the device list can fail to load; the dialog still has to open (an agent can be made without one)
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGaveUp(true), DEVICES_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const nodes = devicesToShow(devices, gaveUp);
  if (!nodes) return null;
  return (
    <CreateAgent
      nodes={nodes}
      onClose={onClose}
      onCreated={async (a) => {
        await refreshAgents();
        onCreated(a);
      }}
    />
  );
}

/** Lets a field that picks an agent offer "Create an agent…": the builder shows the dialog and hands the new agent back. */
export const CreateAgentContext = createContext<((done: (agentId: string) => void) => void) | null>(null);
export const useCreateAgent = () => useContext(CreateAgentContext);
