import { useEffect, useState } from "react";
import { MODEL_PROVIDER_INFO, harnessLabel, providerLabel, type AccessLevel, type Agent, type ConnectionModel, type HarnessCatalog, type ModelConnection, type ModelProvider, type ModelProviderInfo, type CredentialSupport, type PlanUsage } from "@wisp/core";
import { api } from "./api.ts";
import { useStore } from "./store.ts";

/**
 * Models are the brain, harnesses the body: the data behind the chat's model line, its pickers,
 * and Settings → Models and Harnesses. The hub keeps model connections (a sign-in or an API key);
 * an agent runs on one (settings.connectionId) or on its computer's own sign-in.
 */

/** What /api/agents/:id/context says about who you're talking to. */
export interface AgentContext {
  harness: string;
  harnessVersion: string | null;
  model: string | null;
  modelIsDefault: boolean;
  effort: string | null;
  effortIsDefault: boolean;
  access: AccessLevel;
  fast: boolean;
  fastAvailable: boolean;
  fastDescription: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  lastRunAt: string | null;
  /** effort levels the model in use offers (else the harness's) */
  efforts?: string[];
  connection?: { id: string; provider: ModelProvider; kind: "oauth" | "key"; label: string; account: string | null; plan: string | null } | null;
  plan?: (PlanUsage & { capturedAt?: string }) | null;
}

/** What /api/agents/:id/models says: the computer's catalog, and the connection's models when it has one. */
export interface AgentModels {
  device: { id: string; name: string; online: boolean } | null;
  computer: { id: string; name: string; reported: boolean } | null;
  catalog: HarnessCatalog | null;
  connection: { id: string; provider: ModelProvider; kind: "oauth" | "key"; label: string; account: string | null; plan: string | null; mine: boolean } | null;
  models: ConnectionModel[] | null;
}

/** One computer on Settings → Harnesses (GET /api/harnesses). */
export interface HarnessComputer {
  id: string;
  kind: "device" | "vm";
  name: string;
  nodeId: string;
  online: boolean;
  reported: boolean;
  harnesses: { id: string; label: string; version: string | null; agents: { id: string; handle: string; name: string }[] }[];
}

export const tokens = (n: number) => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

const EFFORT: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
/** "High", "Extra high". */
export const effortLabel = (e: string) => EFFORT[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
const SHORT: Record<string, string> = { minimal: "Min", medium: "Med", xhigh: "X-High" };
/** Shorter names when many levels share one row. */
export const effortShort = (e: string, many: boolean) => (many ? (SHORT[e] ?? effortLabel(e)) : effortLabel(e));

/** "GPT-6-Luna" → "GPT-6 Luna". */
export const prettyModel = (label: string) => label.replace(/(\d)-(?=[A-Z])/g, "$1 ");

/** Which provider a harness signs in to on its own, for the grey name next to a model it runs on its own login. */
const OWN_PROVIDER: Record<string, ModelProvider> = { "claude-code": "anthropic", codex: "openai" };

/** The model's display name and its provider, from the connection's list or the computer's catalog. */
export function modelName(ctx: Pick<AgentContext, "model" | "harness" | "connection">, models: AgentModels | null): { name: string; provider: string | null } {
  const id = ctx.model;
  const entry = models?.models?.find((m) => m.id === id) ?? models?.catalog?.models.find((m) => m.id === id);
  const provider = ctx.connection?.provider ?? OWN_PROVIDER[ctx.harness] ?? null;
  return { name: id ? prettyModel(entry?.label ?? id) : "Default model", provider: provider ? providerLabel(provider) : null };
}

/** The chat's quiet line: "Hermes · Opus 5.5 · High" on phones, "Opus 5.5 · High" in the desktop composer. */
export function runLine(ctx: AgentContext, models: AgentModels | null, withHarness: boolean): string {
  return [withHarness ? harnessLabel(ctx.harness) : null, modelName(ctx, models).name, ctx.effort ? effortLabel(ctx.effort) : null].filter(Boolean).join(" · ");
}

/** How full the context is: the share, and "98K of 258K". */
export function contextLine(ctx: Pick<AgentContext, "contextUsed" | "contextWindow">): { pct: number | null; left: string; right: string } {
  const pct = ctx.contextUsed !== null && ctx.contextWindow ? Math.min(100, (ctx.contextUsed / ctx.contextWindow) * 100) : null;
  return {
    pct,
    left: pct === null ? "Context" : `Context ${pct < 1 ? "<1" : Math.round(pct)}%`,
    right: ctx.contextUsed !== null ? `${tokens(ctx.contextUsed)}${ctx.contextWindow ? ` of ${tokens(ctx.contextWindow)}` : ""}` : ctx.contextWindow ? `${tokens(ctx.contextWindow)} window` : "After the first reply",
  };
}

export const contextColor = (pct: number | null) => (pct === null ? "var(--faint)" : pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--ok)");

/** "1:40 AM" today, "Mon 1:40 AM" later in the week, "Nov 3" beyond. */
export function resetTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hours = (d.getTime() - now.getTime()) / 3_600_000;
  const time = d.toLocaleString([], { hour: "numeric", minute: "2-digit" });
  if (hours < 24 && d.getDate() === now.getDate()) return time;
  if (hours < 24 * 6) return `${d.toLocaleString([], { weekday: "short" })} ${time}`;
  return d.toLocaleString([], { month: "short", day: "numeric" });
}

