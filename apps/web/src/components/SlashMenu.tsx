import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentCommand } from "@wisp/core";
import { api } from "../api.ts";
import type { ChannelInfo } from "../store.ts";
import type { ChannelMember } from "./Channels.tsx";
import { agentVar, cx } from "./ui.tsx";

/**
 * The "/" menu, like Discord's: type "/" at the start of a message and every agent here shows
 * what it can do, its own commands and skills, grouped under it with a rail of ghosts to jump
 * between them. Picking one writes "/name " (and "@handle " in a channel, so it goes to that agent).
 */

const KIND_LABEL: Record<AgentCommand["kind"], string> = { wisp: "Wisp", command: "Command", skill: "Skill", "wisp-skill": "Skill" };

const cache = new Map<string, { at: number; list: Promise<AgentCommand[]> }>();
function commandsOf(agentId: string): Promise<AgentCommand[]> {
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = api<{ commands: AgentCommand[] }>("GET", `/api/agents/${agentId}/commands`).then((r) => r.commands, () => []);
  cache.set(agentId, { at: Date.now(), list });
  return list;
}

/** The commands an agent has, for showing a button only when it can do that ("compact"). */
export function useAgentCommands(agentId: string | undefined) {
  const [list, setList] = useState<AgentCommand[]>([]);
  useEffect(() => {
    if (agentId) commandsOf(agentId).then(setList);
  }, [agentId]);
  return list;
}

export interface SlashItem {
  agent: Agent;
  command: AgentCommand;
}

/** "/que" (or "@poopy /que") from the start of the message up to the caret, or null when the menu shouldn't show. */
export function slashQuery(beforeCaret: string): { handle: string | null; query: string } | null {
  const m = /^\s*(?:@([\w-]+)\s+)?\/([\w:.-]*)$/.exec(beforeCaret);
  return m ? { handle: m[1]?.toLowerCase() ?? null, query: m[2].toLowerCase() } : null;
}

export function useSlashMenu({ query, channel, dmAgent, agents }: { query: { handle: string | null; query: string } | null; channel: ChannelInfo | undefined; dmAgent: Agent | undefined; agents: Agent[] }) {
  const [members, setMembers] = useState<string[] | null>(null);
  const [lists, setLists] = useState<Record<string, AgentCommand[]>>({});
  const [only, setOnly] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const open = !!query && !!channel;
  const channelId = channel?.id;
  const isDm = channel?.kind === "dm";

  // the agents in this channel (everyone's, if it has none yet)
  useEffect(() => {
    setMembers(null);
    setOnly(null);
  }, [channelId]);
  useEffect(() => {
    if (!open || isDm || members) return;
    api<ChannelMember[]>("GET", `/api/channels/${channelId}/members`).then(
      (m) => setMembers(m.filter((x) => x.kind === "agent").map((x) => x.id)),
      () => setMembers([]),
    );
  }, [open, isDm, channelId, members]);

  const here = useMemo(() => {
    if (isDm) return dmAgent ? [dmAgent] : [];
    const named = query?.handle ? agents.filter((a) => a.handle === query.handle) : [];
    if (named.length) return named;
    const inChannel = members ? agents.filter((a) => members.includes(a.id)) : [];
    return inChannel.length ? inChannel : agents;
  }, [isDm, dmAgent, agents, members, query?.handle]);

  useEffect(() => {
    if (!open) return;
    for (const a of here) if (!lists[a.id]) commandsOf(a.id).then((list) => setLists((cur) => ({ ...cur, [a.id]: list })));
  }, [open, here, lists]);

  useEffect(() => setPick(0), [query?.query, only]);

  const matches = (c: AgentCommand) => c.name.toLowerCase().includes(query?.query ?? "");
  const rank = (c: AgentCommand) => Number(!c.name.toLowerCase().startsWith(query?.query ?? ""));
  const groups = here
    .filter((a) => !only || a.id === only)
    .map((agent) => ({ agent, items: (lists[agent.id] ?? []).filter(matches).sort((x, y) => rank(x) - rank(y)) }))
    .filter((g) => g.items.length);
  // with everyone's commands showing, a command they all share (/context, /model) is listed once
  const merged = !only && here.length > 1;
  const rows: SlashItem[] = merged
    ? [...new Map(groups.flatMap((g) => g.items.map((command) => [command.name, { agent: g.agent, command }] as const)).reverse()).values()].reverse().sort((x, y) => rank(x.command) - rank(y.command))
    : groups.flatMap((g) => g.items.map((command) => ({ agent: g.agent, command })));
  const flat = rows;
  const current = flat.length ? flat[((pick % flat.length) + flat.length) % flat.length] : undefined;

  /** What the message box should say after picking. */
  const textFor = (item: SlashItem) => `${isDm ? "" : `@${item.agent.handle} `}/${item.command.name} `;

  return {
    open: open && (flat.length > 0 || here.some((a) => !lists[a.id])),
    flat,
    current,
    move: (by: number) => setPick((p) => p + by),
    textFor,
    render: (onPick: (item: SlashItem) => void) => (
      <div className="glass absolute bottom-full mb-2 left-0 right-0 max-w-xl rounded-3xl z-10 flex flex-col overflow-hidden" style={{ maxHeight: "min(24rem, 55vh)" }}>
        {here.length > 1 && (
          <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto px-3 pt-3 pb-1.5" role="group" aria-label="Whose commands">
            <Chip label="All agents" active={!only} onClick={() => setOnly(null)} />
            {here.map((a) => (
              <Chip key={a.id} label={a.name} active={only === a.id} onClick={() => setOnly(only === a.id ? null : a.id)} />
            ))}
          </div>
        )}
        <div role="listbox" aria-label="Commands" className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {!flat.length && <div className="px-3 py-2.5 text-sm text-muted">Loading…</div>}
          {rows.map(({ agent, command: c }) => {
            const selected = current?.agent.id === agent.id && current.command.name === c.name;
            return (
              <button
                key={`${agent.id}:${c.name}`}
                type="button"
                role="option"
                aria-selected={selected}
                ref={(el) => {
                  if (selected) el?.scrollIntoView({ block: "nearest" });
                }}
                onMouseDown={(e) => (e.preventDefault(), onPick({ agent, command: c }))}
                className={cx("w-full px-3 py-2 min-h-12 rounded-2xl flex items-center gap-3 text-left", selected && "bg-hover")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium truncate">
                    /{c.name}
                    {c.hint && <span className="ml-1.5 font-normal text-muted">{c.hint}</span>}
                  </span>
                  {c.description && <span className="block text-[13px] text-muted truncate">{c.description}</span>}
                </span>
                {!merged && here.length > 1 ? (
                  <span className="shrink-0 text-[11px] text-faint" style={agentVar(agent)}>
                    {agent.name}
                  </span>
                ) : c.kind === "skill" || c.kind === "wisp-skill" ? (
                  <span className="shrink-0 text-[11px] text-faint">{KIND_LABEL[c.kind]}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    ),
  };
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onMouseDown={(e) => (e.preventDefault(), onClick())} className={cx("h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium", active ? "bg-accent text-accent-ink" : "border border-control-line bg-control text-muted hover:text-ink")}>
      {label}
    </button>
  );
}
