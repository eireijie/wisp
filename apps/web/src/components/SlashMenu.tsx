import { useEffect, useMemo, useState } from "react";
import { LayoutList } from "lucide-react";
import type { Agent, AgentCommand } from "@warren/core";
import { api } from "../api.ts";
import type { ChannelInfo } from "../store.ts";
import type { ChannelMember } from "./Channels.tsx";
import { AgentAvatar, harnessLabel, agentVar, cx } from "./ui.tsx";

/**
 * The "/" menu, like Discord's: type "/" at the start of a message and every agent here shows
 * what it can do, its own commands and skills, grouped under it with a rail of ghosts to jump
 * between them. Picking one writes "/name " (and "@handle " in a channel, so it goes to that agent).
 */

const KIND_LABEL: Record<AgentCommand["kind"], string> = { warren: "Warren", command: "Command", skill: "Skill", "warren-skill": "Skill" };

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

  const groups = here
    .filter((a) => !only || a.id === only)
    .map((agent) => ({ agent, items: (lists[agent.id] ?? []).filter((c) => c.name.toLowerCase().includes(query?.query ?? "")).sort((x, y) => Number(!x.name.toLowerCase().startsWith(query?.query ?? "")) - Number(!y.name.toLowerCase().startsWith(query?.query ?? ""))) }))
    .filter((g) => g.items.length);
  const flat: SlashItem[] = groups.flatMap((g) => g.items.map((command) => ({ agent: g.agent, command })));
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
      <div className="glass absolute bottom-full mb-2 left-0 right-0 max-w-xl rounded-2xl z-10 flex overflow-hidden" style={{ maxHeight: "min(22rem, 50vh)" }}>
        {here.length > 1 && (
          <div className="shrink-0 w-14 flex flex-col items-center gap-1.5 py-2 border-r border-line overflow-y-auto">
            <RailButton label="All agents" active={!only} onClick={() => setOnly(null)}>
              <LayoutList size={18} />
            </RailButton>
            {here.map((a) => (
              <RailButton key={a.id} label={a.name} active={only === a.id} onClick={() => setOnly(only === a.id ? null : a.id)}>
                <AgentAvatar agent={a} size={26} interactive={false} />
              </RailButton>
            ))}
          </div>
        )}
        <div role="listbox" aria-label="Commands" className="flex-1 min-w-0 overflow-y-auto p-1">
          {!flat.length && <div className="px-3 py-2.5 text-sm text-muted">Loading…</div>}
          {groups.map((g) => (
            <div key={g.agent.id}>
              <div className="px-2.5 pt-2 pb-1 text-xs text-muted flex items-center gap-1.5" style={agentVar(g.agent)}>
                <span className="font-semibold agent-ink">{g.agent.name}</span>
                <span>{harnessLabel(g.agent.harness)}</span>
              </div>
              {g.items.map((c) => {
                const selected = current?.agent.id === g.agent.id && current.command.name === c.name;
                return (
                  <button
                    key={c.name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    ref={(el) => {
                      if (selected) el?.scrollIntoView({ block: "nearest" });
                    }}
                    onMouseDown={(e) => (e.preventDefault(), onPick({ agent: g.agent, command: c }))}
                    className={cx("w-full px-2.5 py-1.5 rounded-xl flex items-center gap-3 text-left", selected && "bg-hover")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">
                        /{c.name}
                        {c.hint && <span className="ml-1.5 font-normal text-muted">{c.hint}</span>}
                      </span>
                      {c.description && <span className="block text-xs text-muted truncate">{c.description}</span>}
                    </span>
                    <span className="shrink-0 text-[11px] text-faint">{KIND_LABEL[c.kind]}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    ),
  };
}

function RailButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} onMouseDown={(e) => (e.preventDefault(), onClick())} className={cx("size-10 shrink-0 rounded-xl grid place-items-center text-muted hover:bg-hover", active && "bg-hover ring-1 ring-line text-ink")}>
      {children}
    </button>
  );
}
