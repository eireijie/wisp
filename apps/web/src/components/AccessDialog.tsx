import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bot, Eye, Pencil, Pin, RotateCcw, Users } from "lucide-react";
import { atLeast, type AccessRule, type Agent, type MemoryLevel, type Subject } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type Member } from "../store.ts";
import { MoreOptions } from "./MoreOptions.tsx";
import { AgentAvatar, Modal, UserAvatar, cx } from "./ui.tsx";

interface AccessInfo {
  path: string;
  level: MemoryLevel;
  people: { id: string; name: string; role: string; level: MemoryLevel; via: AccessRule | null }[];
  agents: { id: string; handle: string; level: MemoryLevel; via: AccessRule | null; startup: boolean }[];
  subjects: { subject: Subject; level: MemoryLevel; via: AccessRule | null }[];
  rules: AccessRule[];
}

export const LEVEL_LABEL: Record<MemoryLevel, string> = { none: "No access", read: "Can read", edit: "Can edit", manage: "Can manage" };

const key = (s: Subject) => (s.kind === "user" || s.kind === "agent" ? `${s.kind}:${s.id}` : s.kind === "team" ? `team:${s.name}` : s.kind === "role" ? `role:${s.team}/${s.role}` : s.kind);

/** "agents/agt_x/notes" → "@atlas/notes", "people/usr_x/plans" → "Alex/plans"; "" → "the whole vault". */
export function pathLabel(path: string, agents: Pick<Agent, "id" | "handle">[], members: Pick<Member, "id" | "name">[] = []): string {
  if (!path) return "the whole vault";
  const m = path.match(/^(agents|people)\/([^/]+)(.*)$/);
  if (m?.[1] === "agents") {
    const a = agents.find((x) => x.id === m[2]);
    if (a) return `@${a.handle}${m[3]}`;
  }
  if (m?.[1] === "people") {
    const p = members.find((x) => x.id === m[2]);
    if (p) return `${p.name}${m[3]}`;
  }
  return path;
}

export function subjectLabel(s: Subject, agents: Pick<Agent, "id" | "handle">[], members: Pick<Member, "id" | "name">[]): string {
  switch (s.kind) {
    case "all_agents":
      return "All agents";
    case "members":
      return "Everyone (members)";
    case "guests":
      return "Guests";
    case "team":
      return `Team “${s.name}”`;
    case "role":
      return `${s.role} on “${s.team}”`;
    case "agent":
      return `@${agents.find((a) => a.id === s.id)?.handle ?? "deleted agent"}`;
    case "user":
      return members.find((m) => m.id === s.id)?.name ?? "someone";
  }
}

/** "you, Alex, Everyday Helper": a plain list, or the group in words when every person / helper is in it. */
function audience(people: { name: string; me: boolean; ok: boolean }[], helpers: { name: string; ok: boolean }[]): string {
  const parts: string[] = [];
  if (people.length > 1 && people.every((p) => p.ok)) parts.push("everyone in the organization");
  else parts.push(...people.filter((p) => p.me && p.ok).map(() => "you"), ...people.filter((p) => !p.me && p.ok).map((p) => p.name));
  if (helpers.length > 1 && helpers.every((h) => h.ok)) parts.push("all helpers");
  else parts.push(...helpers.filter((h) => h.ok).map((h) => h.name));
  return parts.join(", ") || "nobody";
}

/**
 * The plain answer to "who can read this?" and "who can change this?", from the same effective
 * levels the hub works out for every person and helper (rules here, inherited rules and defaults
 * already applied). Reading needs "read" or more; changing needs "edit" or more.
 */
export function accessSummary(
  info: { people: { id: string; name: string; level: MemoryLevel }[]; agents: { id: string; handle: string; level: MemoryLevel }[] },
  opts: { myId?: string; agentName?: (id: string, handle: string) => string } = {},
): { read: string; change: string } {
  const who = (need: MemoryLevel) =>
    audience(
      info.people.map((p) => ({ name: p.name, me: p.id === opts.myId, ok: atLeast(p.level, need) })),
      info.agents.map((a) => ({ name: opts.agentName?.(a.id, a.handle) ?? a.handle, ok: atLeast(a.level, need) })),
    );
  return { read: who("read"), change: who("edit") };
}

/** True for the Shared folder and anything in it. */
export const isShared = (path: string) => path.toLowerCase().split("/")[0] === "shared";

