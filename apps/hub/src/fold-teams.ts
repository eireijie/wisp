import { teamProblem, type ChannelTeam, type ChannelTeamNode } from "@wisp/core";
import type { Store } from "./store.ts";

type TeamRow = { id: string; workspace_id: string; name: string; emoji: string; description: string; lead_id: string | null; reports_to: string | null; channel_id: string | null; folder: string; repo: string | null; base_branch: string };
type MemberRow = { agent_id: string; role: string; role_notes: string; manager_id: string | null; x: number | null; y: number | null };

// the team chart's card size and spacing (apps/web/src/components/TeamChart.tsx)
const W = 184;
const GAP = 28;
const ROW = 132;
const PAD = 24;

/**
 * Teams used to be their own thing, next to channels. Now a channel's team is the only kind, so
 * each old team folds into its channel (one is made when it had none): members become the chart
 * (the lead leads, each agent gets work from whoever it reported to), and its roles, memory
 * folder, repo and boss come along. Rules that named the team name the channel now, and its
 * tasks belong to the channel. Returns the folded teams, so their briefs can be checked.
 */
export function foldTeams(store: Store): { workspaceId: string; channelId: string; name: string; folder: string }[] {
  const db = store.db;
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'teams'").get();
  if (!has) return [];
  const rows = db.prepare("SELECT * FROM teams ORDER BY created_at").all() as TeamRow[];
  if (!rows.length) return [];
  const out: { workspaceId: string; channelId: string; name: string; folder: string }[] = [];
  db.transaction(() => {
    // rules move in two steps, so a team named like another team's new channel can't collide
    for (const t of rows) store.renameTeamRules(t.workspace_id, t.name, `#fold#${t.id}`);
    for (const t of rows) {
      // the lead first, then in the order they joined
      const members = (db.prepare("SELECT agent_id, role, role_notes, manager_id, x, y FROM team_members WHERE team_id = ? ORDER BY agent_id = ? DESC, rowid").all(t.id, t.lead_id) as MemberRow[]).filter((m) => store.agent(m.agent_id));
      let ch = t.channel_id ? store.channel(t.channel_id) : undefined;
      if (!ch || ch.kind !== "channel") ch = store.channelByName(t.workspace_id, `team-${t.name}`) ?? store.createChannel(t.workspace_id, `team-${t.name}`, "channel");
      const topic = ch.topic || [t.emoji, t.description].filter(Boolean).join(" ").trim();
      const chart = mergeCharts(ch.settings.team, chartOf(t, members));
      store.updateChannel(ch.id, { topic, archivedAt: null, settings: { team: chart, replyInThread: true } });
      for (const m of members) store.addChannelMember(ch.id, { kind: "agent", id: m.agent_id });
      for (const p of store.members(t.workspace_id).filter((m) => m.role === "owner")) store.addChannelMember(ch.id, { kind: "user", id: p.id });
      store.renameTeamRules(t.workspace_id, `#fold#${t.id}`, ch.name);
      db.prepare("UPDATE tasks SET team_id = ? WHERE team_id = ?").run(ch.id, t.id);
      db.prepare("DELETE FROM teams WHERE id = ?").run(t.id);
      out.push({ workspaceId: t.workspace_id, channelId: ch.id, name: ch.name, folder: t.folder });
    }
  })();
  return out;
}

/** An old team as a channel chart: the lead (or whoever's at the top) leads, and reporting lines become hand-offs. */
export function chartOf(t: Pick<TeamRow, "lead_id" | "reports_to" | "folder" | "repo" | "base_branch">, members: MemberRow[]): ChannelTeam {
  const ids = new Set(members.map((m) => m.agent_id));
  const manager = (m: MemberRow) => (m.manager_id && ids.has(m.manager_id) && m.manager_id !== m.agent_id ? m.manager_id : null);
  const lead = t.lead_id && ids.has(t.lead_id) ? t.lead_id : (members.find((m) => !manager(m))?.agent_id ?? members[0]?.agent_id ?? null);
  let edges: ChannelTeam["edges"] = [];
  for (const m of members) {
    if (m.agent_id === lead) continue;
    const from = manager(m) ?? lead;
    if (from && from !== m.agent_id) edges.push({ from, to: m.agent_id });
  }
  const extra = { folder: t.folder, repo: t.repo, baseBranch: t.base_branch || "main", reportsTo: t.reports_to && !ids.has(t.reports_to) ? t.reports_to : null };
  const nodes = (es: ChannelTeam["edges"]): ChannelTeamNode[] => {
    const layout = layoutOf(members.map((m) => m.agent_id), lead, es);
    return members.map((m) => ({ agentId: m.agent_id, lead: m.agent_id === lead, x: m.x ?? layout.get(m.agent_id)!.x, y: m.y ?? layout.get(m.agent_id)!.y, role: m.role, roleNotes: m.role_notes }));
  };
  let team: ChannelTeam = { nodes: nodes(edges), edges, ...extra };
  // a chart the old team allowed but a channel doesn't (say, a loop): everyone gets work from the lead
  if (members.length && teamProblem(team)) {
    edges = members.filter((m) => m.agent_id !== lead).map((m) => ({ from: lead!, to: m.agent_id }));
    team = { nodes: nodes(edges), edges, ...extra };
  }
  return team;
}

/** Rows by how far down the hand-offs an agent is, side by side within a row. */
function layoutOf(ids: string[], lead: string | null, edges: ChannelTeam["edges"]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>(lead ? [[lead, 0]] : []);
  for (let changed = true, i = 0; changed && i < ids.length; i++) {
    changed = false;
    for (const e of edges) {
      const d = depth.get(e.from);
      if (d !== undefined && depth.get(e.to) === undefined) {
        depth.set(e.to, d + 1);
        changed = true;
      }
    }
  }
  const perRow = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const row = depth.get(id) ?? 1;
    const col = perRow.get(row) ?? 0;
    perRow.set(row, col + 1);
    out.set(id, { x: PAD + col * (W + GAP), y: PAD + row * ROW });
  }
  return out;
}

/** A channel that already had a chart keeps it; the old team's members join under its first lead, with their roles. */
function mergeCharts(cur: ChannelTeam | null, old: ChannelTeam): ChannelTeam {
  if (!cur?.nodes.length) return { ...old, folder: cur?.folder || old.folder, repo: cur?.repo ?? old.repo, reportsTo: cur?.reportsTo ?? old.reportsTo };
  const lead = cur.nodes.find((n) => n.lead)!.agentId;
  const bottom = Math.max(...cur.nodes.map((n) => n.y)) + ROW;
  const nodes = cur.nodes.map((n) => {
    const o = old.nodes.find((x) => x.agentId === n.agentId);
    return o ? { ...n, role: n.role || o.role, roleNotes: n.roleNotes || o.roleNotes } : n;
  });
  const edges = [...cur.edges];
  for (const [i, o] of old.nodes.filter((o) => !cur.nodes.some((n) => n.agentId === o.agentId)).entries()) {
    nodes.push({ ...o, lead: false, x: PAD + i * (W + GAP), y: bottom });
    edges.push({ from: lead, to: o.agentId });
  }
  const ids = new Set(nodes.map((n) => n.agentId));
  const boss = cur.reportsTo ?? old.reportsTo;
  return { ...cur, nodes, edges, folder: cur.folder || old.folder, repo: cur.repo ?? old.repo, baseBranch: cur.baseBranch ?? old.baseBranch, reportsTo: boss && !ids.has(boss) ? boss : null };
}
