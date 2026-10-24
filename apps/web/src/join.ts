import { api } from "./api.ts";

export interface JoinRequest {
  id: string;
  name: string;
  kind: string;
  platform: string;
  code: string;
  createdAt: string;
}
export type JoinEvent = { type: "join_request"; request: JoinRequest } | { type: "join_request_done"; id: string };
export const canApproveJoin = (role: string | undefined) => role === "owner" || role === "admin";
export const displayJoinCode = (code: string) => code.replace(/\s/g, "").replace(/^(\d{3})(\d{3})$/, "$1 $2");

/** Ignore unrelated events and deduplicate replayed requests. */
export function updateJoinRequests(requests: JoinRequest[], event: unknown): JoinRequest[] {
  const e = event as JoinEvent;
  if (e?.type === "join_request_done") return requests.filter((r) => r.id !== e.id);
  if (e?.type !== "join_request" || !e.request?.id || !/^\d{6}$/.test(e.request.code)) return requests;
  return [...requests.filter((r) => r.id !== e.request.id), e.request];
}

export function unavailable(error: unknown, feature: string): string {
  return (error as { status?: number })?.status === 404
    ? `${feature} isn't available yet; update Wisp on the computer it lives on.`
    : (error as Error).message || `Couldn't load ${feature.toLowerCase()}.`;
}

export interface McpClient {
  id: string;
  name: string;
  agentName?: string | null;
  createdAt?: string;
}
export async function loadMcpClients(): Promise<McpClient[] | null> {
  try {
    const result = await api<McpClient[] | { clients: McpClient[] }>("GET", "/api/mcp/clients");
    return Array.isArray(result) ? result : result.clients;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}
