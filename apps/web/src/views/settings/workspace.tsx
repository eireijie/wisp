import { useEffect, useState } from "react";
import { Download, KeyRound, Link2, MoreHorizontal, Pin, Plus, Trash2, UserMinus } from "lucide-react";
import type { AccessRule, Agent, MemoryLevel, Subject } from "@warren/core";
import { api, getToken } from "../../api.ts";
import { useStore } from "../../store.ts";
import { href } from "../../router.ts";
import { AgentAvatar, Button, CopyBlock, Field, IconButton, Input, Menu, Modal, Pill, UserAvatar, cx, timeAgo } from "../../components/ui.tsx";
import { LEVEL_LABEL, folderPaths, pathLabel, subjectLabel } from "../../components/AccessDialog.tsx";
import { Card, OwnersOnly, PageHeader, Row, SavedNote, Section, Segmented, Select, Toggle, useSavedFlash } from "./parts.tsx";

const useIsOwner = () => useStore((s) => s.me)?.role === "owner";

// --- General ----------------------------------------------------------------------------------

export function GeneralPage() {
  const me = useStore((s) => s.me)!;
  const isOwner = useIsOwner();
  const [name, setName] = useState(me.workspace.name);
  const [error, setError] = useState<string | null>(null);
  const [saved, flash] = useSavedFlash();
  return (
    <>
      <PageHeader title="General">The organization everyone here shares: people, agents, devices and memory.</PageHeader>
      <OwnersOnly show={!isOwner} />
      <Section title="Organization name">
        <form
          className="flex flex-wrap items-center gap-2 max-w-md"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api("PATCH", "/api/workspace", { name: name.trim() });
              await useStore.getState().load();
              flash();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <Input className="flex-1 min-w-48" value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} maxLength={60} required />
          {isOwner && (
            <Button variant="primary" disabled={!name.trim() || name.trim() === me.workspace.name}>
              Save
            </Button>
          )}
          <SavedNote shown={saved} />
        </form>
        {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      </Section>
      <Section title="Hub address" description="Devices connect here (Devices → Add device), and so do agents running elsewhere through warren-mcp.">
        <CopyBlock text={location.origin} />
      </Section>
    </>
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
    <>
      <PageHeader title="People">Who's in {me.workspace.name}, and what they can do.</PageHeader>
      {isOwner && (
        <Section title="Invite people" description="Make a link and send it to them privately. It works once, for the role you pick, until it expires.">
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
                  setMade({ url: `${location.origin}/#/join/${r.code}`, role: r.role, expiresAt: r.expiresAt });
                })
              }
            >
              <Link2 size={15} /> Create invite link
            </Button>
            <Button variant="ghost" onClick={() => setAdding(true)}>
              Add someone directly
            </Button>
          </div>
          {made && (
            <div className="mt-3 space-y-1.5">
              <CopyBlock text={made.url} />
              <p className="text-xs text-muted">
                For a {made.role}, until {new Date(made.expiresAt).toLocaleDateString()}. It's shown only now; make a new one if you lose it.
              </p>
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
        </Section>
      )}
      <Section title={`Members · ${members.length}`}>
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
        <p className="mt-2 text-xs text-muted">Owners: {ROLE_HINT.owner.toLowerCase()}. Members: {ROLE_HINT.member.toLowerCase()}. Guests: {ROLE_HINT.guest.toLowerCase()}.</p>
      </Section>
      {adding && <AddMember onClose={() => (setAdding(false), reload())} />}
      {resetting && <ResetPassword person={resetting} onClose={() => setResetting(null)} />}
    </>
  );
}

