import { useEffect, useMemo, useState } from "react";
import { harnessLabel, type Agent, type AgentCommand } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import type { ChannelMember } from "./Channels.tsx";
import { agentVar, cx } from "./ui.tsx";

/**
 * The "/" menu, like Discord's: type "/" at the start of a message and every agent here shows
 * what it can do, in sections: skills agents learned, the harness's own commands and skills, Wisp's
 * commands, then other Wisp skills. Picking one writes "/name " (and "@handle " in a channel, so it
 * goes to that agent).
 */

const GROUP_ORDER: Record<AgentCommand["group"], number> = { learned: 0, harness: 1, wisp: 2, skill: 3 };

/** The menu section a command belongs in (older hubs don't say, so it's worked out from its kind). */
export function commandGroup(c: Pick<AgentCommand, "kind"> & { group?: AgentCommand["group"] }): AgentCommand["group"] {
  return c.group ?? (c.kind === "wisp" ? "wisp" : c.kind === "wisp-skill" ? "skill" : "harness");
}

/** A section's key and its small header: "Learned by Ghosty", "Codex", "Wisp", "Skills". */
export function slashSection(item: SlashItem): { key: string; label: string } {
  const c = item.command;
  switch (commandGroup(c)) {
    case "learned":
      return { key: `learned:${c.learnedBy ?? ""}`, label: c.learnedBy ? `Learned by ${c.learnedBy}` : "Learned" };
    case "harness":
      return { key: `harness:${item.agent.harness}`, label: harnessLabel(item.agent.harness) };
    case "wisp":
      return { key: "wisp", label: "Wisp" };
    default:
      return { key: "skill", label: "Skills" };
  }
}

/**
 * The rows in menu order: sections in group order (sections of one group, e.g. two harnesses, in the
 * order they first appear), and within a section the names that start with what was typed first.
 */
export function orderSlashRows(rows: SlashItem[], query = ""): SlashItem[] {
  const first = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = slashSection(r).key;
    if (!first.has(k)) first.set(k, i);
  });
  const q = query.toLowerCase();
  const rank = (r: SlashItem) => Number(!r.command.name.toLowerCase().startsWith(q));
  return rows
    .map((r, i) => ({ r, i, g: GROUP_ORDER[commandGroup(r.command)], s: first.get(slashSection(r).key)!, k: rank(r) }))
    .sort((a, b) => a.g - b.g || a.s - b.s || a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

const cache = new Map<string, { at: number; list: Promise<AgentCommand[]> }>();
// a skill learned, edited, shared or forgotten changes what "/" shows
useStore.subscribe((s, prev) => {
  if (s.skillsVersion !== prev.skillsVersion) cache.clear();
});
/** An agent's "/" list, fetched at most once a minute (and again once skills change). Exported for tests. */
export function commandsOf(agentId: string): Promise<AgentCommand[]> {
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
  const all = here.filter((a) => !only || a.id === only).flatMap((agent) => (lists[agent.id] ?? []).filter(matches).map((command) => ({ agent, command })));
  // with everyone's commands showing, a command they all share (/context, /model) is listed once
  const merged = !only && here.length > 1;
  const rows: SlashItem[] = orderSlashRows(merged ? all.filter((r, i) => all.findIndex((x) => x.command.name === r.command.name) === i) : all, query?.query);
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
      <div className="glass m-menu absolute bottom-full mb-2 left-0 right-0 max-w-xl rounded-xl z-10 flex flex-col overflow-hidden" style={{ maxHeight: "min(26rem, 55vh)" }}>
        {here.length > 1 && (
          <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto px-2 pt-2 pb-1" role="group" aria-label="Whose commands">
            <Chip label="All agents" active={!only} onClick={() => setOnly(null)} />
            {here.map((a) => (
              <Chip key={a.id} label={a.name} active={only === a.id} onClick={() => setOnly(only === a.id ? null : a.id)} />
            ))}
          </div>
        )}
        <div role="listbox" aria-label="Commands" className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {!flat.length && <div className="px-2.5 py-2 text-[13px] text-muted">Loading…</div>}
          {rows.map((item, i) => {
            const { agent, command: c } = item;
            const selected = current?.agent.id === agent.id && current.command.name === c.name;
            const section = slashSection(item);
            const header = i === 0 || slashSection(rows[i - 1]).key !== section.key;
            return (
              <div key={`${agent.id}:${c.name}`} role="presentation">
                {header && (
                  <div role="presentation" className={cx("px-2.5 pb-1 text-xs font-medium uppercase tracking-[0.04em] text-faint", i === 0 ? "pt-1.5" : "pt-2.5")}>
                    {section.label}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  ref={(el) => {
                    if (selected) el?.scrollIntoView({ block: "nearest" });
                  }}
                  onMouseDown={(e) => (e.preventDefault(), onPick(item))}
                  className={cx("w-full px-2.5 min-h-11 md:min-h-9 rounded-lg flex items-center gap-2.5 text-left", selected && "bg-hover")}
                >
                  <span className="shrink-0 whitespace-nowrap text-sm font-medium">
                    /{c.name}
                    {c.hint && <span className="ml-1.5 font-normal text-muted">{c.hint}</span>}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{c.description}</span>
                  {c.isNew && <span className="shrink-0 rounded-[5px] border border-line px-1.5 text-[11px] font-medium leading-4 text-muted">new</span>}
                  {!merged && here.length > 1 && (
                    <span className="shrink-0 text-[11px] text-faint" style={agentVar(agent)}>
                      {agent.name}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    ),
  };
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onMouseDown={(e) => (e.preventDefault(), onClick())} className={cx("h-7 shrink-0 rounded-md px-2.5 text-[13px] font-medium", active ? "bg-accent text-accent-ink" : "border border-control-line bg-control text-muted hover:text-ink")}>
      {label}
    </button>
  );
}
