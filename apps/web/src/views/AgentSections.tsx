import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronRight, Trash2, X } from "lucide-react";
import type { Agent, Connector, Routine, Skill } from "@wisp/core";
import { soulPath } from "@wisp/core/src/soul.ts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go, href, type AgentTab } from "../router.ts";
import { effortName, prettyModel } from "../components/EffortSlider.tsx";
import { setChannelPrefs } from "../components/Channels.tsx";
import { computerSummary, whoCanAsk, type DeviceInfo } from "../devices.ts";
import { useComputerMode } from "../computerMode.ts";
import { AgentAvatar, cx, harnessLabel, timeAgo } from "../components/ui.tsx";

/** What each section is called, on the left list and at the top of its page. */
export const TAB_TITLES: Record<AgentTab, string> = {
  overview: "Overview",
  model: "Model",
  device: "Computer",
  computer: "Computer",
  access: "Who can ask it",
  routines: "Routines",
  background: "Background",
  memory: "Memory",
  skills: "Skills",
  apps: "Connected apps",
  permissions: "Permissions",
  connect: "Connect via MCP",
  runs: "Activity",
  look: "Look",
  soul: "Personality",
  instructions: "Instructions",
  remove: "Remove agent",
};

/** A grouped rounded card of rows (the same 24px card the rest of Wisp uses). */
export function RowCard({ children }: { children: ReactNode }) {
  return <div className="rounded-3xl bg-card border border-line/60 overflow-hidden divide-y divide-line/60">{children}</div>;
}

export function NavRow({ to, label, value, danger }: { to: string; label: string; value?: ReactNode; danger?: boolean }) {
  return (
    <a href={to} className={cx("flex items-center gap-3.5 min-h-12 px-[18px] text-body hover:bg-hover", danger && "text-bad")}>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {value != null && value !== "" && <span className="text-muted text-body truncate max-w-[55%]">{value}</span>}
      <ChevronRight size={18} className="text-faint shrink-0" aria-hidden />
    </a>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cx("relative h-[30px] w-[52px] shrink-0 rounded-full transition-colors disabled:opacity-50", on ? "bg-accent" : "bg-chip")}>
      <span className={cx("m-knob absolute top-[3px] left-[3px] size-6 rounded-full bg-white shadow", on && "translate-x-[22px]")} />
    </button>
  );
}

/** Pick-one rows with a check on the chosen one. */
export function ChoiceRows<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; title: string; body?: string }[] }) {
  return (
    <RowCard>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className="w-full flex items-center gap-3.5 min-h-12 px-[18px] py-2 text-left hover:bg-hover">
          <span className="flex-1 min-w-0">
            <span className="block text-body">{o.title}</span>
            {o.body && <span className="block text-sm text-muted">{o.body}</span>}
          </span>
          {value === o.value && <Check size={20} className="text-accent-text shrink-0" aria-hidden />}
        </button>
      ))}
    </RowCard>
  );
}

export function PageHead({ title }: { title: string }) {
  return (
    <div className="mb-4 hidden md:block">
      <h2 className="t-title">{title}</h2>
    </div>
  );
}

// --- Overview -------------------------------------------------------------------

