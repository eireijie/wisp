import { runsInVm, type Agent } from "@wisp/core";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import { api } from "../../api.ts";
import type { DeviceInfo } from "../../devices.ts";
import type { ComputerInfo } from "../../store.ts";
import { freeHandle } from "../CreateAgent.tsx";

/**
 * Make the first agent: on the model connection Wisp keeps for it when there is one (the hub hands
 * it to each run, wherever the agent works), else on the harness's own sign-in where it runs.
 * Installs a new harness on the device when requested. `greetLater` holds its hello until
 * POST /api/agents/:id/greet, so it can greet with what it was just told.
 */
export async function makeFirstAgent(device: DeviceInfo, harness: string, name: string, agents: Agent[], computers: ComputerInfo[], appearance?: GhostAppearance, connectionId?: string, opts: { greetLater?: boolean } = {}) {
  const installed = device.harnesses?.some((h) => h.id === harness);
  const canVm = device.role !== "headless" && device.role !== "screen" && !!device.capabilities?.vm.ok;
  const inVm = !installed && runsInVm(harness) && canVm;
  if (!installed && !inVm) {
    await api("POST", `/api/nodes/${device.id}/install`, { harness });
    await api("POST", `/api/nodes/${device.id}/refresh`).catch(() => {});
  }
  const common = {
    name,
    handle: freeHandle(
      name,
      agents.map((a) => a.handle),
    ),
    harness,
    nodeId: device.id,
    ...(opts.greetLater ? { greet: "later" } : {}),
  };
  const look = { ...(appearance ? { appearance } : {}), ...(connectionId ? { connectionId } : {}) };
  if (inVm) {
    // an AI that only runs inside a computer gets one of its own, with the AI in it
    let computer = computers.find((c) => c.kind === "vm" && c.nodeId === device.id && !c.agents.length);
    if (!computer) computer = await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId: device.id, name: `${name}'s desk`, cpus: 2, memoryGb: 4 });
    return api<Agent>("POST", "/api/agents", { ...common, computerId: computer.id, settings: { runIn: "computer", ...look } });
  }
  // otherwise Wisp places it: the AI stays beside its sign-in, and it works on the shared computer
  return api<Agent>("POST", "/api/agents", { ...common, useDefaults: true, settings: look });
}
