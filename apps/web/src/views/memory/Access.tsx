import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, Plus, Users } from "lucide-react";
import { atLeast, type AccessRule, type MemoryLevel, type Subject } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { AgentAvatar, UserAvatar, cx } from "../../components/ui.tsx";
import { folderPaths, pathLabel, subjectLabel } from "../../components/AccessDialog.tsx";
import { Cards, MemoryDialog, Overline, Radio, field, pill, pillPrimary } from "./parts.tsx";

const subjKey = (s: Subject) => (s.kind === "user" || s.kind === "agent" ? `${s.kind}:${s.id}` : s.kind === "team" ? `team:${s.name}` : s.kind === "role" ? `role:${s.team}/${s.role}` : s.kind);
const SHORT: Record<MemoryLevel, string> = { none: "No access", read: "Read", edit: "Edit", manage: "Full" };
const RANK: MemoryLevel[] = ["none", "read", "edit", "manage"];

/** Who can see and edit what: a list of helpers and people, each with the rules that apply to them. */
export function AccessRulesDialog({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const isOwner = useStore((s) => s.me?.role === "owner");
  const [rules, setRules] = useState<AccessRule[] | null>(null);
  const [editing, setEditing] = useState<{ subject: Subject | null; rule: AccessRule | null; adding?: boolean } | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<AccessRule[]>("GET", "/api/access/rules").then(setRules, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
    api<{ path: string }[]>("GET", "/api/vault/notes").then((n) => setFolders(folderPaths(n)), () => {});
  }, [load]);

  const rulesFor = (s: Subject) => (rules ?? []).filter((r) => subjKey(r.subject) === subjKey(s));
  const summary = (s: Subject) => {
    const rs = rulesFor(s);
    if (!rs.length) return { hint: s.kind === "user" ? "Default access" : "Shared and its own folders", level: "Default" };
    const top = rs.reduce<MemoryLevel>((m, r) => (RANK.indexOf(r.level) > RANK.indexOf(m) ? r.level : m), "none");
    const hint = rs.map((r) => pathLabel(r.path, agents, members) || "Everything").join(" · ");
    return { hint, level: SHORT[top] };
  };
  const groupSubjects: Subject[] = [{ kind: "all_agents" }, { kind: "members" }, { kind: "guests" }, ...(rules ?? []).map((r) => r.subject).filter((s) => s.kind === "team" || s.kind === "role")];
  const groupsShown = groupSubjects.filter((s, i, a) => a.findIndex((x) => subjKey(x) === subjKey(s)) === i && (rulesFor(s).length > 0 || s.kind === "all_agents"));
  const open = (s: Subject) => {
    const rs = rulesFor(s);
    setEditing({ subject: s, rule: rs.length === 1 ? rs[0]! : null });
  };

  const row = (s: Subject, avatar: React.ReactNode, name: string) => {
    const { hint, level } = summary(s);
    return (
      <button key={subjKey(s)} onClick={() => open(s)} className="w-full text-left min-h-14 px-4 py-2.5 flex items-center gap-3 hover:bg-hover/60">
        {avatar}
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-medium truncate">{name}</span>
          <span className="block text-xs text-muted truncate">{hint}</span>
        </span>
        <span className="text-[15px] text-muted">{level}</span>
        <ChevronRight size={16} className="text-faint" />
      </button>
    );
  };

  if (editing)
    return (
      <RuleEditor
        // a different rule (or the new-rule form) is a fresh form, not an edit of the last one
        key={editing.rule?.id ?? (editing.adding ? "new" : "list")}
        subject={editing.subject}
        rule={editing.rule}
        adding={!!editing.adding}
        rules={editing.subject ? rulesFor(editing.subject) : []}
        folders={folders}
        canChange={isOwner}
        onPickRule={(r) => setEditing({ ...editing, rule: r, adding: !r })}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    );

  return (
    <MemoryDialog
      title="Who can see and edit what"
      onClose={onClose}
      footer={
        isOwner && (
          <button className={cx(pillPrimary, "h-12 px-6")} onClick={() => setEditing({ subject: null, rule: null })}>
            <Plus size={18} /> Add a memory rule
          </button>
        )
      }
    >
      <div className="rounded-3xl bg-card px-4 py-3.5">
        <p className="font-medium text-[15px]">How these rules work</p>
        <p className="mt-1 text-[13px] text-muted leading-relaxed">
          Everyone shares the Shared folder. Each helper has a private folder. A rule on a folder or note changes who can read or write it. A rule for one helper beats one for its team or all helpers.
        </p>
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Overline>Agents</Overline>
      <Cards>
        {groupsShown.filter((s) => s.kind === "all_agents" || s.kind === "team" || s.kind === "role").map((s) => row(s, <GroupMark />, subjectLabel(s, agents, members)))}
        {agents.map((a) => row({ kind: "agent", id: a.id }, <AgentAvatar agent={a} size={34} interactive={false} />, a.name))}
        {!agents.length && !groupsShown.length && <p className="px-4 py-3 text-sm text-muted">No helpers yet.</p>}
      </Cards>
      <Overline>People</Overline>
      <Cards>
        {groupsShown.filter((s) => s.kind === "members" || s.kind === "guests").map((s) => row(s, <GroupMark />, subjectLabel(s, agents, members)))}
        {members.map((m) => row({ kind: "user", id: m.id }, <UserAvatar name={m.name} size={34} />, m.name))}
      </Cards>
      {!isOwner && <p className="mt-4 px-1 text-xs text-muted">Only the owner can change these rules.</p>}
    </MemoryDialog>
  );
}