/** The rows on the profile (phone) and the Overview page (desktop). */
export function OverviewRows({ agent, nodes }: { agent: Agent; nodes: DeviceInfo[] }) {
  const computers = useStore((s) => s.computers);
  const channels = useStore((s) => s.channels);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const skillsVersion = useStore((s) => s.skillsVersion);
  useEffect(() => {
    api<Routine[]>("GET", `/api/routines?agent=${agent.id}`).then(setRoutines, () => setRoutines([]));
    api<Skill[]>("GET", "/api/skills").then(setSkills, () => setSkills([]));
  }, [agent.id, skillsVersion]);
  const to = (tab: AgentTab) => href({ view: "agents", agentId: agent.id, tab });
  const { advanced } = useComputerMode();
  const computer = computers.find((c) => c.id === agent.computerId);
  const device = nodes.find((n) => n.id === agent.nodeId);
  const model = [agent.model ? prettyModel(agent.model) : "Automatic", agent.settings.effort ? effortName(agent.settings.effort) : null].filter(Boolean).join(" · ");
  const computerValue = computer ? computerSummary(computer, nodes, advanced) : agent.settings.headless ? "Headless" : device ? device.name : "None yet";
  const on = routines?.filter((r) => r.enabled).length ?? 0;
  const mine = skills?.filter((s) => s.allAgents || s.agentIds.includes(agent.id)).length ?? 0;
  const dm = channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`));
  const respond = whoCanAsk(agent, device);
  return (
    <div className="space-y-3.5">
      <RowCard>
        <NavRow to={to("model")} label="Model" value={model} />
        <NavRow to={to("computer")} label="Computer" value={computerValue} />
        <NavRow to={to("routines")} label="Routines" value={routines ? (on ? `${on} on` : "None") : ""} />
        <NavRow to={to("memory")} label="Memory" value={`agents/${agent.handle}`} />
        <NavRow to={to("skills")} label="Skills" value={skills ? String(mine) : ""} />
      </RowCard>
      <div className="md:hidden">
      <RowCard>
        <NavRow to={to("access")} label="Who can ask it" value={respond === "me" ? "Only me" : respond === "people" ? "Picked people" : "Anyone"} />
        <NavRow to={to("background")} label="Background" />
        <NavRow to={to("apps")} label="Connected apps" />
        <NavRow to={to("permissions")} label="Permissions" />
        <NavRow to={to("connect")} label="Connect via MCP" />
        <NavRow to={to("runs")} label="Activity" />
        <NavRow to={to("look")} label="Look" />
        <NavRow to={to("remove")} label="Remove agent" danger />
      </RowCard>
      </div>
      <RowCard>
        <div className="flex items-center justify-between min-h-14 px-[18px]">
          <span className="text-body">Notifications</span>
          <Toggle label={`Notifications from ${agent.name}`} on={dm ? dm.notify !== "mute" : true} disabled={!dm} onChange={(v) => dm && void setChannelPrefs(dm, { notify: v ? "default" : "mute" })} />
        </div>
      </RowCard>
    </div>
  );
}

// --- Who can ask it ---------------------------------------------------------------

export function AccessPanel({ agent, device }: { agent: Agent; device: DeviceInfo | undefined }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.me);
  const [error, setError] = useState<string | null>(null);
  const respond = whoCanAsk(agent, device);
  // on someone else's private device only they can open it up, whatever was picked here
  const locked = !!device && !device.mine && !device.shared && !agent.settings.anyoneCanAsk && respond === "me" && !(agent.settings.runIn === "computer" && agent.computerId);
  const picked = agent.settings.respondPeople ?? [];
  const save = async (settings: { respondTo?: "me" | "anyone" | "people"; respondPeople?: string[] }) => {
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const others = members.filter((m) => m.id !== me?.user.id);
  return (
    <div className="space-y-5 max-w-xl">
      {locked ? (
        <p className="px-[18px] text-sm text-muted">Only {device?.ownerName ?? "its owner"} can ask it, because it runs on their device "{device?.name}". They can open it up here.</p>
      ) : (
      <ChoiceRows
        value={respond}
        onChange={(v) => void save({ respondTo: v })}
        options={[
          { value: "me", title: "Only me", body: "Just you can message it" },
          { value: "anyone", title: "Anyone", body: "Everyone in the workspace" },
          { value: "people", title: "Picked people", body: "Choose who can ask" },
        ]}
      />
      )}
      {respond === "people" && (
        <section className="space-y-2">
          <h3 className="px-[18px] text-sm text-muted">Picked people</h3>
          {others.length ? (
            <RowCard>
              {others.map((p) => {
                const on = picked.includes(p.id);
                return (
                  <button key={p.id} type="button" role="checkbox" aria-checked={on} onClick={() => void save({ respondPeople: on ? picked.filter((x) => x !== p.id) : [...picked, p.id] })} className="w-full flex items-center gap-3.5 min-h-12 px-[18px] text-left hover:bg-hover">
                    <span className="flex-1 min-w-0">
                      <span className="block text-body">{p.name}</span>
                      <span className="block text-sm text-muted capitalize">{p.role}</span>
                    </span>
                    {on && <Check size={20} className="text-accent-text" aria-hidden />}
                  </button>
                );
              })}
            </RowCard>
          ) : (
            <p className="px-[18px] text-sm text-muted">Nobody else is here yet. Invite people first from Settings; until then it answers only you.</p>
          )}
        </section>
      )}
      {error && <p className="px-[18px] text-sm text-bad">{error}</p>}
    </div>
  );
}

// --- Memory -------------------------------------------------------------------------

interface NoteRow {
  path: string;
  title?: string;
  updatedAt?: number;
}

export function MemoryPanel({ agent }: { agent: Agent }) {
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  useEffect(() => {
    api<NoteRow[]>("GET", "/api/vault/notes").then((all) => setNotes(all.filter((n) => n.path.startsWith(`agents/${agent.id}/`)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))), () => setNotes([]));
  }, [agent.id]);
  const recent = useMemo(() => (notes ?? []).filter((n) => !/\/(SOUL|About)\.md$/.test(n.path)).slice(0, 5), [notes]);
  const title = (n: NoteRow) => n.title || n.path.split("/").pop()!.replace(/\.md$/, "");
  return (
    <div className="space-y-5 max-w-xl">
      <RowCard>
        <NavRow to={`#/vault/agents/${agent.id}`} label={`${agent.name}'s notes`} value={`agents/${agent.handle}`} />
      </RowCard>
      {recent.length > 0 && (
        <section className="space-y-2">
          <h3 className="px-[18px] text-sm text-muted">Recent notes</h3>
          <RowCard>
            {recent.map((n) => (
              <NavRow key={n.path} to={`#/vault/${n.path}`} label={title(n)} value={n.updatedAt ? timeAgo(new Date(n.updatedAt).toISOString()) : ""} />
            ))}
          </RowCard>
        </section>
      )}
      <section className="space-y-2">
        <h3 className="px-[18px] text-sm text-muted">Always remind it</h3>
        <RowCard>
          <NavRow to={href({ view: "agents", agentId: agent.id, tab: "soul" })} label="Personality" value="Loads when it starts" />
          <NavRow to={href({ view: "agents", agentId: agent.id, tab: "instructions" })} label="Instructions" value="Loads when it starts" />
          <NavRow to={href({ view: "agents", agentId: agent.id, tab: "permissions" })} label="Who can edit its notes" value={agent.settings.soulLocked ? "Only people" : "People and it"} />
        </RowCard>
      </section>
      <a href={`#/vault/${soulPath(agent.id).replace(/\/SOUL\.md$/, "")}`} className="h-14 rounded-full border border-control-line bg-control inline-flex items-center justify-center gap-2 w-full text-body font-medium hover:bg-hover">
        <BookOpen size={18} /> Open in Memory
      </a>
    </div>
  );
}

