import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Moon, Pin, Plus, Sun, SunMoon, Trash2 } from "lucide-react";
import type { AccessRule, MemoryLevel, Subject } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { THEMES, useAppearance, type ModeChoice } from "../theme.ts";
import { Button, Field, Input, Modal, Pill, UserAvatar, cx } from "../components/ui.tsx";
import { LEVEL_LABEL, folderPaths, pathLabel, subjectLabel } from "../components/AccessDialog.tsx";

/** Light or dark, and a color theme. Both are remembered on this device. */
function AppearanceSettings() {
  const { mode, resolvedMode, theme, setMode, setTheme } = useAppearance();
  const modes: [ModeChoice, string, ReactNode][] = [
    ["system", "System", <SunMoon key="s" size={15} />],
    ["light", "Light", <Sun key="l" size={15} />],
    ["dark", "Dark", <Moon key="d" size={15} />],
  ];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold">Appearance</h2>
          <p className="text-sm text-muted">Pick a theme. It works in light and dark, and only changes how Warren looks on this device.</p>
        </div>
        <div className="inline-flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Mode">
          {modes.map(([value, label, icon]) => (
            <button key={value} role="radio" aria-checked={mode === value} onClick={() => setMode(value)} className={cx("h-8 px-3 rounded-md text-sm inline-flex items-center gap-1.5", mode === value ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink")}>
              {icon} {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => {
          const selected = theme === t.id;
          return (
            // each card carries its own theme, so its preview shows that theme's colors
            <button
              key={t.id}
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(t.id)}
              data-theme={t.id}
              data-mode={resolvedMode}
              className={cx("text-left rounded-xl border p-3 transition-colors", selected ? "border-accent ring-1 ring-accent" : "border-line hover:bg-hover")}
            >
              <div className="rounded-lg border border-line bg-bg p-2.5 space-y-2" aria-hidden>
                <div className="flex items-center gap-1.5">
                  <span className="h-6 px-2.5 rounded-full bg-accent text-accent-ink text-[11px] font-medium inline-flex items-center">New agent</span>
                  <span className="text-[11px] text-accent-text underline underline-offset-2">a link</span>
                </div>
                <div className="h-6 rounded-md bg-accent-soft px-2 flex items-center gap-1.5 text-[11px] text-ink">
                  <span className="size-1.5 rounded-full bg-accent" /># launch
                </div>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <span className="text-sm font-medium flex-1">{t.name}</span>
                {selected && <Check size={15} className="text-accent-text" />}
              </div>
              <p className="text-xs text-muted mt-0.5">{t.blurb}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

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
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl p-4 md:p-8 space-y-10">
          <AppearanceSettings />

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Memory access</h2>
                <p className="text-sm text-muted">
                  By default every agent reads and writes Shared, its own folder, its teams' folders and what it learns about people, and people can edit everything except each other's personal folders. These rules change that for one folder or note and everything inside it. You can also use the share button on any folder or note in{" "}
                  <a className="text-accent-text hover:underline" href="#/vault">
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

          <UpdateSettings isOwner={isOwner} />

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
          <a className="text-accent-text hover:underline" href="https://www.orgo.ai/start" target="_blank" rel="noreferrer">
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

interface UpdateInfo {
  version: { commit: string | null; date: string | null };
  check: { behind: number | null; changes: string[]; canUpdate: boolean; reason: string } | null;
  update: { state: "idle" | "updating" | "restarting" | "failed"; message: string; log: string[] };
}

/** The hub's version, what's new on GitHub, and a button to update. The page reloads once the hub is back. */
function UpdateSettings({ isOwner }: { isOwner: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    try {
      setInfo(await api<UpdateInfo>("POST", "/api/updates/check"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    api<UpdateInfo>("GET", "/api/updates").then(setInfo, () => {});
    check();
  }, []);

  // while the hub updates, follow along; it goes away while restarting, then comes back on the new version
  const busy = !!restarting || info?.update.state === "updating" || info?.update.state === "restarting";
  useEffect(() => {
    if (!busy) return;
    const from = restarting ?? info?.version.commit ?? null;
    const t = setInterval(async () => {
      const next = await api<UpdateInfo>("GET", "/api/updates").catch(() => null);
      if (!next) return setRestarting(from ?? "");
      if (next.update.state === "restarting") setRestarting(from ?? "");
      if (restarting !== null && next.version.commit !== restarting) return location.reload();
      setInfo(next);
    }, 2000);
    return () => clearInterval(t);
  }, [busy, restarting]);

  const update = async () => {
    setError(null);
    try {
      const r = await api<{ update: UpdateInfo["update"] }>("POST", "/api/updates/hub");
      setInfo((i) => i && { ...i, update: r.update });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const v = info?.version;
  const c = info?.check;
  const u = info?.update;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Updates</h2>
          <p className="text-sm text-muted">
            {v?.commit ? (
              <>
                This hub runs Warren <code>{v.commit}</code>
                {v.date && <> from {new Date(v.date).toLocaleDateString()}</>}. Update devices from{" "}
                <a className="text-accent-text hover:underline" href="#/nodes">
                  Devices
                </a>
                .
              </>
            ) : (
              "Which version of Warren this hub runs, and what's new."
            )}
          </p>
        </div>
        <Button onClick={check} disabled={checking || busy} className="shrink-0">
          {checking ? "Checking…" : "Check now"}
        </Button>
      </div>
      <div className="rounded-xl border border-line p-4 space-y-3 text-sm">
        {busy ? (
          <p className="flex items-center gap-2">
            <Pill tone="info">{restarting !== null || u?.state === "restarting" ? "Restarting" : "Updating"}</Pill>
            <span className="text-muted">{restarting !== null || u?.state === "restarting" ? "The hub is restarting with the update. This page reloads when it's back." : (u?.log.at(-1) ?? "Updating…")}</span>
          </p>
        ) : !c ? (
          <p className="text-muted">{checking ? "Asking GitHub what's new…" : "Not checked yet."}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {c.canUpdate ? <Pill tone="accent">Update available</Pill> : c.behind === 0 ? <Pill tone="ok">Up to date</Pill> : <Pill tone="warn">Can't update here</Pill>}
              <span className="text-muted flex-1">{c.reason}</span>
              {c.canUpdate && isOwner && (
                <Button variant="primary" onClick={update}>
                  Update hub
                </Button>
              )}
            </div>
            {c.changes.length > 0 && (
              <ul className="space-y-1 text-muted">
                {c.changes.slice(0, 8).map((line) => (
                  <li key={line} className="truncate">
                    <code className="text-faint">{line.slice(0, line.indexOf(" "))}</code> {line.slice(line.indexOf(" ") + 1)}
                  </li>
                ))}
                {c.changes.length > 8 && <li className="text-faint">…and {c.changes.length - 8} more</li>}
              </ul>
            )}
            {c.canUpdate && !isOwner && <p className="text-xs text-muted">Only owners can update.</p>}
          </>
        )}
        {u?.state === "failed" && <p className="text-bad whitespace-pre-wrap">{u.message}</p>}
        {u?.state === "idle" && u.message && <p className="text-muted">{u.message}</p>}
        {error && <p className="text-bad">{error}</p>}
      </div>
    </section>
  );
}
