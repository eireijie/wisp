import type { NodeInfo } from "./views/AgentSettings.tsx";
import { api } from "./api.ts";
import type { ComputerInfo } from "./store.ts";

/** The computer a new agent gets: a new VM or screen on its device, one that exists, or none. */
export type ComputerChoice =
  | { kind: "vm" }
  | { kind: "screen" }
  | { kind: "existing"; id: string }
  | { kind: "later" }
  | { kind: "headless" };

/**
 * Follow what the device does for agents (its role); otherwise reuse a shared computer first.
 * Someone's own screen is only the default on their own device set to lend it.
 */
export function defaultComputer(
  node: NodeInfo | undefined,
  computers: ComputerInfo[],
): ComputerChoice {
  if (node?.role === "headless") return { kind: "headless" };
  if (node?.role === "screen" && node.mine) {
    const screen = computers.find(
      (c) => c.kind === "device" && c.nodeId === node.id,
    );
    if (screen) return { kind: "existing", id: screen.id };
    if (node.capabilities?.screen.ok) return { kind: "screen" };
  }
  const shared =
    computers.find((c) => c.kind === "vm" && c.nodeId === node?.id) ??
    computers.find((c) => c.kind === "orgo");
  if (shared) return { kind: "existing", id: shared.id };
  if (node?.capabilities?.vm.ok) return { kind: "vm" };
  return { kind: "later" };
}

/** Turning headless off on a device whose role is headless: pick a computer later. */
export const withComputer = (c: ComputerChoice): ComputerChoice =>
  c.kind === "headless" ? { kind: "later" } : c;

/** Make the chosen computer (if it's new) and return its id; null for none. */
export async function resolveComputer(
  choice: ComputerChoice,
  nodeId: string,
  agentName: string,
): Promise<string | null> {
  if (choice.kind === "existing") return choice.id;
  if (choice.kind === "vm")
    return (
      await api<ComputerInfo>("POST", "/api/computers", {
        kind: "vm",
        nodeId,
        name: `${agentName}'s desk`,
      })
    ).id;
  if (choice.kind === "screen")
    return (
      await api<ComputerInfo>("POST", "/api/computers", {
        kind: "device",
        nodeId,
      })
    ).id;
  return null;
}

/** Does the agent go inside a VM on its device? Then Claude Code and Codex run in it. */
export function vmOnDevice(choice: ComputerChoice, nodeId: string, computers: ComputerInfo[]): boolean {
  return choice.kind === "vm" || (choice.kind === "existing" && computers.some((c) => c.id === choice.id && c.kind === "vm" && c.nodeId === nodeId));
}