/** How much of a plan is left: "26% left · resets 1:40 AM". */
export function planLeft(plan: Pick<PlanUsage, "usedFraction" | "resetsAt">, now = new Date()): { left: number; text: string } {
  const left = Math.max(0, Math.min(100, Math.round((1 - plan.usedFraction) * 100)));
  return { left, text: `${left}% left${plan.resetsAt ? ` · resets ${resetTime(plan.resetsAt, now)}` : ""}` };
}

/** "5-hour window", "This week". */
export function windowName(window: string): string {
  if (/week/i.test(window)) return "This week";
  if (/day|daily/i.test(window)) return "Today";
  if (/month/i.test(window)) return "This month";
  return /window/i.test(window) ? window : `${window} window`;
}

/** "Signed in · Max · yug@…" or "API key ····a91f". */
export function connectionSub(c: Pick<ModelConnection, "kind" | "plan" | "account" | "keyHint">, short = false): string {
  if (c.kind === "key") return `Key ····${c.keyHint ?? ""}`;
  return ["Signed in", c.plan, short ? null : c.account].filter(Boolean).join(" · ");
}

/** The name a connection goes by in a list: the provider, or its own label when there are two of a provider. */
export function connectionName(c: Pick<ModelConnection, "id" | "provider" | "label">, all: Pick<ModelConnection, "id" | "provider">[]): string {
  return all.some((o) => o.id !== c.id && o.provider === c.provider) ? c.label : providerLabel(c.provider);
}

/** Connections a harness can run on, in the order they were made. */
export function connectionsFor(harness: string, connections: ModelConnection[]): ModelConnection[] {
  return connections.filter((c) => c.harnesses.includes(harness));
}

/** Whether a harness can use a connection (the shared support table). */
export function canUse(support: Pick<CredentialSupport, "harness" | "provider" | "kind">[], harness: string, c: { provider: string; kind: string } | null | undefined): boolean {
  return !c || support.some((s) => s.harness === harness && s.provider === c.provider && s.kind === c.kind);
}

/** The computer an agent's harness runs on: its VM when it runs in one, else its device. */
export function agentComputer(agent: Pick<Agent, "nodeId">, models: Pick<AgentModels, "computer"> | null, computers: HarnessComputer[]): HarnessComputer | undefined {
  if (models?.computer) return computers.find((c) => c.kind === "vm" && c.id === models.computer!.id);
  return computers.find((c) => c.kind === "device" && c.id === agent.nodeId);
}

/** The ways to connect a provider: sign in (when it has one) and an API key. */
export function connectWays(p: ModelProviderInfo): ("oauth" | "key")[] {
  return p.signIn?.length ? ["oauth", "key"] : ["key"];
}

export const PROVIDERS = Object.values(MODEL_PROVIDER_INFO);

/** The site a sign-in opens, without the scheme: "claude.ai". */
export const siteName = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// --- loading ------------------------------------------------------------------------------------