function AddMember({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "", role: "member" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Add someone directly" onClose={onClose}>
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
        <p className="text-sm text-muted">Makes their account now, with a temporary password you give them. An invite link lets them pick their own.</p>
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </Field>
        <Field label="Temporary password" hint="At least 8 characters. Share it with them privately.">
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
        <p className="text-sm text-muted">For when they're locked out. They're signed out everywhere and sign in with this; they can change it under Security.</p>
        <Field label="Temporary password" hint="At least 8 characters. Share it with them privately.">
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

interface AgentPolicy {
  askBefore: string[];
  maxHops: number;
  maxRunsPerMinute: number;
  defaultAccess: "read-only" | "edit" | "full";
  leadsCreateAgents: boolean;
  subAgents: boolean;
  maxAgentMade: number;
}

const ASK: [string, string, string][] = [
  ["send", "Sending email or messages outside Warren", "Email, texts, Slack, DMs on other sites"],
  ["spend", "Buying or paying for anything", "Orders, subscriptions, upgrades, ads"],
  ["delete", "Deleting files, data or accounts", "Anything that can't be undone"],
  ["post", "Posting publicly", "Social media, reviews, comments, forums"],
  ["signup", "Signing up for new accounts or services", "New logins, free trials, newsletters"],
  ["share", "Sharing files or private information outside Warren", "Uploads, links, forms with personal details"],
];

export function AgentsPolicyPage() {
  const isOwner = useIsOwner();
  const [p, setP] = useState<AgentPolicy | null>(null);
  const [saved, flash] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AgentPolicy>("GET", "/api/settings/agents").then(setP, (e) => setError((e as Error).message));
  }, []);
  const save = async (patch: Partial<AgentPolicy>) => {
    if (!p) return;
    setP({ ...p, ...patch });
    setError(null);
    try {
      setP(await api<AgentPolicy>("PUT", "/api/settings/agents", patch));
      flash();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!p) return <PageHeader title="Agents">{error ?? "Loading…"}</PageHeader>;
  return (
    <>
      <PageHeader title="Agents">Rules every agent here follows, whichever AI tool runs it.</PageHeader>
      <OwnersOnly show={!isOwner} />
      <div className="mb-3 h-4">
        <SavedNote shown={saved} />
        {error && <span className="text-sm text-bad">{error}</span>}
      </div>
      <Section title="Ask before" description="Checked actions need your OK (Approve / Deny in the conversation). If you ask Nova to email Sam, it just does it. If it decides on its own to email someone, it asks first.">
        <Card>
          {ASK.map(([k, label, hint]) => (
            <label key={k} className={cx("px-4 py-3 flex items-start gap-3", isOwner && "cursor-pointer")}>
              <input
                type="checkbox"
                className="mt-1"
                disabled={!isOwner}
                checked={p.askBefore.includes(k)}
                onChange={(e) => save({ askBefore: e.target.checked ? [...p.askBefore, k] : p.askBefore.filter((x) => x !== k) })}
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </Card>
      </Section>
      <Section title="New agents">
        <Card>
          <Row label="Access on their device" hint="What a new agent may do with files and commands where its harness runs directly on a device. Inside its own VM an agent always has full access; the VM is its sandbox.">
            <Segmented
              label="Access for new agents"
              value={p.defaultAccess}
              disabled={!isOwner}
              onChange={(v) => save({ defaultAccess: v })}
              options={[
                ["read-only", "Read only"],
                ["edit", "Edit"],
                ["full", "Full"],
              ]}
            />
          </Row>
        </Card>
      </Section>
      <Section title="Agents making agents" description="Let agents add helpers when the work needs more hands. Both are off until you turn them on.">
        <Card>
          <Row label="Leads can create agents" hint="A channel's lead (or a team's) can create an agent its team is missing. It joins the team chart under the lead.">
            <Toggle on={p.leadsCreateAgents} onChange={(v) => save({ leadsCreateAgents: v })} label="Leads can create agents" disabled={!isOwner} />
          </Row>
          <Row label="Those agents can make sub-agents" hint={p.leadsCreateAgents ? "An agent a lead made can make sub-agents for pieces of its own work, up to 3 levels down." : "Needs “Leads can create agents” on first."}>
            <Toggle on={p.subAgents} onChange={(v) => save({ subAgents: v })} label="Agents a lead made can make sub-agents" disabled={!isOwner || !p.leadsCreateAgents} />
          </Row>
          <Row label="Most agents made by agents" hint="Once there are this many, agents can't make more until you remove some.">
            <Select label="Most agents made by agents" value={String(p.maxAgentMade)} disabled={!isOwner || !p.leadsCreateAgents} onChange={(v) => save({ maxAgentMade: Number(v) })}>
              {[3, 5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
        </Card>
      </Section>
      <Section title="Loop protection" description="Agents can @mention each other. These stop two agents from pinging each other forever.">
        <Card>
          <Row label="Hand-offs in a row" hint="How many times agents can wake each other from one message before Warren stops it.">
            <Select label="Hand-offs in a row" value={String(p.maxHops)} disabled={!isOwner} onChange={(v) => save({ maxHops: Number(v) })}>
              {[2, 3, 4, 6, 8, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Agent runs per channel per minute" hint="A ceiling on how busy one conversation can get.">
            <Select label="Agent runs per channel per minute" value={String(p.maxRunsPerMinute)} disabled={!isOwner} onChange={(v) => save({ maxRunsPerMinute: Number(v) })}>
              {[5, 10, 20, 40, 60, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
        </Card>
      </Section>
    </>
  );
}

// --- Memory access ----------------------------------------------------------------------------

/** The rules half of Settings → Memory (the rest is in memory.tsx). */
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
    <>
      <Section
        title="Who can see and edit what"
        description={
          <>
            By default every agent reads and writes Shared, its own folder, its teams' folders and what it learns about people, and people can edit everything except each other's personal folders. Rules here change that for a folder or note and everything inside it. You can also use the share button on any folder or note in{" "}
            <a className="text-accent-text hover:underline" href={href({ view: "vault", path: null })}>
              Memory
            </a>
            .
          </>
        }
        action={
          isOwner && (
            <Button onClick={() => setAdding(true)}>
              <Plus size={15} /> Add rule
            </Button>
          )
        }
      >
        {error && <p className="mb-2 text-sm text-bad">{error}</p>}
        {rules.length === 0 ? (
          <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">No rules yet. Agents only see Shared, their own folders and their teams' folders.</p>
        ) : (
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
      </Section>
      {adding && <AddRule onClose={() => (setAdding(false), refresh())} />}
    </>
  );
}

function AddRule({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const teams = useStore((s) => s.teams);
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
        <Field label="Folder or note" hint="A folder covers everything inside it. Leave empty for the whole vault.">
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
            <span>
              Load at startup
              <span className="block text-xs text-muted">The agent gets these notes in its prompt every time it works.</span>
            </span>
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

export function ComputersPage() {
  const isOwner = useIsOwner();
  const [s, setS] = useState<ComputerSettings | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flash] = useSavedFlash();
  useEffect(() => {
    api<ComputerSettings>("GET", "/api/settings/computers").then(setS, () => {});
  }, []);
  const put = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      setS(await api<ComputerSettings>("PUT", "/api/settings/computers", body));
      setKey("");
      flash();
      useStore.getState().refreshComputers();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Computers">
        Computers agents can use: their own virtual computers, your screen, or cloud computers. Manage each one under{" "}
        <a className="text-accent-text hover:underline" href={href({ view: "computers", computerId: null })}>
          Computers
        </a>{" "}
        and{" "}
        <a className="text-accent-text hover:underline" href={href({ view: "nodes" })}>
          Devices
        </a>
        .
      </PageHeader>
      <OwnersOnly show={!isOwner} />
      <div className="mb-3 h-4">
        <SavedNote shown={saved} />
      </div>
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}
      <Section title="Defaults">
        <Card>
          <Row label="Size of new VMs" hint="Small: 1 CPU, 2 GB. Medium: 2 CPUs, 4 GB. Large: 4 CPUs, 8 GB. You can still pick per VM.">
            <Segmented
              label="Size of new VMs"
              value={s?.defaults.vmSize ?? "medium"}
              disabled={!isOwner || !s}
              onChange={(vmSize) => put({ vmSize })}
              options={[
                ["small", "Small"],
                ["medium", "Medium"],
                ["large", "Large"],
              ]}
            />
          </Row>
          <Row label="Give control back to agents after" hint="When someone takes control of a computer and then stops touching it.">
            <Select label="Give control back after" value={String(s?.defaults.controlIdleMinutes ?? 10)} disabled={!isOwner || !s} onChange={(v) => put({ controlIdleMinutes: Number(v) })}>
              {[5, 10, 15, 30, 60, 120].map((n) => (
                <option key={n} value={n}>
                  {n < 60 ? `${n} minutes` : `${n / 60} hour${n === 60 ? "" : "s"}`} idle
                </option>
              ))}
            </Select>
          </Row>
        </Card>
      </Section>
      <Section
        title="Orgo cloud computers"
        description={
          <>
            For computers that keep running when your devices are off, connect{" "}
            <a className="text-accent-text hover:underline" href="https://www.orgo.ai/start" target="_blank" rel="noreferrer">
              Orgo
            </a>
            . The key stays on this hub; browsers never see it.
          </>
        }
      >
        <Card>
          <Row label="Orgo API key">{s?.orgo.configured ? <Pill tone="ok">Connected {s.orgo.hint}</Pill> : <Pill>Not connected</Pill>}</Row>
          {isOwner && (
            <form
              className="px-4 py-3 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) put({ orgoApiKey: key.trim() });
              }}
            >
              <Input className="flex-1 min-w-48 font-mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s?.orgo.configured ? "Replace the key" : "sk_..."} />
              <Button variant="primary" disabled={busy || !key.trim()}>
                {s?.orgo.configured ? "Replace" : "Connect"}
              </Button>
              {s?.orgo.configured && (
                <Button type="button" variant="danger" disabled={busy} onClick={() => confirm("Disconnect Orgo? Cloud computers stop working in Warren until you add a key again.") && put({ orgoApiKey: null })}>
                  Disconnect
                </Button>
              )}
            </form>
          )}
        </Card>
      </Section>
    </>
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
  const groups: [string, string, Connection[]][] = [
    ["Connection tokens", "Made on an agent's Connect tab, for a harness that runs elsewhere (warren-mcp). Disconnect any you don't use.", (list ?? []).filter((c) => c.kind === "connection")],
    ["Harnesses on devices", "Each agent's harness gets a token for that agent only when its device runs it. Disconnecting one makes the device get a fresh one next run.", (list ?? []).filter((c) => c.kind === "harness")],
  ];
  return (
    <>
      <PageHeader title="Connections">Keys that let agents running somewhere else reach this hub. Most people never need these. {isOwner ? "You see everyone's." : "You see the ones you made."}</PageHeader>
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}
      {groups.map(([title, description, items]) => (
        <Section key={title} title={title} description={description}>
          {list === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">None.</p>
          ) : (
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
          )}
        </Section>
      ))}
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
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const where = isLocal ? "this computer" : `the computer at ${host}`;
  const memoryElsewhere = !!(info && memoryPath && !isInside(memoryPath, info.dataDir));
  return (
    <>
      <PageHeader title="Data">Back up your organization, or take a copy of your notes and conversations.</PageHeader>
      <Section title="Back up everything" description="One folder on the computer that runs the Warren hub holds everything for this organization. Copy that folder and you have a full backup.">
        {isOwner && info ? (
          <>
            <Card>
              <Row label="Where the folder is" hint={`It is on ${where}: the computer that runs the Warren hub.`} />
              <div className="px-4 pb-3.5">
                <CopyBlock text={info.dataDir} />
              </div>
              <Row label="What is inside" hint={`${info.notes} notes, ${info.messages} messages, ${info.files} files and ${info.agents} agents.`} />
            </Card>
            <ul className="mt-3 list-disc pl-5 text-sm text-muted space-y-1">
              <li><code className="text-xs">warren.db</code>: people, channels, messages, agents, tasks, routines and settings.</li>
              <li><code className="text-xs">vault/</code>: your memory notes.</li>
              <li><code className="text-xs">files/</code>: files people uploaded.</li>
            </ul>
            {memoryElsewhere && (
              <div className="mt-3">
                <p className="mb-1.5 text-sm">Your memory notes are kept in a different folder; back it up too:</p>
                <CopyBlock text={memoryPath!} />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">Ask an organization owner to back up the hub.</p>
        )}
      </Section>
      <Section title="What is not in it">
        <ul className="list-disc pl-5 text-sm text-muted space-y-1">
          <li>Sign-ins for agent tools (like Claude Code or Codex). Those stay on each device.</li>
          <li>Agents' own computers (VMs). They live on the device that runs them.</li>
          <li>Settings saved only in this browser, like appearance and notifications.</li>
          {isOwner && <li>The memory folder, if it was moved to a different place (shown above).</li>}
        </ul>
      </Section>
      <Section title="How to back up">
        <ol className="list-decimal pl-5 text-sm space-y-1">
          <li>Quit Warren on {where} (or stop the hub there), so the copy is complete.</li>
          <li>Copy the whole folder to a USB drive or a cloud folder.</li>
          <li>Start Warren again.</li>
        </ol>
      </Section>
      <Section title="How to restore">
        <ol className="list-decimal pl-5 text-sm space-y-1">
          <li>Install Warren on the computer, or keep the install you already have.</li>
          <li>Quit Warren.</li>
          <li>Put your copied folder back in the same place, replacing the folder there.</li>
          <li>If your memory notes were in a separate folder, put that folder back too.</li>
          <li>Start Warren again. Your devices reconnect by themselves when they are online.</li>
        </ol>
      </Section>
      <Section title="Download copies" description="These downloads are copies to keep or read. They can't restore an organization on their own. The folder backup does.">
        {error && <p className="mb-2 text-sm text-bad">{error}</p>}
        <Card>
          {isOwner && (
            <Row label="Download my notes (Markdown ZIP)" hint="Every memory note as a text file, in its folders. Opens in any text editor.">
              <Button disabled={!!busy} onClick={() => download("/api/export/vault.zip", `warren-memory-${day}.zip`)}>
                <Download size={14} /> {busy === "/api/export/vault.zip" ? "Preparing…" : "Download"}
              </Button>
            </Row>
          )}
          <Row label="Download conversations (JSON, for developers)" hint="Every channel and DM you can see. JSON is a data format for programs, not for reading.">
            <Button disabled={!!busy} onClick={() => download("/api/export/conversations.json", `warren-conversations-${day}.json`)}>
              <Download size={14} /> {busy === "/api/export/conversations.json" ? "Preparing…" : "Download"}
            </Button>
          </Row>
        </Card>
      </Section>
    </>
  );
}
