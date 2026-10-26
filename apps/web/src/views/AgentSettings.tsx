import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, BookOpen, ChevronLeft, Radar, Ghost, Zap, Cpu, Eye, FileText, GitCommitHorizontal, LayoutGrid, Link2, ListChecks, Lock, Monitor, Pencil, Plug, Shield, ShieldAlert, Sparkles, Trash2, Unlock, Users, Wand2 } from "lucide-react";
import type { AccessLevel, AccessRule, Agent, HarnessCatalog, ModelOption } from "@wisp/core";
import { soulPath, soulTemplate } from "@wisp/core/src/soul.ts";
import { ConnectionInstructions } from "../components/ConnectionInstructions.tsx";
import { originReach, shareOrigin, useAccess } from "../access.ts";
import { ApiError, api } from "../api.ts";
import { useStore, useTeams } from "../store.ts";
import { go, guardLeaving, href, mayLeave, type AgentTab } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { LookPanel } from "./LookEditor.tsx";
import { EffortSlider, effortName, prettyModel } from "../components/EffortSlider.tsx";
import { Intro, SaveBar } from "./SettingsParts.tsx";
import { AccessPanel, EditAgent, MemoryPanel, AppsPanel, OverviewRows, PageHead, RemovePanel, SkillsPanel, TAB_TITLES } from "./AgentSections.tsx";
import { AgentAvatar, Button, CopyBlock, Field, harnessLabel, Input, Pill, StatusChip, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { LEVEL_LABEL, pathLabel, subjectLabel } from "../components/AccessDialog.tsx";
import { ComputerPanel, RoutinesPanel, runsOnDevice } from "./AgentComputer.tsx";
import { BackgroundPanel } from "./AgentBackground.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { agentReadiness, computerKindLabel, useDevices, type DeviceInfo } from "../devices.ts";
import { setupNextStep } from "../components/AgentPanel.tsx";
import { openDm } from "../openDm.ts";

export type NodeInfo = DeviceInfo;

type FullAgent = Agent & { instructions?: string };

/** The left list of sections on desktops (and the pages a profile row opens on phones). */
const SIDE: { id: AgentTab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: TAB_TITLES.overview, icon: <LayoutGrid size={18} /> },
  { id: "model", label: TAB_TITLES.model, icon: <Cpu size={18} /> },
  { id: "computer", label: TAB_TITLES.computer, icon: <Monitor size={18} /> },
  { id: "access", label: TAB_TITLES.access, icon: <Users size={18} /> },
  { id: "routines", label: TAB_TITLES.routines, icon: <ListChecks size={18} /> },
  { id: "background", label: TAB_TITLES.background, icon: <Radar size={18} /> },
  { id: "memory", label: TAB_TITLES.memory, icon: <BookOpen size={18} /> },
  { id: "skills", label: TAB_TITLES.skills, icon: <Wand2 size={18} /> },
  { id: "apps", label: TAB_TITLES.apps, icon: <Plug size={18} /> },
  { id: "permissions", label: TAB_TITLES.permissions, icon: <Shield size={18} /> },
  { id: "connect", label: "Connect", icon: <Link2 size={18} /> },
  { id: "runs", label: TAB_TITLES.runs, icon: <Activity size={18} /> },
  { id: "look", label: TAB_TITLES.look, icon: <Ghost size={18} /> },
];

/** The sections on the left list; Personality, Instructions and Device are opened from Edit and Computer, Remove from its own row. */
export const agentSections = () => SIDE.map((i) => i.id);

const TAB_SUBTITLE: Partial<Record<AgentTab, string>> = {
  overview: "How {name} is set up",
  model: "What {name} thinks with",
  computer: "Where {name} works",
  access: "Who can message {name}",
  routines: "Things {name} does on a schedule",
  background: "{name} checks your apps on its own and messages you first",
  memory: "What {name} remembers",
  skills: "What {name} knows how to do",
  apps: "Apps {name} can use",
  permissions: "What {name} may do without asking",
  connect: "Connect an agent that already runs somewhere else",
  runs: "Everything {name} has done lately",
  look: "How {name} looks and sounds",
  soul: "How {name} talks and what it values",
  instructions: "{name}'s job and how it should reply",
};

/**
 * One agent's page. Phones: the profile (big ghost, grouped rows) and each row's own page.
 * Desktops: a left list of sections with the selected one beside it. Editable sections stay
 * mounted so drafts survive switching sections; sections with unsaved changes show a dot.
 */
