import { isLocalOnlyHost } from "../../loopback.ts";
import { useEffect, useState } from "react";
import { Download, KeyRound, Link2, MoreHorizontal, Pin, Plus, Trash2, UserMinus } from "lucide-react";
import type { AccessRule, Agent, MemoryLevel, Subject } from "@bubble-ai/core";
import { api, getToken } from "../../api.ts";
import { useStore, useTeams } from "../../store.ts";
import { href } from "../../router.ts";
import { originReach, shareOrigin, useAccess } from "../../access.ts";
import { deleteOrg, listOrgs, type Org } from "../../orgs.ts";
import { AgentAvatar, Button, CopyBlock, Field, IconButton, Input, Menu, Modal, Pill, UserAvatar, cx, timeAgo, touchFirst } from "../../components/ui.tsx";
import { LEVEL_LABEL, folderPaths, pathLabel, subjectLabel } from "../../components/AccessDialog.tsx";
import { Card, Row, SavedNote, Section, Select, Toggle, useSavedFlash } from "./parts.tsx";

const useIsOwner = () => useStore((s) => s.me)?.role === "owner";

// --- General ----------------------------------------------------------------------------------

/** The workspace's name (saved when you leave the field), and deleting it. */
export function GeneralPage() {
  const me = useStore((s) => s.me)!;
  const isOwner = useIsOwner();
  const [name, setName] = useState(me.workspace.name);
  const [error, setError] = useState<string | null>(null);
  const [saved, flash] = useSavedFlash();
  const save = async () => {
    if (!name.trim() || name.trim() === me.workspace.name) return;
    setError(null);
    try {
      await api("PATCH", "/api/workspace", { name: name.trim() });
      await useStore.getState().load();
      flash();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Card>
          <label className="px-4 min-h-[52px] flex items-center gap-4">
            <span className="text-body shrink-0">Name</span>
            <input className="h-9 w-full min-w-0 bg-transparent border-0 outline-none text-right text-body text-muted focus:text-ink disabled:text-muted" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void save()} disabled={!isOwner} maxLength={60} required aria-label="Workspace name" />
          </label>
        </Card>
        <div className="mt-2 px-1 flex items-center gap-3">
          <SavedNote shown={saved} />
          {error && <p className="text-sm text-bad">{error}</p>}
        </div>
      </form>
      {isOwner && <DeleteOrgSection />}
    </div>
  );
}

/** What the Hub address row says. */
export function HubAddress() {
  const access = useAccess();
  return <>{shareOrigin(access).replace(/^https?:\/\//, "")}</>;
}

function DeleteOrgSection() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    listOrgs().then(setOrgs);
  }, []);
  const current = orgs?.find((o) => o.current);
  // a hub without workspaces, or still loading
  if (!orgs || !current) return null;
  return (
    <div>
      {current.canDelete ? (
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 size={14} /> Delete {current.name}
        </Button>
      ) : (
        <p className="px-1 text-sm text-muted">{orgs.length > 1 ? "This is the first workspace on this Bubble AI, so it can't be deleted." : "This is your only workspace. Make or join another one before deleting it."}</p>
      )}
      {open && <DeleteOrg org={current} onClose={() => setOpen(false)} />}
    </div>
  );
}

