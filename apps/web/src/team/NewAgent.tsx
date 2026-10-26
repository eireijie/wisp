import { createContext, useContext } from "react";
import type { Agent } from "@wisp/core";
import { CreateAgent } from "../views/CreateAgent.tsx";
import { useDevices } from "../devices.ts";
import { useStore } from "../store.ts";

/** The New agent dialog for a team being built: it hands the agent back instead of opening its page. */
export function NewAgentForTeam({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
  const devices = useDevices(15_000);
  const refreshAgents = useStore((s) => s.refreshAgents);
  if (!devices) return null;
  return (
    <CreateAgent
      nodes={devices}
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
