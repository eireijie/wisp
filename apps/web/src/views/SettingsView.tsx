import { useEffect, useState } from "react";
import { ChevronLeft, Pin, Plus, Trash2 } from "lucide-react";
import type { AccessRule, MemoryLevel, Subject } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Button, Field, Input, Modal, Pill, UserAvatar } from "../components/ui.tsx";
import { LEVEL_LABEL, folderPaths, pathLabel, subjectLabel } from "../components/AccessDialog.tsx";

export function SettingsView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const agents = useStore((s) => s.agents);
  const [rules, setRules] = useState<AccessRule[]>([]);
  const [adding, setAdding] = useState<"member" | "rule" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = me.role === "owner";
  const refresh = () => api<AccessRule[]>("GET", "/api/access/rules").then(setRules);
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-14 shrink-0 px-3 md:px-5 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl p-4 md:p-8 space-y-10">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Memory access</h2>
                <p className="text-sm text-muted">
                  By default every agent reads and writes Shared, its own folder, its teams' folders and what it learns about people, and people can edit everything except each other's personal folders. These rules change that for one folder or note and everything inside it. You can also use the share button on any folder or note in{" "}
                  <a className="text-accent hover:underline" href="#/vault">
                    Memory
                  </a>
                  .
                </p>
              </div>
              {isOwner && (
                <Button onClick={() => setAdding("rule")} className="shrink-0">
                  <Plus size={15} /> Add rule
                </Button>
              )}
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            {rules.length === 0 ? (
              <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">No custom rules yet. Agents only see Shared, their own folders and their teams' folders.</p>
            ) : (
              <div className="rounded-xl border border-line divide-y divide-line">
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
                      <button
                        onClick={() =>
                          api("DELETE", `/api/access/${r.id}`).then(refresh, (e) => setError((e as Error).message))
                        }
                        className="p-1.5 rounded-md hover:bg-hover text-muted hover:text-bad"
                        aria-label="Remove rule"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">People</h2>
              {isOwner && (
                <Button onClick={() => setAdding("member")}>
                  <Plus size={15} /> Add person
                </Button>
              )}
            </div>
            <div className="rounded-xl border border-line divide-y divide-line">
              {members.map((m) => (
                <div key={m.id} className="px-4 py-3 flex items-center gap-3">
                  <UserAvatar name={m.name} size={30} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{m.name}</div>
                    <div className="text-xs text-muted truncate">{m.email}</div>
                  </div>
                  <span className="text-xs text-muted capitalize">{m.role}</span>
                </div>
              ))}
            </div>
          </section>

          <ComputerSettings isOwner={isOwner} />

          <section className="space-y-2 text-sm text-muted">
            <h2 className="font-semibold text-ink">About</h2>
            <p>Warren is free and open source (Apache-2.0). Your data lives on this hub: the database, the memory vault (a git repo you can open in Obsidian), and uploaded files.</p>
          </section>
        </div>
      </div>
      {adding === "member" && <AddMember onClose={() => setAdding(null)} />}
      {adding === "rule" && (
        <AddRule
          onClose={() => {
            setAdding(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AddMember({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "", role: "member" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Add a person" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("POST", "/api/members", f);
            await useStore.getState().load();
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
        <Field label="Temporary password" hint="At least 8 characters. Share it with them privately.">
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={8} autoComplete="new-password" required />
        </Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            <option value="member">Member: full access</option>
            <option value="guest">Guest: read shared memory, chat</option>
            <option value="owner">Owner: can manage people and sharing</option>
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

function AddRule({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [who, setWho] = useState("all_agents");
  const [level, setLevel] = useState<MemoryLevel>("read");
  const [startup, setStartup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ path: string }[]>("GET", "/api/vault/notes").then((n) => setFolders(folderPaths(n)));
  }, []);
  const teams = useStore((s) => s.teams);
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

/** Where agents' computers can come from: devices need nothing here; Orgo needs an API key. */
function ComputerSettings({ isOwner }: { isOwner: boolean }) {
  const [orgo, setOrgo] = useState<{ configured: boolean; hint: string | null } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ orgo: { configured: boolean; hint: string | null } }>("GET", "/api/settings/computers").then((s) => setOrgo(s.orgo), () => {});
  }, []);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      setOrgo((await api<{ orgo: { configured: boolean; hint: string | null } }>("PUT", "/api/settings/computers", { orgoApiKey: value })).orgo);
      setKey("");
      useStore.getState().refreshComputers();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold">Computers</h2>
        <p className="text-sm text-muted">
          Agents can use a device's own screen or a VM on one of your devices with no setup here. For cloud computers that keep running when your devices are off, connect{" "}
          <a className="text-accent hover:underline" href="https://www.orgo.ai/start" target="_blank" rel="noreferrer">
            Orgo
          </a>
          . The key stays on this hub; browsers never see it.
        </p>
      </div>
      <div className="rounded-xl border border-line p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium flex-1">Orgo API key</span>
          {orgo?.configured ? <Pill tone="ok">Connected {orgo.hint}</Pill> : <Pill>Not connected</Pill>}
        </div>
        {isOwner ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) save(key.trim());
            }}
          >
            <Input className="flex-1 min-w-48 font-mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={orgo?.configured ? "Replace the key" : "sk_..."} />
            <Button variant="primary" disabled={busy || !key.trim()}>
              {orgo?.configured ? "Replace" : "Connect"}
            </Button>
            {orgo?.configured && (
              <Button type="button" variant="danger" disabled={busy} onClick={() => confirm("Disconnect Orgo? Cloud computers stop working in Warren until you add a key again.") && save(null)}>
                Disconnect
              </Button>
            )}
          </form>
        ) : (
          <p className="text-xs text-muted">Only owners can change this.</p>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </section>
  );
}