function DeleteOrg({ org, onClose }: { org: Org; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Delete ${org.name}?`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await deleteOrg(org.id, typed);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-muted">
          This can't be undone. {org.agents} agent{org.agents === 1 ? "" : "s"}, every team and all of its memory are deleted, and {org.members > 1 ? `the ${org.members - 1} other ${org.members === 2 ? "person" : "people"} in it lose access` : "nobody else is affected"}. You'll move to another workspace.
        </p>
        <Field label={`Type ${org.name} to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" required />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || typed.trim() !== org.name}>
            {busy ? "Deleting…" : "Delete workspace"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// --- People -----------------------------------------------------------------------------------

interface Invite {
  id: string;
  role: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

const ROLE_HINT: Record<string, string> = {
  owner: "Everything, including people, devices and settings",
  member: "Chat, agents, tasks and memory",
  guest: "Chat and the shared folder in memory",
};

export function PeoplePage() {
  const me = useStore((s) => s.me)!;
  useAccess();
  const members = useStore((s) => s.members);
  const isOwner = useIsOwner();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [made, setMade] = useState<{ url: string; role: string; expiresAt: string } | null>(null);
  const [inviteRole, setInviteRole] = useState("member");
  const [days, setDays] = useState("7");
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    useStore.getState().load();
    if (isOwner) api<Invite[]>("GET", "/api/invites").then(setInvites, () => {});
  };
  useEffect(reload, [isOwner]);
  const owners = members.filter((m) => m.role === "owner").length;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      {isOwner && (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Select label="Role" value={inviteRole} onChange={setInviteRole}>
              <option value="member">Member</option>
              <option value="guest">Guest</option>
              <option value="owner">Owner</option>
            </Select>
            <Select label="Expires" value={days} onChange={setDays}>
              <option value="1">Expires in a day</option>
              <option value="7">Expires in a week</option>
              <option value="30">Expires in 30 days</option>
            </Select>
            <Button
              variant="primary"
              onClick={() =>
                run(async () => {
                  const r = await api<Invite & { code: string }>("POST", "/api/invites", { role: inviteRole, days: Number(days) });
                  setMade({ url: `${shareOrigin()}/#/join/${r.code}`, role: r.role, expiresAt: r.expiresAt });
                })
              }
            >
              <Link2 size={15} /> Create invite link
            </Button>
            <Button variant="ghost" onClick={() => setAdding(true)}>
              Add someone
            </Button>
          </div>
          {made && (
            <div className="mt-3 space-y-1.5">
              <CopyBlock text={made.url} />
              {originReach(made.url) !== "anywhere" && (
                <p className="text-xs text-warn">
                  {originReach(made.url) === "this-computer" ? "Only works on this computer." : "Only works on this Wi-Fi."}{" "}
                  <a href={href({ view: "settings", page: "access" })} className="underline">
                    Away from home
                  </a>
                </p>
              )}
              <p className="text-xs text-muted">Shown only now.</p>
            </div>
          )}
          {invites.length > 0 && (
            <Card className="mt-3">
              {invites.map((i) => (
                <Row key={i.id} label={`Invite link for a ${i.role}`} hint={`Made ${timeAgo(i.createdAt)} · expires ${new Date(i.expiresAt).toLocaleDateString()}`}>
                  <Button variant="ghost" onClick={() => run(() => api("DELETE", `/api/invites/${i.id}`))}>
                    Revoke
                  </Button>
                </Row>
              ))}
            </Card>
          )}
        </div>
      )}
      <div>
        {error && <p className="mb-2 text-sm text-bad">{error}</p>}
        <Card>
          {members.map((m) => {
            const self = m.id === me.user.id;
            const lastOwner = m.role === "owner" && owners === 1;
            return (
              <div key={m.id} className="px-4 py-3 flex items-center gap-3">
                <UserAvatar name={m.name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {m.name} {self && <span className="text-muted font-normal">(you)</span>}
                  </div>
                  <div className="text-xs text-muted truncate">{m.email}</div>
                </div>
                {isOwner && !(self && lastOwner) ? (
                  <Select label={`${m.name}'s role`} value={m.role} onChange={(role) => run(() => api("PATCH", `/api/members/${m.id}`, { role }))}>
                    <option value="owner">Owner</option>
                    <option value="member">Member</option>
                    <option value="guest">Guest</option>
                  </Select>
                ) : (
                  <span className="text-xs text-muted capitalize" title={ROLE_HINT[m.role]}>
                    {m.role}
                  </span>
                )}
                {isOwner && !self && (
                  <Menu
                    align="right"
                    trigger={(_o, t) => (
                      <button onClick={t} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label={`More for ${m.name}`} title={`More for ${m.name}`}>
                        <MoreHorizontal size={16} />
                      </button>
                    )}
                    items={[
                      { label: "Set a temporary password", icon: <KeyRound size={14} />, onSelect: () => setResetting({ id: m.id, name: m.name }) },
                      "divider",
                      {
                        label: `Remove ${m.name}`,
                        icon: <UserMinus size={14} />,
                        danger: true,
                        onSelect: () => confirm(`Remove ${m.name} from ${me.workspace.name}? They're signed out, and connections they made for agents stop working.`) && run(() => api("DELETE", `/api/members/${m.id}`)),
                      },
                    ]}
                  />
                )}
              </div>
            );
          })}
        </Card>
      </div>
      {adding && <AddMember onClose={() => (setAdding(false), reload())} />}
      {resetting && <ResetPassword person={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function AddMember({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "", role: "member" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Add someone" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("POST", "/api/members", f);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </Field>
        <Field label="Temporary password" hint="At least 8 characters.">
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={8} autoComplete="new-password" required />
        </Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            <option value="member">Member: {ROLE_HINT.member.toLowerCase()}</option>
            <option value="guest">Guest: {ROLE_HINT.guest.toLowerCase()}</option>
            <option value="owner">Owner: {ROLE_HINT.owner.toLowerCase()}</option>
          </select>
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">Add</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ person, onClose }: { person: { id: string; name: string }; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`New password for ${person.name}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("POST", `/api/members/${person.id}/password`, { password });
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <p className="text-sm text-muted">They're signed out everywhere.</p>
        <Field label="Temporary password" hint="At least 8 characters.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" required />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">Set password</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- Agents -----------------------------------------------------------------------------------

export interface AgentPolicy {
  askBefore: string[];
  maxHops: number;
  maxRunsPerMinute: number;
  defaultAccess: "read-only" | "edit" | "full";
  leadsCreateAgents: boolean;
  subAgents: boolean;
  maxAgentMade: number;
  /** agents save how they did something as a skill (Settings → Skills); older hubs don't send it, and it's on by default */
  learnSkills?: boolean;
}

/** What agents ask first about: the key the hub knows, and the two or three words a row shows. */
export const ASK: [string, string][] = [
  ["send", "Send messages"],
  ["spend", "Spend money"],
  ["delete", "Delete"],
  ["post", "Post publicly"],
  ["signup", "Sign up"],
  ["share", "Share files"],
];

/** The workspace's rules for agents, and saving one change to them. A failed save leaves what was saved showing. */
export function useAgentPolicy() {
  const isOwner = useIsOwner();
  const [p, setP] = useState<AgentPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AgentPolicy>("GET", "/api/settings/agents").then(setP, (e) => setError((e as Error).message));
  }, []);
  const save = async (patch: Partial<AgentPolicy>) => {
    if (!p) return;
    setError(null);
    try {
      setP(await api<AgentPolicy>("PUT", "/api/settings/agents", patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { p, error, save, isOwner };
}

/** What the Ask me before row says: how many of the six are on. */
export function askValue(p: AgentPolicy | null): string {
  if (!p) return "";
  const on = ASK.filter(([k]) => p.askBefore.includes(k)).length;
  return on === 0 ? "Off" : `${on} on`;
}

/** Ask me before: six switches. */
export function AskBeforePage() {
  const { p, error, save, isOwner } = useAgentPolicy();
  if (!p) return <p className="px-1 text-sm text-muted">{error ?? "Loading…"}</p>;
  return (
    <div className="space-y-4">
      <Card>
        {ASK.map(([k, label]) => (
          <Row key={k} label={label}>
            <Toggle on={p.askBefore.includes(k)} disabled={!isOwner} label={label} onChange={(on) => save({ askBefore: on ? [...p.askBefore, k] : p.askBefore.filter((x) => x !== k) })} />
          </Row>
        ))}
      </Card>
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
    </div>
  );
}

/** Who takes tasks nobody assigned: pick one, or leave it to Bubble AI (a team's lead, else the first agent). */
export function LeadSelect() {
  const isOwner = useIsOwner();
  const agents = useStore((s) => s.agents);
  const lead = useStore((s) => s.lead);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    useStore.getState().refreshLead();
  }, []);
  const current = agents.find((a) => a.id === lead?.lead);
  const save = async (leadId: string | null) => {
    setError(null);
    try {
      useStore.setState({ lead: await api("PUT", "/api/settings/lead", { leadId }) });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      {error && <span className="text-[13px] text-bad">{error}</span>}
      <Select label="Lead agent" value={lead?.leadId ?? ""} disabled={!isOwner || !agents.length} onChange={(v) => save(v || null)} className="max-w-60">
        <option value="">{current ? `Automatic (${current.name})` : "Automatic"}</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            @{a.handle} ({a.name})
          </option>
        ))}
      </Select>
    </>
  );
}

// --- Memory access ----------------------------------------------------------------------------

/** What the Memory access row says: how many rules. */
export function RulesValue() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    api<AccessRule[]>("GET", "/api/access/rules").then((r) => setN(r.length), () => {});
  }, []);
  return <>{n === null ? "" : n === 0 ? "No rules" : `${n} rule${n === 1 ? "" : "s"}`}</>;
}

/** Who can see and edit which notes: the rules, and adding one. */
export function MemoryRules() {
  const isOwner = useIsOwner();
  const members = useStore((s) => s.members);
  const agents = useStore((s) => s.agents);
  const [rules, setRules] = useState<AccessRule[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => api<AccessRule[]>("GET", "/api/access/rules").then(setRules, () => {});
  useEffect(() => {
    refresh();
  }, []);
  return (
    <div className="space-y-4">
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
      {rules.length > 0 && (
        <Card>
          {rules.map((r) => (
            <div key={r.id} className="px-4 py-3 flex items-center gap-3 text-sm">
              <span className="flex-1 min-w-0">
                <b>{subjectLabel(r.subject, agents, members)}</b>: {LEVEL_LABEL[r.level].toLowerCase()} <b className="break-all">{pathLabel(r.path, agents, members)}</b>
                {r.createdBy?.kind === "agent" && <span className="text-muted"> · shared by {subjectLabel({ kind: "agent", id: r.createdBy.id }, agents, members)}</span>}
              </span>
              {r.startup && (
                <Pill tone="accent">
                  <Pin size={11} /> Loads at startup
                </Pill>
              )}
              {isOwner && (
                <IconButton icon={<Trash2 size={15} />} label="Remove rule" tone="danger" onClick={() => api("DELETE", `/api/access/${r.id}`).then(refresh, (e) => setError((e as Error).message))} />
              )}
            </div>
          ))}
        </Card>
      )}
      {rules.length === 0 && <p className="px-1 text-sm text-muted">No rules</p>}
      {isOwner && (
        <Button onClick={() => setAdding(true)}>
          <Plus size={15} /> Add rule
        </Button>
      )}
      {adding && <AddRule onClose={() => (setAdding(false), refresh())} />}
    </div>
  );
}

function AddRule({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const teams = useTeams();
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [who, setWho] = useState("all_agents");
  const [level, setLevel] = useState<MemoryLevel>("read");
  const [startup, setStartup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ path: string }[]>("GET", "/api/vault/notes").then((n) => setFolders(folderPaths(n)));
  }, []);
  const subject: Subject =
    who === "all_agents" || who === "members" || who === "guests"
      ? { kind: who }
      : who.startsWith("agent:")
        ? { kind: "agent", id: who.slice(6) }
        : who.startsWith("team:")
          ? { kind: "team", name: who.slice(5) }
          : who.startsWith("role:")
            ? { kind: "role", team: who.slice(5).split("/")[0], role: who.slice(5).split("/").slice(1).join("/") }
            : { kind: "user", id: who.slice(5) };
  const forAgents = subject.kind === "agent" || subject.kind === "team" || subject.kind === "role" || subject.kind === "all_agents";
  const guest = subject.kind === "guests" || (subject.kind === "user" && members.find((m) => m.id === subject.id)?.role === "guest");
  const levels: MemoryLevel[] = forAgents ? ["none", "read", "edit"] : guest ? ["none", "read"] : ["none", "read", "edit", "manage"];
  return (
    <Modal title="Add a memory rule" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("PUT", "/api/access", { path: path.trim(), subject, level: levels.includes(level) ? level : "read", startup: forAgents && startup });
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Folder or note" hint="Empty is everything.">
          <Input value={path} onChange={(e) => setPath(e.target.value)} list="rule-folders" placeholder="Projects" />
          <datalist id="rule-folders">
            {folders.map((f) => (
              <option key={f} value={f}>
                {pathLabel(f, agents, members)}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Who">
          <select value={who} onChange={(e) => setWho(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            <optgroup label="Agents">
              <option value="all_agents">All agents</option>
              {teams.map((t) => (
                <option key={t.id} value={`team:${t.name}`}>
                  Team “{t.name}”
                </option>
              ))}
              {teams.flatMap((t) =>
                [...new Set(t.members.map((m) => m.role).filter(Boolean))].map((role) => (
                  <option key={`${t.id}/${role}`} value={`role:${t.name}/${role}`}>
                    {role} on “{t.name}”
                  </option>
                )),
              )}
              {agents.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  @{a.handle}
                </option>
              ))}
            </optgroup>
            <optgroup label="People">
              <option value="members">Everyone (members)</option>
              <option value="guests">Guests</option>
              {members.map((m) => (
                <option key={m.id} value={`user:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <Field label="Access">
          <select value={levels.includes(level) ? level : "read"} onChange={(e) => setLevel(e.target.value as MemoryLevel)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            {levels.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
        </Field>
        {forAgents && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={startup} onChange={(e) => setStartup(e.target.checked)} />
            <span>Load at startup</span>
          </label>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">Add rule</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- Computers --------------------------------------------------------------------------------

interface ComputerSettings {
  orgo: { configured: boolean; hint: string | null };
  defaults: { vmSize: "small" | "medium" | "large"; controlIdleMinutes: number };
}

/** New computers' size, when control goes back to agents, and the Orgo key: loaded once, each change saved as it's made. */
export function useComputerSettings() {
  const isOwner = useIsOwner();
  const [s, setS] = useState<ComputerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<ComputerSettings>("GET", "/api/settings/computers").then(setS, () => {});
  }, []);
  const put = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      setS(await api<ComputerSettings>("PUT", "/api/settings/computers", body));
      useStore.getState().refreshComputers();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { s, busy, error, put, isOwner };
}

/** Orgo's cloud computers: the key that connects them. */
export function OrgoPage() {
  const { s, busy, error, put, isOwner } = useComputerSettings();
  const [key, setKey] = useState("");
  return (
    <div className="space-y-4">
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
      <Card>
        <Row label="API key">
          <span className="text-muted">{s?.orgo.configured ? `Connected ${s.orgo.hint ?? ""}` : "Not connected"}</span>
        </Row>
        {isOwner && (
          <form
            className="px-4 py-3 flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (key.trim() && (await put({ orgoApiKey: key.trim() }))) setKey("");
            }}
          >
            <Input wrapClassName="flex-1 min-w-48" className="font-mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s?.orgo.configured ? "Replace the key" : "sk_..."} aria-label="Orgo API key" />
            <Button variant="primary" disabled={busy || !key.trim()}>
              {s?.orgo.configured ? "Replace" : "Connect"}
            </Button>
            {s?.orgo.configured && (
              <Button type="button" variant="danger" disabled={busy} onClick={() => confirm("Disconnect Orgo? Cloud computers stop working in Bubble AI until you add a key again.") && put({ orgoApiKey: null })}>
                Disconnect
              </Button>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}

// --- Connections ------------------------------------------------------------------------------

interface Connection {
  id: string;
  agentId: string;
  kind: "connection" | "harness";
  device: string | null;
  createdBy: string | null;
  createdAt: string;
  lastUsed: string | null;
}

export function ConnectionsPage() {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const isOwner = useIsOwner();
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Connection[]>("GET", "/api/connections").then(setList, (e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);
  const agent = (id: string) => agents.find((a) => a.id === id);
  const groups: [string, Connection[]][] = [
    ["Connection tokens", (list ?? []).filter((c) => c.kind === "connection")],
    ["Harnesses on devices", (list ?? []).filter((c) => c.kind === "harness")],
  ];
  return (
    <>
      {error && <p className="mb-4 px-1 text-sm text-bad">{error}</p>}
      {groups.map(([title, items]) =>
        items.length === 0 ? null : (
          <Section key={title} title={title}>
            <Card>
              {items.map((c) => {
                const a = agent(c.agentId);
                return (
                  <div key={c.id} className="px-4 py-3 flex items-center gap-3">
                    {a ? <AgentAvatar agent={a as Agent} size={28} badge={false} /> : <span className="size-7 rounded-full bg-chip" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {a ? `@${a.handle}` : "A removed agent"}
                        {c.device && <span className="text-muted font-normal"> on {c.device}</span>}
                      </div>
                      <div className="text-xs text-muted truncate">
                        {c.createdBy ? `By ${members.find((m) => m.id === c.createdBy)?.name ?? "someone"} · ` : ""}made {timeAgo(c.createdAt)} · {c.lastUsed ? `last used ${timeAgo(c.lastUsed)}` : "never used"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm(`Disconnect this token for ${a ? `@${a.handle}` : "the agent"}? Whatever uses it stops working.`)) return;
                        await api("DELETE", `/api/connections/${c.id}`).catch((e) => setError((e as Error).message));
                        load();
                      }}
                    >
                      Disconnect
                    </Button>
                  </div>
                );
              })}
            </Card>
          </Section>
        ),
      )}
    </>
  );
}

// --- Data -------------------------------------------------------------------------------------

type MemoryStorage = { path: string | null };

/** True when `child` is the same as, or inside, `parent` (both absolute paths). */
function isInside(child: string, parent: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const c = norm(child);
  const d = norm(parent);
  return c === d || c.startsWith(d + "/") || c.startsWith(d + "\\");
}

/** What the Back up row says: how much there is. */
export function BackupValue() {
  const isOwner = useIsOwner();
  const [info, setInfo] = useState<{ notes: number; files: number } | null>(null);
  useEffect(() => {
    if (isOwner) api<{ notes: number; files: number }>("GET", "/api/settings/data").then(setInfo, () => {});
  }, [isOwner]);
  return <>{info ? `${info.notes} notes · ${info.files} files` : ""}</>;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Back up: where everything is kept, and copies to download. */
export function DataPage() {
  const isOwner = useIsOwner();
  const [info, setInfo] = useState<{ dataDir: string; notes: number; messages: number; files: number; agents: number } | null>(null);
  const [memoryPath, setMemoryPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    api<typeof info>("GET", "/api/settings/data").then(setInfo, () => {});
    api<MemoryStorage>("GET", "/api/memory/storage").then((m) => setMemoryPath(m.path), () => {});
  }, [isOwner]);
  const download = async (path: string, name: string) => {
    setBusy(path);
    setError(null);
    try {
      const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const day = new Date().toISOString().slice(0, 10);
  const host = location.hostname;
  const isLocal = isLocalOnlyHost(host);
  const where = isLocal ? "this computer" : `the computer at ${host}`;
  const memoryElsewhere = !!(info && memoryPath && !isInside(memoryPath, info.dataDir));
  // a phone can't copy the folder: it's on the computer Bubble AI runs on, so it only gets the downloads
  const phone = touchFirst();
  return (
    <div className="space-y-4">
      {isOwner && info && phone && (
        <>
          <Card>
            <Row label="Inside">
              <span className="text-muted">
                {[count(info.notes, "note"), count(info.messages, "message"), count(info.files, "file"), count(info.agents, "agent")].join(" · ")}
              </span>
            </Row>
          </Card>
          <p className="px-1 text-[13px] text-muted">Your data lives on the computer Bubble AI runs on. Copy its folder there for a full backup, or download copies here.</p>
        </>
      )}
      {isOwner && info && !phone && (
        <>
          <Card>
            <Row label="Folder">
              <span className="text-muted">On {where}</span>
            </Row>
            <div className="px-4 py-3">
              <CopyBlock text={info.dataDir} />
            </div>
            <Row label="Inside">
              <span className="text-muted">
                {[count(info.notes, "note"), count(info.messages, "message"), count(info.files, "file"), count(info.agents, "agent")].join(" · ")}
              </span>
            </Row>
          </Card>
          {memoryElsewhere && (
            <div>
              <p className="mb-1.5 px-1 text-sm">Memory is in a different folder. Copy it too.</p>
              <CopyBlock text={memoryPath!} />
            </div>
          )}
          {/* the two sentences that keep a copy whole */}
          <p className="px-1 text-[13px] text-muted">Quit Bubble AI before you copy the folder, so the copy is complete. To restore, quit Bubble AI and put the folder back in the same place.</p>
        </>
      )}
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
      <Card>
        {isOwner && (
          <Row label="Notes">
            <Button disabled={!!busy} onClick={() => download("/api/export/vault.zip", `wisp-memory-${day}.zip`)}>
              <Download size={14} /> {busy === "/api/export/vault.zip" ? "Preparing…" : "Download"}
            </Button>
          </Row>
        )}
        <Row label="Chats">
          <Button disabled={!!busy} onClick={() => download("/api/export/conversations.json", `wisp-conversations-${day}.json`)}>
            <Download size={14} /> {busy === "/api/export/conversations.json" ? "Preparing…" : "Download"}
          </Button>
        </Row>
      </Card>
    </div>
  );
}