/** Every folder that holds at least one note, e.g. "Projects" and "Projects/web". */
export function folderPaths(notes: { path: string }[]): string[] {
  const out = new Set<string>();
  for (const n of notes) {
    const parts = n.path.split("/").slice(0, -1);
    parts.forEach((_, i) => out.add(parts.slice(0, i + 1).join("/")));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Who can see and change a folder or note, and why. People who manage it can set a level for
 * any agent, group or person; a rule set here beats whatever the folder inherits.
 */
export function AccessDialog({ path, folder, onClose, onChanged }: { path: string; folder: boolean; onClose: () => void; onChanged?: () => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const myId = useStore((s) => s.me?.user.id);
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api<AccessInfo>("GET", `/api/access?path=${encodeURIComponent(path)}`).then(setInfo, (e) => setError(e.message)), [path]);
  useEffect(() => {
    load();
  }, [load]);

  const summary = info ? accessSummary(info, { myId, agentName: (id, handle) => agents.find((a) => a.id === id)?.name ?? `@${handle}` }) : null;
  const noun = folder ? "folder" : "note";
  const canManage = info?.level === "manage";
  const direct = (s: Subject) => info?.rules.find((r) => key(r.subject) === key(s));

  const change = async (s: Subject, body: { level: MemoryLevel; startup: boolean }) => {
    setBusy(key(s));
    setError(null);
    try {
      await api("PUT", "/api/access", { path, subject: s, ...body });
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const reset = async (s: Subject) => {
    const rule = direct(s);
    if (!rule?.id) return;
    setBusy(key(s));
    setError(null);
    try {
      await api("DELETE", `/api/access/${rule.id}`);
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Where a row's level comes from, in a few words. */
  const why = (row: Subject, level: MemoryLevel, via: AccessRule | null): string => {
    if (!via) return level === "manage" ? "Owner" : "Nothing gives access";
    const here = via.path.toLowerCase() === path.toLowerCase();
    const where = here ? "" : via.path ? ` from ${pathLabel(via.path, agents, members)}/` : " for the whole vault";
    const whom = key(via.subject) === key(row) ? "" : `${subjectLabel(via.subject, agents, members)}`;
    if (via.builtin) return [whom, `default${where}`].filter(Boolean).join(" · ");
    const by = via.createdBy?.kind === "agent" ? ` · shared by ${subjectLabel({ kind: "agent", id: via.createdBy.id }, agents, members)}` : "";
    return [whom, here ? "set here" : where.trim()].filter(Boolean).join(" · ") + by;
  };

  const title = folder ? `Share folder ${pathLabel(path, agents, members) || "vault"}` : `Share ${pathLabel(path, agents, members).split("/").pop()?.replace(/\.md$/i, "")}`;

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        {summary && (
          <div className="rounded-xl border border-line px-4 py-3 space-y-2">
            <p className="flex items-start gap-2">
              <Eye size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <span>
                <b>Who can read this {noun}:</b> {summary.read}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Pencil size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <span>
                <b>Who can change this {noun}:</b> {summary.change}
              </span>
            </p>
            {isShared(path) && <p className="text-xs text-muted">Shared is the common folder. By default everyone in the organization and all helpers can use what is in it, so don't keep private things there.</p>}
          </div>
        )}
        <MoreOptions title="How these rules work">
          <p className="text-muted">
            {folder ? (
              <>
                Rules on <b className="text-ink">{pathLabel(path, agents, members)}/</b> apply to everything inside it.
              </>
            ) : (
              <>
                Only <b className="text-ink">{pathLabel(path, agents, members)}</b>.
              </>
            )}{" "}
            A rule set here beats what's inherited, and a rule for one agent beats one for its role, its team or all agents.
          </p>
          <>
            {info && (
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {[...info.subjects.map((r) => ({ name: subjectLabel(r.subject, agents, members), hint: why(r.subject, r.level, r.via) })), ...info.agents.map((a) => ({ name: `@${a.handle}`, hint: why({ kind: "agent", id: a.id }, a.level, a.via) })), ...info.people.map((p) => ({ name: p.name, hint: p.role === "owner" ? "Owner · always manages everything" : why({ kind: "user", id: p.id }, p.level, p.via) }))].map((r, i) => (
                  <li key={i}>
                    <b className="text-ink">{r.name}:</b> {r.hint}
                  </li>
                ))}
              </ul>
            )}
          </>
        </MoreOptions>
        {info && !canManage && <p className="rounded-lg bg-hover px-3 py-2 text-muted">You can see who has access. Only people who manage this {folder ? "folder" : "note"} can change it.</p>}
        {error && <p className="text-bad">{error}</p>}
        {!info ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <>
            <Section title="Agents" icon={<Bot size={14} />}>
              {info.subjects
                .filter((r) => r.subject.kind === "all_agents" || r.subject.kind === "team" || r.subject.kind === "role")
                .map((r) => (
                  <Row
                    key={key(r.subject)}
                    avatar={<GroupIcon />}
                    name={subjectLabel(r.subject, agents, members)}
                    hint=""
                    level={r.level}
                    levels={["none", "read", "edit"]}
                    disabled={!canManage || busy === key(r.subject)}
                    onLevel={(level) => change(r.subject, { level, startup: !!direct(r.subject)?.startup })}
                    startup={direct(r.subject)?.startup ?? false}
                    onStartup={(on) => change(r.subject, { level: r.level, startup: on })}
                    canReset={!!direct(r.subject)}
                    onReset={() => reset(r.subject)}
                  />
                ))}
              {info.agents.map((a) => {
                const s: Subject = { kind: "agent", id: a.id };
                const agent = agents.find((x) => x.id === a.id);
                return (
                  <Row
                    key={a.id}
                    avatar={<AgentAvatar agent={agent} size={28} badge={false} />}
                    name={`@${a.handle}`}
                    hint=""
                    level={a.level}
                    levels={["none", "read", "edit"]}
                    disabled={!canManage || busy === key(s)}
                    onLevel={(level) => change(s, { level, startup: !!direct(s)?.startup })}
                    startup={a.startup}
                    startupInherited={a.startup && !direct(s)?.startup}
                    onStartup={(on) => change(s, { level: a.level, startup: on })}
                    canReset={!!direct(s)}
                    onReset={() => reset(s)}
                  />
                );
              })}
            </Section>

            <Section title="People" icon={<Users size={14} />}>
              {info.subjects
                .filter((r) => r.subject.kind === "members" || r.subject.kind === "guests")
                .map((r) => (
                  <Row
                    key={key(r.subject)}
                    avatar={<GroupIcon />}
                    name={subjectLabel(r.subject, agents, members)}
                    hint=""
                    level={r.level}
                    levels={r.subject.kind === "guests" ? ["none", "read"] : ["none", "read", "edit", "manage"]}
                    disabled={!canManage || busy === key(r.subject)}
                    onLevel={(level) => change(r.subject, { level, startup: false })}
                    canReset={!!direct(r.subject)}
                    onReset={() => reset(r.subject)}
                  />
                ))}
              {info.people.map((p) => {
                const s: Subject = { kind: "user", id: p.id };
                return (
                  <Row
                    key={p.id}
                    avatar={<UserAvatar name={p.name} size={28} />}
                    name={`${p.name}${p.id === myId ? " (you)" : ""}`}
                    hint=""
                    level={p.level}
                    levels={p.role === "guest" ? ["none", "read"] : ["none", "read", "edit", "manage"]}
                    disabled={!canManage || p.role === "owner" || busy === key(s)}
                    onLevel={(level) => change(s, { level, startup: false })}
                    canReset={!!direct(s)}
                    onReset={() => reset(s)}
                  />
                );
              })}
            </Section>
            <p className="text-xs text-muted flex items-start gap-1.5">
              <Pin size={12} className="mt-0.5 shrink-0" />{" "}
              <span>
                <b>Always remind helpers of {folder ? "these notes" : "this note"}:</b> use the pin next to a helper. Helpers read {folder ? "them" : "it"} at the start of every chat. Keep {folder ? "them" : "it"} short; long notes make every reply slower and cost more.
              </span>
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
        {icon} {title}
      </div>
      <div className="rounded-xl border border-line divide-y divide-line">{children}</div>
    </div>
  );
}

function GroupIcon() {
  return (
    <span className="size-7 shrink-0 rounded-full bg-hover grid place-items-center text-muted">
      <Users size={14} />
    </span>
  );
}

function Row(p: {
  avatar: ReactNode;
  name: string;
  hint: string;
  level: MemoryLevel;
  levels: MemoryLevel[];
  disabled: boolean;
  onLevel: (l: MemoryLevel) => void;
  startup?: boolean;
  startupInherited?: boolean;
  onStartup?: (on: boolean) => void;
  canReset: boolean;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {p.avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{p.name}</div>
        {p.hint && <div className="text-xs leading-snug text-muted">{p.hint}</div>}
      </div>
      {p.onStartup && (
        <button
          onClick={() => p.onStartup!(!p.startup)}
          disabled={p.disabled || p.level === "none" || p.startupInherited}
          className={cx("p-1.5 rounded-md disabled:opacity-40", p.startup ? "text-accent-text bg-accent-soft" : "text-faint hover:text-ink hover:bg-hover")}
          title={p.startupInherited ? "Always reminded of this note, because of a rule for its team, role or all agents" : p.startup ? "Always reminded of this note (click to stop)" : "Always remind this helper of this note"}
          aria-label="Always remind this helper of this note"
          aria-pressed={p.startup}
        >
          <Pin size={14} />
        </button>
      )}
      {p.canReset && !p.disabled && (
        <button onClick={p.onReset} className="p-1.5 rounded-md text-faint hover:text-ink hover:bg-hover" title="Remove this rule (go back to what's inherited)" aria-label="Remove rule">
          <RotateCcw size={14} />
        </button>
      )}
      <select
        value={p.levels.includes(p.level) ? p.level : p.levels[p.levels.length - 1]}
        disabled={p.disabled}
        onChange={(e) => p.onLevel(e.target.value as MemoryLevel)}
        className={cx("h-8 rounded-lg border border-line bg-panel px-2 text-sm disabled:opacity-60", p.level === "none" && "text-muted")}
        aria-label={`Access for ${p.name}`}
      >
        {p.levels.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </select>
    </div>
  );
}