// --- Skills and apps ------------------------------------------------------------------

function SwitchList<T extends { id: string; name: string; agentIds: string[]; allAgents?: boolean }>({ items, agent, kind, body, empty, browse, browseTo }: { items: T[] | null; agent: Agent; kind: "skills" | "connectors"; body: (i: T) => string; empty: string; browse: string; browseTo: string }) {
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  if (!items) return <p className="text-sm text-muted">Loading…</p>;
  // an empty list means no agent has it yet, not every agent
  const isOn = (i: T) => local[i.id] ?? i.agentIds.includes(agent.id);
  const flip = async (i: T, on: boolean) => {
    setError(null);
    setLocal((l) => ({ ...l, [i.id]: on }));
    try {
      await api(on ? "PUT" : "DELETE", `/api/${kind}/${i.id}/agents/${agent.id}`);
    } catch (e) {
      setLocal((l) => ({ ...l, [i.id]: !on }));
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4 max-w-xl">
      {items.length === 0 ? (
        <p className="rounded-3xl border border-dashed border-line p-5 text-sm text-muted">{empty}</p>
      ) : (
        <RowCard>
          {items.map((i) => (
            <div key={i.id} className="flex items-center gap-3.5 min-h-12 px-[18px] py-2">
              <span className="flex-1 min-w-0">
                <span className="block text-body truncate">{i.name}</span>
                <span className="block text-sm text-muted truncate">{body(i)}</span>
              </span>
              {/* on for all agents: set where the item is, not per agent */}
              {i.allAgents ? (
                <span className="flex shrink-0 items-center gap-2.5">
                  <span className="text-[13px] text-faint">All agents</span>
                  <Toggle label={`${i.name} for ${agent.name} (on for all agents)`} on disabled onChange={() => {}} />
                </span>
              ) : (
                <Toggle label={`${i.name} for ${agent.name}`} on={isOn(i)} onChange={(v) => void flip(i, v)} />
              )}
            </div>
          ))}
        </RowCard>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      <a href={browseTo} className="h-14 rounded-full border border-control-line bg-control inline-flex items-center justify-center w-full text-body font-medium hover:bg-hover">
        {browse}
      </a>
    </div>
  );
}

export function SkillsPanel({ agent }: { agent: Agent }) {
  const [items, setItems] = useState<Skill[] | null>(null);
  const skillsVersion = useStore((s) => s.skillsVersion);
  useEffect(() => {
    api<Skill[]>("GET", "/api/skills").then(setItems, () => setItems([]));
  }, [agent.id, skillsVersion]);
  return <SwitchList items={items} agent={agent} kind="skills" body={(s) => s.description || "Added"} empty="No skills yet. Browse skills to add some." browse="Browse skills" browseTo={href({ view: "skills" })} />;
}

export function AppsPanel({ agent }: { agent: Agent }) {
  const [items, setItems] = useState<Connector[] | null>(null);
  const skillsVersion = useStore((s) => s.skillsVersion);
  useEffect(() => {
    api<Connector[]>("GET", "/api/connectors").then(setItems, () => setItems([]));
  }, [agent.id, skillsVersion]);
  return (
    <div className="space-y-4">
      <SwitchList items={items} agent={agent} kind="connectors" body={(c) => c.name} empty="No apps connected yet." browse="Connect an app" browseTo={href({ view: "connectors" })} />
    </div>
  );
}

// --- Remove -----------------------------------------------------------------------------

export function RemovePanel({ agent }: { agent: Agent }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/api/agents/${agent.id}`);
      await refreshAgents();
      go({ view: "agents", agentId: null });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="max-w-md mx-auto md:mx-0 flex flex-col items-center md:items-start gap-3 text-center md:text-left pt-4">
      <AgentAvatar agent={agent} size={96} />
      <h3 className="t-title">Remove {agent.name}?</h3>
      <p className="text-body text-muted">Its memory notes and personality stay in the vault. Its routines and chats with you stop.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="w-full flex flex-col gap-2.5 mt-2">
        <button onClick={remove} disabled={busy} className="h-14 rounded-full bg-bad text-white text-body font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2">
          <Trash2 size={18} /> Remove {agent.name}
        </button>
        <a href={href({ view: "agents", agentId: agent.id, tab: "overview" })} className="h-14 rounded-full border border-control-line bg-control text-body font-medium inline-flex items-center justify-center hover:bg-hover">
          Cancel
        </a>
      </div>
    </div>
  );
}

// --- Edit -----------------------------------------------------------------------------------

/** Name, handle and the three things that make it who it is. Personality, instructions and voice open their own pages. */
export function EditAgent({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const [name, setName] = useState(agent.name);
  const [handle, setHandle] = useState(agent.handle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = handle.trim().toLowerCase();
  const badHandle = !/^[a-z][a-z0-9-]{0,31}$/.test(clean);
  const taken = clean !== agent.handle && agents.some((a) => a.handle === clean);
  const dirty = name.trim() !== agent.name || clean !== agent.handle;
  const open = (tab: AgentTab) => () => {
    onClose();
    go({ view: "agents", agentId: agent.id, tab });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { name: name.trim(), ...(clean !== agent.handle ? { handle: clean } : {}) });
      await refreshAgents();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const row = (label: string, value: string, onClick: () => void) => (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3.5 min-h-12 px-[18px] text-left hover:bg-hover">
      <span className="flex-1 min-w-0">
        <span className="block text-body">{label}</span>
        <span className="block text-sm text-muted truncate">{value}</span>
      </span>
      <ChevronRight size={18} className="text-faint" aria-hidden />
    </button>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 md:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={`Edit ${agent.name}`} className="w-full md:max-w-[520px] max-h-[94vh] overflow-y-auto bg-panel rounded-t-[16px] md:rounded-xl shadow-panel p-5 pb-8 safe-bottom">
        <div className="flex items-center gap-3 mb-4">
          <button className="circle" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
          <h2 className="flex-1 text-center t-title mr-[42px]">Edit {agent.name}</h2>
        </div>
        <div className="flex flex-col items-center gap-3 mb-5">
          <AgentAvatar agent={agent} size={88} />
          <button type="button" onClick={open("look")} className="chip-btn h-10 px-4 rounded-full border border-control-line bg-control text-body font-medium hover:bg-hover">
            Edit look
          </button>
        </div>
        <div className="space-y-3.5">
          <label className="block rounded-3xl bg-card border border-line/60 px-[18px] py-3">
            <span className="block text-[13px] text-muted">Display name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Display name" className="w-full bg-transparent outline-none text-body" />
          </label>
          <div>
            <label className="block rounded-3xl bg-card border border-line/60 px-[18px] py-3">
              <span className="block text-[13px] text-muted">Handle</span>
              <input value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))} aria-label="Handle" className="w-full bg-transparent outline-none text-body" />
            </label>
            <p className={cx("px-[18px] pt-1.5 text-sm", badHandle || taken ? "text-bad" : "text-muted")}>{taken ? `@${clean} is already taken.` : badHandle ? "Include a letter a to z." : "Letters a to z. Teammates type this to mention it."}</p>
          </div>
          <RowCard>
            {row("Personality", "How it talks and what it values", open("soul"))}
            {row("Instructions", agent.settings.role ? agent.settings.role : "Its job and how it should reply", open("instructions"))}
            {row("Voice", "Pick how it sounds", open("look"))}
          </RowCard>
          {error && <p className="px-[18px] text-sm text-bad">{error}</p>}
          <button onClick={save} disabled={busy || !dirty || !name.trim() || badHandle || taken} className="h-14 w-full rounded-full bg-accent text-accent-ink text-body font-medium disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          <p className="text-center text-xs text-faint">{harnessLabel(agent.harness)}</p>
        </div>
      </div>
    </div>
  );
}