function GroupMark() {
  return (
    <span className="size-[34px] shrink-0 rounded-full bg-chip grid place-items-center text-muted">
      <Users size={16} />
    </span>
  );
}

/** One rule: which folder or note, how much access, and whether the helper is always reminded of it. */
function RuleEditor({
  subject,
  rule,
  adding,
  rules,
  folders,
  canChange,
  onPickRule,
  onClose,
  onSaved,
}: {
  subject: Subject | null;
  rule: AccessRule | null;
  adding: boolean;
  rules: AccessRule[];
  folders: string[];
  canChange: boolean;
  onPickRule: (r: AccessRule | null) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const [who, setWho] = useState(subject ? subjKey(subject) : "all_agents");
  const [path, setPath] = useState(rule?.path ?? "shared");
  const [level, setLevel] = useState<MemoryLevel>(rule?.level ?? "read");
  const [startup, setStartup] = useState(rule?.startup ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a subject with several rules: choose which one to change first
  const listing = !!subject && rules.length > 1 && !rule && !adding;
  const derived: Subject = useMemo(() => {
    if (who === "all_agents" || who === "members" || who === "guests") return { kind: who };
    if (who.startsWith("agent:")) return { kind: "agent", id: who.slice(6) };
    if (who.startsWith("user:")) return { kind: "user", id: who.slice(5) };
    return { kind: "all_agents" };
  }, [who]);
  const effective = subject ?? derived;
  const isAgent = effective.kind === "agent" || effective.kind === "all_agents" || effective.kind === "team" || effective.kind === "role";
  const levels: MemoryLevel[] = effective.kind === "guests" ? ["none", "read"] : isAgent ? ["none", "read", "edit"] : ["none", "read", "edit", "manage"];
  const desc: Record<MemoryLevel, string> = { none: "Cannot see it", read: "Can read, cannot change", edit: "Can read and write", manage: "Can also decide who sees it" };
  const name = subjectLabel(effective, agents, members);
  const paths = [...new Set(["", "shared", ...folders, ...(rule?.path !== undefined ? [rule.path] : [])])];
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/access", { path, subject: effective, level, startup: isAgent ? startup : false });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!rule?.id) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/access/${rule.id}`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  if (listing)
    return (
      <MemoryDialog title={`Rules for ${name}`} onClose={onClose}>
        <Cards>
          {rules.map((r) => (
            <button key={r.id} onClick={() => onPickRule(r)} className="w-full text-left min-h-12 px-4 flex items-center gap-3 hover:bg-hover/60">
              <Folder size={19} strokeWidth={1.7} className="text-muted" />
              <span className="flex-1 truncate text-[15px]">{pathLabel(r.path, agents, members) || "Everything"}</span>
              <span className="text-muted text-[15px]">{SHORT[r.level]}</span>
              <ChevronRight size={16} className="text-faint" />
            </button>
          ))}
        </Cards>
        <div className="mt-5 flex justify-center">
          <button className={pill} onClick={() => onPickRule(null)}>
            <Plus size={16} /> Add a rule for {name}
          </button>
        </div>
      </MemoryDialog>
    );
  return (
    <MemoryDialog
      title={subject ? `Rule for ${name}` : "Add a memory rule"}
      onClose={onClose}
      footer={
        canChange && (
          <button className={cx(pillPrimary, "h-12 px-7")} onClick={save} disabled={busy}>
            Save
          </button>
        )
      }
    >
      {!subject && (
        <>
          <Overline>Who</Overline>
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who" className={field}>
            <option value="all_agents">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={`agent:${a.id}`}>
                {a.name}
              </option>
            ))}
            <option value="members">Everyone (members)</option>
            <option value="guests">Guests</option>
            {members.map((m) => (
              <option key={m.id} value={`user:${m.id}`}>
                {m.name}
              </option>
            ))}
          </select>
        </>
      )}
      <Overline>Folder or note</Overline>
      <label className="flex items-center gap-3 rounded-3xl bg-card px-4 min-h-12 relative">
        <Folder size={19} strokeWidth={1.7} className="text-muted shrink-0" />
        <select value={path} onChange={(e) => setPath(e.target.value)} disabled={!canChange || !!rule} aria-label="Folder or note" className="flex-1 bg-transparent text-[15px] outline-none h-14 appearance-none">
          {paths.map((p) => (
            <option key={p} value={p}>
              {p ? pathLabel(p, agents, members) : "Everything"}
            </option>
          ))}
        </select>
      </label>
      <Overline>Access</Overline>
      <Cards>
        {levels.map((l) => (
          <button key={l} disabled={!canChange} onClick={() => setLevel(l)} aria-pressed={level === l} className="w-full text-left min-h-14 px-4 py-2 flex items-center gap-3 hover:bg-hover/60">
            <span className="flex-1">
              <span className="block text-[15px]">{l === "none" ? "No access" : l === "read" ? "Read" : l === "edit" ? "Edit" : "Manage"}</span>
              <span className="block text-xs text-muted">{desc[l]}</span>
            </span>
            <Radio on={level === l} />
          </button>
        ))}
      </Cards>
      {isAgent && atLeast(level, "read") && (
        <div className="mt-3 rounded-3xl bg-card px-4 min-h-14 py-2 flex items-center gap-3">
          <span className="flex-1">
            <span className="block text-[15px]">Always remind this helper of this note</span>
            <span className="block text-xs text-muted">Loads at startup</span>
          </span>
          <button role="switch" aria-checked={startup} disabled={!canChange} onClick={() => setStartup(!startup)} className={cx("w-[52px] h-8 rounded-full p-1 transition-colors shrink-0", startup ? "bg-info" : "bg-chip")}>
            <span className={cx("block size-6 rounded-full bg-white shadow transition-transform", startup && "translate-x-5")} />
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {rule?.id && canChange && (
        <div className="mt-6 text-center">
          <button onClick={remove} disabled={busy} className="text-[15px] font-medium text-bad">
            Remove rule
          </button>
          <p className="mt-2 text-xs text-muted">Removing it goes back to what the folder already allows.</p>
        </div>
      )}
    </MemoryDialog>
  );
}