/** The person's model connections, refetched when the hub says they changed. */
export function useConnections(): { connections: ModelConnection[] | null; support: CredentialSupport[]; reload: () => void } {
  const version = useStore((s) => s.modelsVersion);
  const [connections, setConnections] = useState<ModelConnection[] | null>(null);
  const [support, setSupport] = useState<CredentialSupport[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ connections: ModelConnection[] }>("GET", "/api/model-connections").then((r) => live && setConnections(r.connections), () => live && setConnections([]));
    return () => {
      live = false;
    };
  }, [version, n]);
  useEffect(() => {
    api<{ support: CredentialSupport[] }>("GET", "/api/model-providers").then((r) => setSupport(r.support), () => {});
  }, []);
  return { connections, support, reload: () => setN((x) => x + 1) };
}

/** Every computer and the harnesses on it. */
export function useHarnessComputers(): { computers: HarnessComputer[] | null; error: string | null; reload: () => void } {
  const [computers, setComputers] = useState<HarnessComputer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const agentsKey = useStore((s) => s.agents.map((a) => `${a.id}:${a.harness}:${a.nodeId}:${a.computerId}`).join(","));
  useEffect(() => {
    let live = true;
    api<{ computers: HarnessComputer[] }>("GET", "/api/harnesses").then(
      (r) => live && (setComputers(r.computers), setError(null)),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [n, agentsKey]);
  return { computers, error, reload: () => setN((x) => x + 1) };
}

/** A connection's models as `harness` runs them (cached for the page's life). */
const modelCache = new Map<string, Promise<ConnectionModel[]>>();
export function connectionModels(connectionId: string, harness: string, agentId?: string): Promise<ConnectionModel[]> {
  const key = `${connectionId}|${harness}|${agentId ?? ""}`;
  let p = modelCache.get(key);
  if (!p) {
    p = api<{ models: ConnectionModel[] }>("GET", `/api/model-connections/${connectionId}/models?harness=${encodeURIComponent(harness)}${agentId ? `&agent=${agentId}` : ""}`).then((r) => r.models);
    p.catch(() => modelCache.delete(key));
    modelCache.set(key, p);
  }
  return p;
}
export const forgetConnectionModels = () => modelCache.clear();

/**
 * Everything the chat shows about an agent: settings, its computer's model catalog and its
 * connection's models, and how full this conversation's context is. Refreshes after each reply
 * and whenever its harness, model, effort or connection changes.
 */
export function useAgentContext(agentId: string | undefined, channelId: string, threadId?: string) {
  const agent = useStore((s) => (agentId ? s.agents.find((a) => a.id === agentId) : undefined));
  const messages = useStore((s) => (threadId ? s.threads[threadId] : s.messages[channelId]));
  const modelsVersion = useStore((s) => s.modelsVersion);
  const [ctx, setCtx] = useState<AgentContext | null>(null);
  const [models, setModels] = useState<AgentModels | null>(null);
  const lastAgentMsg = [...(messages ?? [])].reverse().find((m) => m.author.kind === "agent")?.id;
  const settingsKey = agent ? `${agent.harness}|${agent.model}|${agent.settings.effort}|${agent.settings.access}|${agent.settings.fast}|${agent.settings.connectionId}|${agent.nodeId}|${agent.computerId}` : "";
  useEffect(() => {
    if (!agentId) return;
    api<AgentContext>("GET", `/api/agents/${agentId}/context?channel=${channelId}${threadId ? `&thread=${threadId}` : ""}`).then(setCtx, () => setCtx(null));
  }, [agentId, channelId, threadId, lastAgentMsg, settingsKey, modelsVersion]);
  useEffect(() => {
    if (!agentId) return;
    api<AgentModels>("GET", `/api/agents/${agentId}/models`).then(setModels, () => setModels(null));
  }, [agentId, settingsKey]);
  return { agent, ctx, models, catalog: models?.catalog ?? null };
}

export async function patchAgent(agentId: string, body: unknown) {
  await api("PATCH", `/api/agents/${agentId}`, body);
  await useStore.getState().refreshAgents();
}