export function AgentDetail({ agent, nodes, tab }: { agent: FullAgent; nodes: NodeInfo[]; tab: AgentTab | null }) {
  const active = tab ?? "overview";
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState<Partial<Record<AgentTab, boolean>>>({});
  const hasDirty = Object.values(dirty).some(Boolean);
  useEffect(() => {
    if (!hasDirty) return;
    const unguard = guardLeaving(() => `${agent.name} has unsaved changes. Leave without saving them?`);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
      // Sections stay mounted, so moving between them keeps all edits.
      if (url.hash === `#/agents/${agent.id}` || url.hash.startsWith(`#/agents/${agent.id}/`)) return;
      if (!mayLeave()) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick);
    return () => {
      unguard();
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick);
    };
  }, [hasDirty, agent.id, agent.name]);
  const markDirty = useCallback((t: AgentTab) => (d: boolean) => setDirty((cur) => (cur[t] === d ? cur : { ...cur, [t]: d })), []);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [active]);

  const live = useStore((s) => s.live);
  const working = agent.status === "busy" || Object.values(live).some((r) => r.agentId === agent.id);
  const devices = useDevices();
  const readiness = agentReadiness(agent, devices);
  const next = setupNextStep(agent, devices);
  const device = active === "computer" || active === "device";
  const title = TAB_TITLES[active];
  const sub = (TAB_SUBTITLE[active] ?? "").replace(/\{name\}/g, agent.name);
  const back = href({ view: "agents", agentId: agent.id, tab: "overview" });
  const status = working ? (
    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-ok/15 text-ok text-xs font-medium">
      <span className="size-[7px] rounded-full bg-ok" /> Working
    </span>
  ) : (
    <StatusChip status={agent.status} />
  );

  const link = (id: AgentTab, label: string, icon: ReactNode) => {
    const here = active === id || (id === "computer" && device);
    return (
      <a key={id} href={href({ view: "agents", agentId: agent.id, tab: id })} aria-current={here ? "page" : undefined} className={cx("flex items-center gap-3 h-11 px-3.5 rounded-[14px] text-body font-medium", here ? "bg-card text-ink font-medium" : "text-ink/75 hover:text-ink hover:bg-hover")}>
        <span className="flex text-muted">{icon}</span>
        {label}
        {dirty[id] && <span className="ml-auto size-1.5 rounded-full bg-accent" aria-label="unsaved changes" />}
      </a>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* desktops: back, ghost, name, status, Edit and Message */}
      <header className="hidden md:flex shrink-0 items-center gap-4 px-8 pt-6 pb-5 border-b border-line">
        <a href="#/agents" className="circle" aria-label="Back to agents">
          <ChevronLeft size={20} />
        </a>
        <AgentAvatar agent={agent} size={56} live />
        <div className="flex-1 min-w-0">
          <h1 className="t-title truncate">{agent.name}</h1>
          <p className="text-sm text-muted truncate">
            @{agent.handle} · {harnessLabel(agent.harness)}
          </p>
        </div>
        {status}
        <button onClick={() => setEditing(true)} className="h-[42px] px-[18px] rounded-full border border-control-line bg-control text-sm font-medium hover:bg-hover">
          Edit
        </button>
        <button onClick={() => void openDm(agent.id)} className="h-[42px] px-5 rounded-full bg-accent text-accent-ink text-sm font-medium">
          Message
        </button>
      </header>
      {/* phones: back, and over a row's page a title with the agent's name under it */}
      <header className="md:hidden shrink-0 flex items-center gap-3 px-[18px] pt-3 pb-2 safe-top">
        <a href={active === "overview" ? "#/agents" : back} className="circle" aria-label={active === "overview" ? "Back to agents" : `Back to ${agent.name}`}>
          <ChevronLeft size={22} />
        </a>
        {active !== "overview" && (
          <>
            <div className="flex-1 min-w-0 text-center">
              <div className="text-body font-medium truncate">{title}</div>
              <div className="text-[13px] text-muted truncate">{agent.name}</div>
            </div>
            <span className="w-[52px]" aria-hidden />
          </>
        )}
      </header>
      <div className="flex-1 min-h-0 flex">
        <nav className="hidden md:flex w-[250px] shrink-0 border-r border-line overflow-y-auto px-3.5 py-[18px] flex-col gap-0.5" aria-label="Agent sections">
          {SIDE.map((i) => link(i.id, i.label, i.icon))}
          <span className="flex-1" />
          <a href={href({ view: "agents", agentId: agent.id, tab: "remove" })} aria-current={active === "remove" ? "page" : undefined} className={cx("flex items-center gap-3 h-11 px-3.5 rounded-[14px] text-body font-medium text-bad hover:bg-hover", active === "remove" && "bg-card")}>
            <Trash2 size={18} /> Remove agent
          </a>
        </nav>
        <div ref={content} className="flex-1 min-w-0 overflow-y-auto px-[18px] md:px-9 py-4 md:py-7 pb-24 md:pb-7">
          {active === "overview" && (
            <div className="max-w-[720px] space-y-4">
              {/* the profile, on phones */}
              <div className="md:hidden flex flex-col items-center gap-2.5 pt-2 pb-2">
                <AgentAvatar agent={agent} size={150} live />
                <h1 className="t-title">{agent.name}</h1>
                <p className="text-body text-muted">
                  @{agent.handle} · {harnessLabel(agent.harness)}
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setEditing(true)} className="h-10 px-5 rounded-full bg-chip text-base font-medium">
                    Edit
                  </button>
                  <button onClick={() => void openDm(agent.id)} className="h-10 px-5 rounded-full bg-accent text-accent-ink text-base font-medium">
                    Message
                  </button>
                </div>
              </div>
              <PageHead title="Overview" sub={sub} />
              {!readiness.ready && (
                <div role="status" className="rounded-3xl border border-warn/40 bg-warn/10 p-4 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    <Pill tone="warn">Setup incomplete</Pill> {readiness.problem}
                  </div>
                  <p className="text-muted mt-1">
                    Messages to {agent.name} will wait until that's fixed.
                    {next && (
                      <>
                        {" "}
                        {next.text}{" "}
                        <a href={next.href} className="text-accent-text underline">
                          {next.action}
                        </a>
                      </>
                    )}
                  </p>
                </div>
              )}
              <OverviewRows agent={agent} nodes={nodes} />
            </div>
          )}
          {active !== "overview" && <PageHead title={device ? TAB_TITLES.computer : title} sub={sub} />}
          <Panel show={active === "look"}>
            <LookPanel agent={agent} onDirty={markDirty("look")} active={active === "look"} />
          </Panel>
          <Panel show={active === "soul"}>
            <SoulPanel agent={agent} onDirty={markDirty("soul")} active={active === "soul"} />
          </Panel>
          <Panel show={active === "instructions"}>
            <InstructionsPanel agent={agent} onDirty={markDirty("instructions")} active={active === "instructions"} />
          </Panel>
          <Panel show={active === "model"}>
            <ModelPanel agent={agent} onDirty={markDirty("model")} active={active === "model"} />
          </Panel>
          <Panel show={device}>
            <ComputerPanel agent={agent} nodes={nodes} />
            <div className="mt-10 border-t border-line pt-6">
              <DevicePanel agent={agent} nodes={nodes} onDirty={markDirty("device")} active={device} />
            </div>
          </Panel>
          <Panel show={active === "access"}>
            <AccessPanel agent={agent} device={<WhoCanAsk agent={agent} device={nodes.find((n) => n.id === agent.nodeId)} />} />
          </Panel>
          <Panel show={active === "background"}>
            <BackgroundPanel agent={agent} active={active === "background"} onDirty={markDirty("background")} />
          </Panel>
          <Panel show={active === "routines"}>
            <RoutinesPanel agent={agent} active={active === "routines"} />
          </Panel>
          {active === "memory" && <MemoryPanel agent={agent} />}
          {active === "skills" && <SkillsPanel agent={agent} />}
          {active === "apps" && <AppsPanel agent={agent} />}
          <Panel show={active === "permissions"}>
            <PermissionsPanel agent={agent} nodes={nodes} onDirty={markDirty("permissions")} active={active === "permissions"} />
          </Panel>
          <Panel show={active === "connect"}>
            <ConnectPanel agent={agent} nodes={nodes} />
          </Panel>
          <Panel show={active === "runs"}>
            <RunsPanel agent={agent} active={active === "runs"} />
          </Panel>
          {active === "remove" && <RemovePanel agent={agent} />}
        </div>
      </div>
      {editing && <EditAgent agent={agent} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Panel({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" hidden={!show} className="max-w-[720px]">
      {children}
    </div>
  );
}

// --- Soul ---------------------------------------------------------------------

interface Commit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

function SoulPanel({ agent, onDirty, active }: { agent: FullAgent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const path = soulPath(agent.id);
  const [saved, setSaved] = useState<string | null>(null); // null = no soul yet
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [last, setLast] = useState<Commit | null>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = !!agent.settings.soulLocked;

  const load = useCallback(async () => {
    try {
      const n = await api<{ content: string }>("GET", `/api/vault/note?path=${encodeURIComponent(path)}`);
      setSaved(n.content);
      setDraft(n.content);
      const h = await api<Commit[]>("GET", `/api/vault/history?path=${encodeURIComponent(path)}`);
      setLast(h[0] ?? null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setSaved(null);
        setDraft("");
      } else setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);
  // pick up the agent's own edits when coming back to the tab
  useEffect(() => {
    if (active && saved !== null && draft === saved) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const dirty = saved === null ? draft.trim() !== "" : draft !== saved;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PUT", "/api/vault/note", { path, content: draft, message: `Update soul of @${agent.handle}` });
      await load();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggleLock = async () => {
    await api("PATCH", `/api/agents/${agent.id}`, { settings: { soulLocked: !locked } });
    await refreshAgents();
  };

  const html = useMemo(() => renderMarkdown(draft, { stripFrontmatter: true }), [draft]);
  const editedByAgent = last?.author === `@${agent.handle}`;

  return (
    <div>
      <Intro title="Personality">
        <p>
          Who @{agent.handle} is: personality, voice, values and boundaries. It's read at the start of every conversation. Keep it short; every line should change how the agent behaves. What it should <i>do</i> goes in{" "}
          <a className="text-accent-text hover:underline" href={`#/agents/${agent.id}/instructions`}>
            Instructions
          </a>
          .
        </p>
      </Intro>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
        <button
          onClick={toggleLock}
          role="switch"
          aria-checked={!locked}
          className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors", locked ? "bg-hover" : "bg-accent")}
          aria-label={`Let @${agent.handle} refine its own personality`}
        >
          <span className={cx("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", locked ? "left-0.5" : "left-[22px]")} />
        </button>
        <div className="flex-1 min-w-0 text-sm">
          <div className="font-medium flex items-center gap-1.5">
            {locked ? <Lock size={14} /> : <Unlock size={14} />} Let @{agent.handle} refine its own personality
          </div>
          <div className="text-muted">{locked ? "Locked: only people can change it." : "It can update this file as it learns who it is. Every change is kept in history."}</div>
        </div>
      </div>

      {!loaded ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : saved === null && !draft ? (
        <div className="rounded-xl border border-dashed border-line p-6 text-center space-y-3">
          <p className="text-sm text-muted">@{agent.handle} doesn't have a personality yet.</p>
          <Button variant="primary" onClick={() => setDraft(soulTemplate(agent.name, agent.handle))}>
            <Sparkles size={15} /> Start from a template
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2 lg:hidden">
            <Seg value={view} onChange={setView} options={[{ value: "write", label: "Write", icon: <Pencil size={13} /> }, { value: "preview", label: "Preview", icon: <Eye size={13} /> }]} />
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck
              aria-label="SOUL.md"
              className={cx("min-h-[420px] w-full resize-y rounded-xl border border-line bg-bg px-4 py-3 font-mono text-[13.5px] leading-relaxed outline-none focus:border-accent", view === "preview" && "hidden lg:block")}
            />
            <div className={cx("min-h-[420px] rounded-xl border border-line px-5 py-4 overflow-y-auto", view === "write" && "hidden lg:block")}>
              <div className="text-[13px] font-medium text-faint mb-2">Preview</div>
              <div className="prose-w text-body" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          </div>
        </>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onDiscard={() => setDraft(saved ?? "")}
        active={active}
        note={
          last && (
            <span className="inline-flex items-center gap-1.5">
              <GitCommitHorizontal size={14} />
              {editedByAgent ? `@${agent.handle} last refined its personality` : `Last edited by ${last.author}`} {timeAgo(last.date)} ·{" "}
              <a className="text-accent-text hover:underline" href={`#/vault/${path}`}>
                history
              </a>
            </span>
          )
        }
      />
    </div>
  );
}

// --- Instructions -------------------------------------------------------------

/** Follow remote saves only for fields still equal to their previous saved value. */
export function mergeSavedFields<T extends object>(draft: T, previous: T, saved: T): T {
  return Object.fromEntries(Object.keys(saved).map((key) => {
    const k = key as keyof T;
    return [k, Object.is(draft[k], previous[k]) ? saved[k] : draft[k]];
  })) as T;
}

function useSavedDraft<T extends object>(saved: T) {
  const [draft, setDraft] = useState(saved);
  const previous = useRef(saved);
  useEffect(() => {
    const before = previous.current;
    if (Object.keys(saved).every((k) => Object.is(saved[k as keyof T], before[k as keyof T]))) return;
    previous.current = saved;
    setDraft((current) => {
      const next = mergeSavedFields(current, before, saved);
      return Object.keys(next).every((k) => Object.is(next[k as keyof T], current[k as keyof T])) ? current : next;
    });
  }, [saved]);
  return [draft, setDraft] as const;
}

function InstructionsPanel({ agent, onDirty, active }: { agent: FullAgent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const others = useStore((s) => s.agents).filter((a) => a.id !== agent.id);
  const saved = agent.instructions ?? "";
  const savedRole = agent.settings.role ?? "";
  const savedNotes = agent.settings.roleNotes ?? "";
  const [form, setForm] = useSavedDraft({ draft: saved, role: savedRole, roleNotes: savedNotes });
  const { draft, role, roleNotes } = form;
  const setDraft = (value: string | ((d: string) => string)) => setForm((f) => ({ ...f, draft: typeof value === "function" ? value(f.draft) : value }));
  const setRole = (value: string) => setForm((f) => ({ ...f, role: value }));
  const setRoleNotes = (value: string) => setForm((f) => ({ ...f, roleNotes: value }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleDirty = role.trim() !== savedRole || roleNotes !== savedNotes;
  const dirty = draft !== saved || roleDirty;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const helper = others[0] ? `@${others[0].handle}` : "@another-agent";
  const snippets = [
    { label: "What it owns", text: `## What you own\nYou own <area>. You decide <what>, and you ask before <what>.` },
    { label: "Memory habits", text: `## Memory\n- Search memory before answering questions about past work.\n- After finishing something, append one line to me/log.md: what changed and why.\n- Put decisions everyone needs in shared/.` },
    { label: "Handoffs", text: `## Working with others\n- Hand work outside your area to ${helper} with task_delegate. Include what "done" means.\n- Mark your own tasks done with task_update and a short result.` },
    { label: "Reply style", text: `## Replies\n- Lead with the answer.\n- Say what you changed and where, with file paths.` },
  ];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { instructions: draft, ...(roleDirty ? { settings: { role: role.trim(), roleNotes } } : {}) });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Intro title="Instructions">
        <p>@{agent.handle}'s job: what it's responsible for, how it should work, and who to hand things to. Sent with every request.</p>
        <p className="inline-flex items-center gap-1">
          <Lock size={13} /> Only people can edit instructions. Agents can't change their own.
        </p>
      </Intro>
      <div className="mb-6 grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <Field label="Role" hint="A short title, like Engineer or Researcher.">
          <Input value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} placeholder="Engineer" aria-label="Role" />
        </Field>
        <Field label="What the role covers (optional)" hint="What it owns and what to send its way. The lead hands out work by it.">
          <Input value={roleNotes} onChange={(e) => setRoleNotes(e.target.value)} maxLength={2000} placeholder="Owns the backend and the build; send it bugs and API work." aria-label="What the role covers" />
        </Field>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <span className="text-xs text-muted self-center mr-1">Add a section:</span>
        {snippets.map((s) => (
          <button key={s.label} onClick={() => setDraft((d) => (d.trim() ? d.replace(/\s*$/, "\n\n") : "") + s.text + "\n")} className="text-xs rounded-full border border-line px-2.5 py-1 hover:bg-hover">
            + {s.label}
          </button>
        ))}
      </div>
      <Textarea
        rows={16}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Instructions"
        placeholder={`You own the backend. Keep notes on decisions in me/decisions.md, and hand UI work to ${helper}.`}
        className="font-mono text-[13.5px] leading-relaxed resize-y min-h-[300px]"
      />
      <div className="mt-1 text-xs text-faint text-right">{draft.length.toLocaleString()} / 20,000</div>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => (setDraft(saved), setRole(savedRole), setRoleNotes(savedNotes))} active={active} note={saved ? "Instructions are active." : "No instructions yet."} />
    </div>
  );
}

// --- Model --------------------------------------------------------------------

const ACCESS: Record<AccessLevel, { label: string; short: string; body: string }> = {
  "read-only": { label: "Read only", short: "read only", body: "Reads files and answers. Can't change anything on the device." },
  edit: { label: "Can edit files", short: "can edit", body: "Edits files in its own working folder. Recommended." },
  full: { label: "Full access", short: "full access", body: "No sandbox or permission checks. Only works on devices started with --allow-full-access." },
};

function ModelPanel({ agent, onDirty, active }: { agent: FullAgent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [info, setInfo] = useState<{ device: { name: string; online: boolean } | null; catalog: HarnessCatalog | null } | null>(null);
  const saved = { model: agent.model ?? "", effort: agent.settings.effort ?? "", fast: !!agent.settings.fast };
  const [form, setForm] = useSavedDraft(saved);
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headless = runsOnDevice(agent.harness);

  useEffect(() => {
    if (active) api("GET", `/api/agents/${agent.id}/models`).then(setInfo, () => setInfo({ device: null, catalog: null }));
  }, [agent.id, agent.nodeId, active]);

  const models = info?.catalog?.models ?? [];
  // a model id the catalog doesn't know about is shown as a custom model
  useEffect(() => {
    if (info && form.model && !models.some((m) => m.id === form.model)) setCustom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, form.model]);

  const dirty = form.model !== saved.model || form.effort !== saved.effort || form.fast !== saved.fast;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  // with no model picked the harness uses its own default, which has the efforts and fast tier too
  const selected: ModelOption | undefined = models.find((m) => m.id === (form.model || info?.catalog?.defaultModel));
  const efforts = selected?.efforts ?? info?.catalog?.efforts ?? ["low", "medium", "high"];
  const effortDropped = form.effort && !efforts.includes(form.effort);
  // the device's configured effort wins over the model's own default, as in Codex
  const defaultEffort = [info?.catalog?.defaultEffort, selected?.defaultEffort].find((e) => e && efforts.includes(e)) ?? efforts[0];
  const shownEffort = effortDropped || !form.effort ? defaultEffort : form.effort;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, {
        model: form.model.trim() || null,
        settings: { effort: effortDropped ? null : form.effort || null, fast: form.fast },
      });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!headless)
    return (
      <div>
        <Intro title="Model">
          <p>
            {harnessLabel(agent.harness)} joins through wisp-mcp, so its model and permissions are set inside {harnessLabel(agent.harness)} itself.
          </p>
        </Intro>
      </div>
    );

  const hLabel = harnessLabel(agent.harness);
  const isAuto = !form.model && !form.effort && !form.fast;
  const deviceGone = !agent.nodeId || !!(info?.device && !info.device.online);

  const why = !agent.nodeId
    ? "This agent isn't assigned to a device yet. Pick one under Device to see its models."
    : !info?.device
      ? null
      : !info.catalog
        ? info.device.online
          ? `${info.device.name} hasn't reported ${harnessLabel(agent.harness)} models. Make sure it's installed there (wisp doctor) and restart the device.`
          : `${info.device.name} is offline. Start it to see the models it offers.`
        : null;

  const controls = (
    <div className="space-y-6">
      <section>
        <Intro compact title="Model">
          <p>
            {info?.catalog ? (
              <>
                What {harnessLabel(agent.harness)} offers on <b>{info.device?.name}</b>
                {info.catalog.version && <span className="text-faint"> ({info.catalog.version})</span>}.
              </>
            ) : (
              `Which ${harnessLabel(agent.harness)} model this agent uses.`
            )}
          </p>
        </Intro>
        <div className="max-w-sm space-y-2">
          <select
            aria-label="Model"
            value={custom ? "__custom" : form.model}
            onChange={(e) => {
              if (e.target.value === "__custom") return setCustom(true);
              setCustom(false);
              setForm({ ...form, model: e.target.value });
            }}
            className="h-9 w-full rounded-lg border border-line bg-panel px-2.5 text-sm"
          >
            <option value="">Harness default</option>
            {models.length > 0 && (
              <optgroup label={`Available on ${info?.device?.name ?? "its device"}`}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {prettyModel(m.label)}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="__custom">Other model…</option>
          </select>
          {custom && <p className="text-xs text-muted">Type any model id the harness accepts.</p>}
        </div>
        {custom && (
          <div className="mt-2.5 max-w-sm">
            <Field label="Model id">
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={agent.harness === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"} autoFocus />
            </Field>
          </div>
        )}
      </section>

      <section>
        <Intro compact title="Reasoning effort">
          <p>More effort thinks deeper but replies slower. Default is {effortName(defaultEffort)}.</p>
        </Intro>
        {efforts.length > 0 && (
          <div className="max-w-sm space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-accent-text">{effortName(shownEffort)}</span>
              <button type="button" onClick={() => setForm({ ...form, effort: "" })} disabled={!form.effort} className="text-xs text-muted hover:text-ink disabled:opacity-40">
                {form.effort ? "Reset to default" : "Default"}
              </button>
            </div>
            <EffortSlider
              size="md"
              levels={efforts}
              value={shownEffort}
              onChange={(v) => setForm({ ...form, effort: v })}
            />
          </div>
        )}
        {effortDropped && <p className="mt-2 text-xs text-warn">{selected?.label ?? "This model"} doesn't support “{form.effort}”; it will use its default.</p>}
      </section>

      <section>
        <Intro compact title="Fast mode">
          <p>{selected?.fast ? `Runs on the model's faster tier${selected.fast.description ? `: ${selected.fast.description}` : ""}.` : "Not offered for this model."}</p>
        </Intro>
        <label className={cx("inline-flex items-center gap-2 text-sm", selected?.fast ? "cursor-pointer" : "opacity-50")}>
          <button
            type="button"
            role="switch"
            aria-checked={form.fast}
            disabled={!selected?.fast}
            onClick={() => setForm({ ...form, fast: !form.fast })}
            className={cx("relative h-5 w-9 rounded-full transition-colors", form.fast && selected?.fast ? "bg-accent" : "bg-chip")}
          >
            <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", form.fast && selected?.fast ? "left-[18px]" : "left-0.5")} />
          </button>
          <Zap size={14} className={cx(form.fast && selected?.fast && "text-accent-text fill-accent")} /> Fast mode
        </label>
      </section>
    </div>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-accent bg-accent-soft p-3 text-sm">
          <div className="font-medium">{isAuto ? "Automatic (recommended)" : `Custom: ${form.model ? prettyModel(form.model) : "your own settings"}`}</div>
          <p className="mt-0.5 text-muted">
            {isAuto ? `Wisp lets ${hLabel} pick the model and effort. That's right for most people.` : `You chose the model or effort yourself. Automatic lets ${hLabel} pick for you.`}
          </p>
          {!isAuto && (
            <Button className="mt-2" onClick={() => (setForm({ model: "", effort: "", fast: false }), setCustom(false))}>
              Back to automatic
            </Button>
          )}
        </section>
      {/* the controls are folded, so why there are no models to pick sits by the Automatic card */}
      {!deviceGone && why && <p className="max-w-sm rounded-lg bg-hover px-3 py-2 text-xs text-muted">{why}</p>}
      {deviceGone ? (
        <p className="text-sm text-muted">
          {agent.nodeId ? (
            `Connect ${info?.device?.name ?? "its device"} to see available models.`
          ) : (
            <>
              <a className="text-accent-text hover:underline" href={`#/agents/${agent.id}/device`}>
                Pick a device on the Device tab
              </a>{" "}
              to see available models.
            </>
          )}
        </p>
      ) : (
        <MoreOptions title="Choose the model yourself">{controls}</MoreOptions>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => (setForm(saved), setCustom(!!saved.model && !models.some((m) => m.id === saved.model)))} active={active} note="Changes apply from the next message." />
    </div>
  );
}

function Choice({ selected, onClick, title, body, meta, danger }: { selected: boolean; onClick: () => void; title: string; body?: string; meta?: string; danger?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx("text-left rounded-xl border p-3 flex gap-3 transition-colors", selected ? (danger ? "border-bad/60 bg-bad/10" : "border-accent bg-accent-soft") : "border-line hover:bg-hover")}
    >
      <span className={cx("mt-0.5 size-4 shrink-0 rounded-full border-2 grid place-items-center", selected ? (danger ? "border-bad" : "border-accent") : "border-faint")}>
        {selected && <span className={cx("size-2 rounded-full", danger ? "bg-bad" : "bg-accent")} />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">
          {title} {meta && meta !== title && <span className="font-mono text-[11px] text-faint ml-1">{meta}</span>}
        </span>
        {body && <span className="block text-xs text-muted mt-0.5">{body}</span>}
      </span>
    </button>
  );
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[] }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-line p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("px-3 h-8 rounded-md text-sm capitalize inline-flex items-center gap-1.5", value === o.value ? "bg-accent text-accent-ink font-medium" : "text-muted hover:text-ink")}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}

// --- Device -------------------------------------------------------------------

function DevicePanel({ agent, nodes, onDirty, active }: { agent: FullAgent; nodes: NodeInfo[]; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const saved = agent.nodeId ?? "";
  const [{ nodeId }, setDevice] = useSavedDraft({ nodeId: saved });
  const setNodeId = (value: string) => setDevice({ nodeId: value });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = nodeId !== saved;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { nodeId: nodeId || null });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Intro title="Device">
        <p>
          {runsOnDevice(agent.harness)
            ? `The device that runs ${harnessLabel(agent.harness)} for @${agent.handle} whenever it's mentioned. It works in ~/.wisp/agents/${agent.handle}/ there (or in the folder it shares with its VM). Where it clicks and types is its Computer.`
            : `Optional: ${harnessLabel(agent.harness)} can also join through wisp-mcp from wherever it runs (see Connect).`}
        </p>
      </Intro>
      <div className="grid sm:grid-cols-2 gap-2 max-w-2xl">
        <Choice selected={!nodeId} onClick={() => setNodeId("")} title="No device" body="It can't answer @mentions until it has one." />
        {nodes
          .filter((n) => n.mine || n.shared || n.id === saved)
          .map((n) => (
            <Choice key={n.id} selected={nodeId === n.id} onClick={() => setNodeId(n.id)} title={n.name} body={`${n.mine ? "Yours" : `${n.ownerName ?? "Someone"}'s`} · ${n.online ? "online" : "offline"}${n.agents.length ? ` · runs ${n.agents.map((h) => "@" + h).join(", ")}` : ""}`} />
          ))}
      </div>
      <p className="mt-3 text-sm text-muted">
        Need another computer?{" "}
        <a className="text-accent-text hover:underline" href="#/nodes">
          Add a device
        </a>
      </p>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setNodeId(saved)} active={active} />
    </div>
  );
}

// --- Permissions --------------------------------------------------------------

/**
 * An agent whose harness runs directly on someone's device can reach that device's files, so by
 * default only the device's owner can ask it for things. The owner can open it up.
 */
function WhoCanAsk({ agent, device }: { agent: FullAgent; device: NodeInfo | undefined }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [error, setError] = useState<string | null>(null);
  if (!device || !runsOnDevice(agent.harness)) return null;
  const open = !!agent.settings.anyoneCanAsk || !!device.shared;
  const owner = device.mine ? "you" : (device.ownerName ?? "its owner");
  const set = async (anyone: boolean) => {
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { anyoneCanAsk: anyone } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <Intro title="Who can ask it">
        <p>
          @{agent.handle} runs directly on {device.mine ? "your" : `${device.ownerName ?? "someone"}'s`} device "{device.name}", where it can reach files.{" "}
          {device.shared ? "That device is shared with the organization, so everyone can ask it." : `So only ${owner} can ask it for things, including through other agents.`}
        </p>
      </Intro>
      {device.mine && !device.shared ? (
        <div className="grid sm:grid-cols-2 gap-2 max-w-2xl">
          <Choice selected={!open} onClick={() => set(false)} title="Only me" body="Requests from anyone else, or from agents working for them, are turned away." />
          <Choice selected={open} onClick={() => set(true)} title="Anyone in the organization" body="People and their agents can ask it. It still can't use your own screen for them." />
        </div>
      ) : (
        <p className="text-sm text-muted">{open ? "Anyone in the organization can ask it." : `Only ${owner} can ask it.`}</p>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </section>
  );
}

/** The effective reach of an access level in plain words (edit = the harness's workspace sandbox: its own folder). */
export function accessScope(access: AccessLevel, name: string, handle: string, device: string | undefined): string {
  if (!device) return "It has no device yet, so it can't touch any files.";
  if (access === "read-only") return `${name} asks before changing any file on ${device}.`;
  if (access === "edit") return `${name} may change files in its own working folder on ${device} (~/.wisp/agents/${handle}) and asks before changing files elsewhere. Some harnesses can't enforce this strictly.`;
  return `${name} may change files and run commands on ${device}, if ${device} allows full access (a device can refuse and drop it to Edit).`;
}

function PermissionsPanel({ agent, nodes, onDirty, active }: { agent: FullAgent; nodes: NodeInfo[]; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const saved = agent.settings.access ?? "edit";
  const [{ access }, setPermissions] = useSavedDraft({ access: saved });
  const setAccess = (value: AccessLevel) => setPermissions({ access: value });
  const [memory, setMemory] = useState<{ rules: AccessRule[]; sharedOut: AccessRule[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = access !== saved;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (active) api<{ rules: AccessRule[]; sharedOut: AccessRule[] }>("GET", `/api/access/agents/${agent.id}`).then(setMemory, () => setMemory({ rules: [], sharedOut: [] }));
  }, [active, agent.id]);

  const where = (r: AccessRule) => pathLabel(r.path, agents, members) || "the whole vault";
  const through = (r: AccessRule) => (r.subject.kind === "agent" ? "" : ` · via ${subjectLabel(r.subject, agents, members)}`);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { access } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <Intro title="On its device">
          <p>What @{agent.handle} may do with files and commands on the computer it runs on.</p>
        </Intro>
        <div className="grid sm:grid-cols-3 gap-2">
          {(Object.keys(ACCESS) as AccessLevel[]).map((a) => (
            <Choice key={a} selected={access === a} onClick={() => setAccess(a)} title={ACCESS[a].label} body={ACCESS[a].body} danger={a === "full"} />
          ))}
        </div>
        <p role="status" className="mt-3 text-sm">
          {accessScope(access, agent.name, agent.handle, nodes.find((n) => n.id === agent.nodeId)?.name)}
        </p>
        {access === "full" && (
          <p className="mt-3 flex gap-2 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
            <ShieldAlert size={16} className="shrink-0 mt-0.5" />
            The agent can run any command as the device's user. The device must opt in with <code>wisp node start --allow-full-access</code>; otherwise it runs with edit access.
          </p>
        )}
      </section>

      <WhoCanAsk agent={agent} device={nodes.find((n) => n.id === agent.nodeId)} />

      <section>
        <Intro title="In memory">
          <p>
            Which folders and notes @{agent.handle} can use, and why. Change them with the share button on any folder or note in{" "}
            <a className="text-accent-text hover:underline" href="#/vault">
              Memory
            </a>
            , or under{" "}
            <a className="text-accent-text hover:underline" href="#/settings">
              Settings → Memory
            </a>
            .
          </p>
        </Intro>
        <div className="rounded-xl border border-line divide-y divide-line text-sm max-w-2xl">
          {memory === null ? (
            <Row label="Loading">…</Row>
          ) : (
            [...memory.rules].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())).map((r) => (
              <Row key={`${r.path}|${r.subject.kind}|${r.id ?? "default"}`} label={where(r)}>
                <span className={r.level === "none" ? "text-muted" : undefined}>{LEVEL_LABEL[r.level]}</span>
                <span className="text-muted">
                  {through(r)}
                  {r.builtin ? " · default" : r.createdBy?.kind === "agent" ? ` · shared by ${subjectLabel({ kind: "agent", id: r.createdBy.id }, agents, members)}` : ""}
                </span>
                {r.startup && (
                  <span className="ml-2 inline-flex">
                    <Pill tone="accent">loads at startup</Pill>
                  </span>
                )}
              </Row>
            ))
          )}
          <Row label="Its folder is shared with">
            {memory === null ? "…" : memory.sharedOut.length ? memory.sharedOut.map((r) => `${subjectLabel(r.subject, agents, members)} (${LEVEL_LABEL[r.level].toLowerCase()}${r.path !== `agents/${agent.id}` ? ` ${where(r)}` : ""})`).join(", ") : "No one else"}
          </Row>
          <Row label="Personality">{agent.settings.soulLocked ? "Locked: only people can edit it" : "It can refine its own personality"}</Row>
          <Row label="Instructions">Only people can edit them</Row>
        </div>
      </section>

      {error && <p className="text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setAccess(saved)} active={active} note="Applies from the next message." />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-2.5 flex gap-4">
      <span className="w-48 shrink-0 text-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// --- Overview -----------------------------------------------------------------

interface RunRow {
  id: string;
  status: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  channelId: string;
  threadId: string | null;
  channelName: string | null;
  channelKind: string | null;
  trigger: string | null;
  /** "background" for a check the agent made on its own; an empty trigger alone can also mean a DM the viewer can't see */
  kind?: string | null;
  /** a failure in plain words, when the hub recognised it (the harness needs signing in on its device) */
  hint?: string | null;
}

/** What's wrong with the agent right now: its latest run failed for a reason people can fix. */
function problem(runs: RunRow[] | null): string | null {
  const last = runs?.[0];
  return last?.status === "failed" && last.hint ? last.hint : null;
}

const RUN_TONE: Record<string, "ok" | "bad" | "warn" | "info" | "neutral"> = { done: "ok", failed: "bad", running: "info", queued: "warn", cancelled: "neutral" };

/** A run's status in plain words. */
export function runStatusLabel(status: string): string {
  const known: Record<string, string> = { queued: "Waiting to start", running: "Working", done: "Done", failed: "Didn't finish", cancelled: "Stopped" };
  return known[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

/** A readable name for a run, from the body of the message that woke the agent ("" when there's no message to show). */
export function runTitle(trigger: string | null): string {
  const text = (trigger ?? "").trim();
  if (!text) return "";
  const body = text.replace(/^(?:@[\w.-]+\s*)+/, "");
  const task = body.match(/^New task \*\*(.+?)\*\*/);
  if (task) return `Task: ${task[1]}`;
  const routine = body.match(/^Run the routine \*\*(.+?)\*\*/);
  if (routine) return `Routine: ${routine[1]}`;
  const learn = body.match(/^I just showed you how to \*\*(.+?)\*\*/);
  if (learn) return `Learning: ${learn[1]}`;
  const line = (body.split("\n").find((l) => l.trim()) ?? "")
    .replace(/\*\*|`/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "Message";
  return line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line;
}

// --- Runs ---------------------------------------------------------------------

function RunsPanel({ agent, active }: { agent: FullAgent; active: boolean }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  useEffect(() => {
    if (active) api<RunRow[]>("GET", `/api/agents/${agent.id}/runs?limit=50`).then(setRuns, () => setRuns([]));
  }, [active, agent.id]);
  return (
    <div className="max-w-4xl">
      <Intro title="Activity">
        <p>Every time @{agent.handle} was woken up: where, by what, and how it went.</p>
      </Intro>
      <RunList runs={runs} />
    </div>
  );
}

function RunList({ runs, compact }: { runs: RunRow[] | null; compact?: boolean }) {
  if (!runs) return <p className="text-sm text-muted">Loading…</p>;
  if (!runs.length) return <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Nothing yet. Message the agent to give it something to do.</p>;
  return (
    <div className="rounded-3xl bg-card border border-line/60 overflow-hidden divide-y divide-line/60">
      {runs.map((r) => {
        const secs = r.finishedAt ? Math.max(0, Math.round((new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()) / 1000)) : null;
        const channel = r.channelKind === "dm" ? "DM" : `#${r.channelName ?? ""}`;
        const why = r.hint || r.error;
        return (
          <div key={r.id} className="px-4 py-2.5 text-sm">
            <div className="flex items-center gap-3">
              <Pill tone={RUN_TONE[r.status] ?? "neutral"}>{runStatusLabel(r.status)}</Pill>
              <span className="min-w-0 flex-1">
                <a href={`#/c/${r.channelId}${r.threadId ? `/t/${r.threadId}` : ""}`} className="block truncate hover:underline">
                  {r.kind === "background" ? "Background check" : runTitle(r.trigger) || "Message"}
                </a>
                {!compact && why && <span className="block text-xs text-bad truncate">{why}</span>}
              </span>
              <span className="text-xs text-muted shrink-0 hidden sm:inline">{channel}</span>
              {secs !== null && <span className="text-xs text-faint shrink-0 tabular-nums w-10 text-right">{secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}</span>}
              <span className="text-xs text-faint shrink-0 w-16 text-right">{timeAgo(r.createdAt)}</span>
            </div>
            {!compact && (
              <details className="mt-1 text-xs text-muted">
                <summary className="cursor-pointer select-none">Details</summary>
                <div className="mt-1.5 space-y-1">
                  <ol className="mb-2 space-y-1 border-l border-line pl-3">
                    <li>
                      You asked: {runTitle(r.trigger) || "a message"} <span className="text-faint">· {channel}</span>
                    </li>
                    <li className={r.status === "failed" ? "text-bad" : undefined}>{r.status === "failed" ? `Didn't finish${why ? `: ${why}` : ""}` : r.status === "done" ? `Done${secs !== null ? ` in ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}` : ""}` : runStatusLabel(r.status)}</li>
                  </ol>
                  <div>
                    Run id: <span className="font-mono break-all">{r.id}</span>
                  </div>
                  <div>Channel: {channel}</div>
                  {r.trigger && <div className="whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-lg bg-hover px-2 py-1.5">{r.trigger}</div>}
                  {r.error && <div className="text-bad break-words">Error: {r.error}</div>}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Connect ------------------------------------------------------------------

function ConnectPanel({ agent, nodes }: { agent: FullAgent; nodes: NodeInfo[] }) {
  const [token, setToken] = useState<string | null>(null);
  const device = nodes.find((n) => n.id === agent.nodeId);
  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-2">
        <h3 className="font-semibold">Runs on a device</h3>
        <p className="text-sm text-muted">
          {runsOnDevice(agent.harness)
            ? device
              ? `When someone @mentions @${agent.handle}, ${device.name} starts ${harnessLabel(agent.harness)}, gives it the wisp tools, and posts the reply.`
              : "Pick a device in General so the agent can answer when it's mentioned."
            : `${harnessLabel(agent.harness)} doesn't have a headless adapter yet. Connect a running session below.`}
        </p>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          <FileText size={16} /> Connect an existing session (MCP)
        </h3>
        <p className="text-sm text-muted">Give any MCP-capable harness this agent's identity, memory, chat and task tools. The token is shown once.</p>
        {token ? (
          <ConnectionInstructions token={token} harness={agent.harness} />
        ) : (
          <Button onClick={async () => setToken((await api<{ token: string }>("POST", `/api/agents/${agent.id}/token`)).token)}>Create connection token</Button>
        )}
      </section>
      <RemoteMcp agent={agent} />
    </div>
  );
}

/** The hub's remote MCP address, for Grok, ChatGPT and Claude connectors, and the apps connected as this agent. */
function RemoteMcp({ agent }: { agent: FullAgent }) {
  useAccess();
  const [apps, setApps] = useState<{ id: string; name: string; approvedBy: string | null; lastUsed: string | null; createdAt: string }[]>([]);
  const load = useCallback(() => {
    api<typeof apps>("GET", `/api/agents/${agent.id}/apps`).then(setApps, () => {});
  }, [agent.id]);
  useEffect(load, [load]);
  return (
    <section className="space-y-3">
      <h3 className="font-semibold flex items-center gap-2">
        <Plug size={16} /> Connect by URL
      </h3>
      <p className="text-sm text-muted">Add as a custom connector in Grok, ChatGPT or Claude, then pick @{agent.handle} when you sign in.</p>
      <CopyBlock text={`${shareOrigin()}/mcp`} />
      {originReach(shareOrigin()) !== "anywhere" && (
        <p className="text-xs text-muted">
          They need an https address that works from anywhere: <a className="underline" href={href({ view: "settings", page: "access" })}>Settings → Access</a>
        </p>
      )}
      {apps.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {apps.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{a.name}</span>
                <span className="block text-xs text-muted truncate">{a.lastUsed ? `Used ${timeAgo(a.lastUsed)}` : `Added ${timeAgo(a.createdAt)}`}{a.approvedBy ? ` · ${a.approvedBy}` : ""}</span>
              </span>
              <Button
                variant="ghost"
                onClick={async () => {
                  await api("DELETE", `/api/agents/${agent.id}/apps/${a.id}`);
                  load();
                }}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
