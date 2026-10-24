import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, BookOpen, Radar, Ghost, Zap, Check, ChevronRight, Cpu, Eye, FileText, GitCommitHorizontal, LayoutGrid, ListChecks, Lock, MessageSquare, Monitor, Pencil, Plug, ScrollText, Server, Shield, ShieldAlert, Sparkles, Trash2, Unlock } from "lucide-react";
import type { AccessLevel, AccessRule, Agent, HarnessCatalog, ModelOption } from "@warren/core";
import { soulPath, soulTemplate } from "@warren/core/src/soul.ts";
import { ConnectionInstructions } from "../components/ConnectionInstructions.tsx";
import { ApiError, api } from "../api.ts";
import { useStore, useTeams } from "../store.ts";
import { go, guardLeaving, href, mayLeave, type AgentTab } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { LookPanel } from "./LookEditor.tsx";
import { EffortSlider, effortName, prettyModel } from "../components/EffortSlider.tsx";
import { Intro, SaveBar } from "./SettingsParts.tsx";
import { AgentAvatar, Button, CopyBlock, Field, harnessLabel, Input, Pill, StatusChip, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { LEVEL_LABEL, pathLabel, subjectLabel } from "../components/AccessDialog.tsx";
import { ComputerPanel, RoutinesPanel, runsOnDevice } from "./AgentComputer.tsx";
import { BackgroundPanel } from "./AgentBackground.tsx";
import { Advanced, SimpleOnly, useSimple } from "../experience.tsx";
import { agentReadiness, computerKindLabel, useDevices, type DeviceInfo } from "../devices.ts";
import { setupNextStep } from "../components/AgentPanel.tsx";
import { openDm } from "../openDm.ts";

export type NodeInfo = DeviceInfo;

type FullAgent = Agent & { instructions?: string };

/** Paperclip-style grouped navigation for an agent's settings. */
const NAV: { group: string; items: { id: AgentTab; label: string; icon: ReactNode }[] }[] = [
  {
    group: "Agent",
    items: [
      { id: "overview", label: "Overview", icon: <LayoutGrid size={16} /> },
      { id: "look", label: "Look", icon: <Ghost size={16} /> },
      { id: "soul", label: "Personality", icon: <Sparkles size={16} /> },
      { id: "instructions", label: "Instructions", icon: <ScrollText size={16} /> },
    ],
  },
  {
    group: "Runtime",
    items: [
      { id: "model", label: "Model", icon: <Cpu size={16} /> },
      { id: "device", label: "Device", icon: <Server size={16} /> },
      { id: "computer", label: "Computer", icon: <Monitor size={16} /> },
      { id: "background", label: "Background", icon: <Radar size={16} /> },
      { id: "routines", label: "Routines", icon: <ListChecks size={16} /> },
    ],
  },
  {
    group: "Access",
    items: [
      { id: "permissions", label: "Permissions", icon: <Shield size={16} /> },
      { id: "connect", label: "Connect", icon: <Plug size={16} /> },
    ],
  },
  { group: "Activity", items: [{ id: "runs", label: "Activity", icon: <Activity size={16} /> }] },
];

/** The nav groups for the mode. Simple keeps the everyday tabs on top and gathers the technical ones under "Advanced" (still one click away). */
export function agentNav(simple: boolean): typeof NAV {
  if (!simple) return NAV;
  const all = new Map(NAV.flatMap((g) => g.items).map((i) => [i.id, i] as const));
  const pick = (ids: AgentTab[]) => ids.map((id) => all.get(id)!);
  return [
    { group: "Agent", items: pick(["overview", "soul", "instructions"]) },
    { group: "Runtime", items: pick(["device", "computer", "routines"]) },
    { group: "Activity", items: pick(["runs"]) },
    { group: "Advanced", items: pick(["model", "permissions", "connect", "background", "look"]) },
  ];
}

/**
 * One agent's page: a breadcrumb header, a grouped secondary sidebar (chips on phones), and
 * the selected section. Editable sections stay mounted so drafts survive switching sections;
 * sections with unsaved changes show a dot.
 */
export function AgentDetail({ agent, nodes, tab }: { agent: FullAgent; nodes: NodeInfo[]; tab: AgentTab | null }) {
  const channels = useStore((s) => s.channels);
  const nav = agentNav(useSimple());
  const active = tab ?? "overview";
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

  async function openDm() {
    const existing = channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`));
    const ch: { id: string } = existing ?? (await api("POST", `/api/dm/${agent.id}`));
    if (!existing) await useStore.getState().refreshChannels();
    go({ view: "chat", channelId: ch.id, threadId: null });
  }

  const link = (id: AgentTab, label: string, icon: ReactNode, chip?: boolean) => (
    <a
      key={id}
      href={`#/agents/${agent.id}/${id}`}
      aria-current={active === id ? "page" : undefined}
      className={cx(
        chip ? "h-8 px-3 rounded-full border text-sm whitespace-nowrap" : "h-8 px-2 rounded-lg text-[13px] font-medium w-full",
        "flex items-center gap-2.5",
        active === id ? (chip ? "border-accent bg-accent-soft text-ink" : "bg-accent-soft text-ink") : chip ? "border-line text-muted" : "text-ink/80 hover:text-ink hover:bg-hover",
      )}
    >
      {icon} {label}
      {dirty[id] && <span className="ml-auto size-1.5 rounded-full bg-accent" aria-label="unsaved changes" />}
    </a>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        <a href="#/agents" className="text-lg font-bold tracking-tight text-muted hover:text-ink">
          Agents
        </a>
        <ChevronRight size={14} className="text-faint shrink-0" />
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium truncate">{agent.name}</span>
        </span>
        <Button onClick={openDm}>
          <MessageSquare size={15} /> <span className="hidden sm:inline">Message</span>
        </Button>
        <Button variant="ghost" onClick={() => go({ view: "vault", path: soulPath(agent.id) })} title="Open its memory folder">
          <BookOpen size={15} /> <span className="hidden sm:inline">Memory</span>
        </Button>
      </header>
      <nav className="md:hidden shrink-0 flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-line" aria-label="Agent sections">
        {nav.flatMap((g) => g.items).map((i) => link(i.id, i.label, i.icon, true))}
      </nav>
      <div className="flex-1 min-h-0 flex">
        <nav className="hidden md:block w-52 shrink-0 border-r border-line overflow-y-auto p-2 pt-4 space-y-4" aria-label="Agent sections">
          {nav.map((g) => (
            <div key={g.group} className="space-y-px">
              <div className="px-2 pb-1 text-[13px] font-semibold text-muted">{g.group}</div>
              {g.items.map((i) => link(i.id, i.label, i.icon))}
            </div>
          ))}
        </nav>
        <div ref={content} className="flex-1 min-w-0 overflow-y-auto px-4 md:px-8 py-6">
          <Panel show={active === "overview"}>
            <OverviewPanel agent={agent} nodes={nodes} active={active === "overview"} />
          </Panel>
          <Panel show={active === "look"}>
            <LookPanel agent={agent} onDirty={markDirty("look")} active={active === "look"} />
          </Panel>
          <Panel show={active === "soul"} hint="How it talks and what it values.">
            <SoulPanel agent={agent} onDirty={markDirty("soul")} active={active === "soul"} />
          </Panel>
          <Panel show={active === "instructions"} hint="Its job and how it should reply.">
            <InstructionsPanel agent={agent} onDirty={markDirty("instructions")} active={active === "instructions"} />
          </Panel>
          <Panel show={active === "model"} hint="Which AI model it uses and how hard it thinks.">
            <ModelPanel agent={agent} onDirty={markDirty("model")} active={active === "model"} />
          </Panel>
          <Panel show={active === "device"} hint="The computer that runs this helper.">
            <DevicePanel agent={agent} nodes={nodes} onDirty={markDirty("device")} active={active === "device"} />
          </Panel>
          <Panel show={active === "computer"} hint="Where it opens apps and websites. Optional.">
            <ComputerPanel agent={agent} nodes={nodes} />
          </Panel>
          <Panel show={active === "background"} hint="What it does on its own while you're away.">
            <BackgroundPanel agent={agent} active={active === "background"} onDirty={markDirty("background")} />
          </Panel>
          <Panel show={active === "routines"} hint="Jobs it does on a schedule.">
            <RoutinesPanel agent={agent} active={active === "routines"} />
          </Panel>
          <Panel show={active === "permissions"} hint="What it may do without asking.">
            <PermissionsPanel agent={agent} nodes={nodes} onDirty={markDirty("permissions")} active={active === "permissions"} />
          </Panel>
          <Panel show={active === "connect"} hint="Connect an agent that already runs somewhere else.">
            <ConnectPanel agent={agent} nodes={nodes} />
          </Panel>
          <Panel show={active === "runs"} hint="Everything it has done lately, newest first.">
            <RunsPanel agent={agent} active={active === "runs"} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ show, hint, children }: { show: boolean; hint?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" hidden={!show} className="max-w-4xl">
      {hint && (
        <SimpleOnly>
          <p className="mb-3 text-sm text-muted">{hint}</p>
        </SimpleOnly>
      )}
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
              <div className="text-[13px] font-semibold text-faint mb-2">Preview</div>
              <div className="prose-w text-[15px]" dangerouslySetInnerHTML={{ __html: html }} />
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
  const simple = useSimple();

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

  const selected: ModelOption | undefined = models.find((m) => m.id === form.model);
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
            {harnessLabel(agent.harness)} joins through warren-mcp, so its model and permissions are set inside {harnessLabel(agent.harness)} itself.
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
          ? `${info.device.name} hasn't reported ${harnessLabel(agent.harness)} models. Make sure it's installed there (warren doctor) and restart the device.`
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
        {why && !simple && <p className="mb-2.5 max-w-sm rounded-lg bg-hover px-3 py-2 text-xs text-muted">{why}</p>}
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
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={agent.harness === "codex" ? "gpt-6-astra" : "claude-opus-5-5"} autoFocus />
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
              <span className="text-sm font-semibold text-accent-text">{effortName(shownEffort)}</span>
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
      {simple && (
        <section className="rounded-xl border border-accent bg-accent-soft p-3 text-sm">
          <div className="font-medium">{isAuto ? "Automatic (recommended)" : `Custom: ${form.model ? prettyModel(form.model) : "your own settings"}`}</div>
          <p className="mt-0.5 text-muted">
            {isAuto ? `Warren lets ${hLabel} pick the model and effort. That's right for most people.` : `You chose the model or effort yourself. Automatic lets ${hLabel} pick for you.`}
          </p>
          {!isAuto && (
            <Button className="mt-2" onClick={() => (setForm({ model: "", effort: "", fast: false }), setCustom(false))}>
              Back to automatic
            </Button>
          )}
        </section>
      )}
      {/* in Simple the controls are folded, so why there are no models to pick sits by the Automatic card */}
      {simple && !deviceGone && why && <p className="max-w-sm rounded-lg bg-hover px-3 py-2 text-xs text-muted">{why}</p>}
      {simple && deviceGone ? (
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
        <Advanced title="Choose the model yourself">{controls}</Advanced>
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
            ? `The device that runs ${harnessLabel(agent.harness)} for @${agent.handle} whenever it's mentioned. It works in ~/.warren/agents/${agent.handle}/ there (or in the folder it shares with its VM). Where it clicks and types is its Computer.`
            : `Optional: ${harnessLabel(agent.harness)} can also join through warren-mcp from wherever it runs (see Connect).`}
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
  if (access === "edit") return `${name} may change files in its own working folder on ${device} (~/.warren/agents/${handle}) and asks before changing files elsewhere. Some harnesses can't enforce this strictly.`;
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
            The agent can run any command as the device's user. The device must opt in with <code>warren node start --allow-full-access</code>; otherwise it runs with edit access.
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

function OverviewPanel({ agent, nodes, active }: { agent: FullAgent; nodes: NodeInfo[]; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const computers = useStore((s) => s.computers);
  const teams = useTeams();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [soul, setSoul] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: agent.name });
  const myTeams = teams.filter((t) => t.members.some((m) => m.agentId === agent.id));
  const bossOf = teams.filter((t) => t.reportsTo === agent.id);
  const device = nodes.find((n) => n.id === agent.nodeId);
  const soulHtml = useMemo(() => (soul ? renderMarkdown(soul.slice(0, 1500), { stripFrontmatter: true }) : ""), [soul]);
  const simple = useSimple();

  useEffect(() => {
    if (!active) return;
    api<RunRow[]>("GET", `/api/agents/${agent.id}/runs?limit=5`).then(setRuns, () => setRuns([]));
    api<{ content: string }>("GET", `/api/vault/note?path=${encodeURIComponent(soulPath(agent.id))}`).then(
      (n) => setSoul(n.content.replace(/^---[\s\S]*?---\s*/, "").replace(/^#.*\n+/, "").trim()),
      () => setSoul(""),
    );
  }, [active, agent.id]);

  const saveProfile = async () => {
    await api("PATCH", `/api/agents/${agent.id}`, { name: form.name });
    await refreshAgents();
    setEditing(false);
  };

  const computer = computers.find((c) => c.id === agent.computerId);
  type Card = { label: string; value: ReactNode; to: AgentTab };
  const modelCard: Card = { label: "Model", value: agent.model ?? "Harness default", to: "model" };
  const deviceCard: Card = { label: "Device", value: device ? `${device.name} · ${device.online ? "online" : "offline"}` : "None", to: "device" };
  const computerCard: Card = { label: "Computer", value: computer ? `${computer.name} · ${computerKindLabel(computer, nodes)}` : agent.settings.headless ? "Headless" : <span className="text-warn">None yet</span>, to: "computer" };
  const accessCard: Card = { label: "Access", value: ACCESS[agent.settings.access ?? "edit"].label, to: "permissions" };
  // Simple leads with where it runs; the model and access settings fold under "Technical details".
  const cards: Card[] = simple ? [deviceCard, computerCard] : [modelCard, deviceCard, computerCard, accessCard];
  const technicalCards: Card[] = [modelCard, { label: "Harness", value: harnessLabel(agent.harness), to: "device" }, accessCard];
  const devices = useDevices();
  const readiness = agentReadiness(agent, devices);
  const next = simple ? setupNextStep(agent, devices) : null;
  const cardGrid = (list: Card[]) => (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      {list.map((c) => (
        <a key={c.label} href={`#/agents/${agent.id}/${c.to}`} className="rounded-xl border border-line p-3 hover:bg-hover">
          <div className="text-xs text-muted">{c.label}</div>
          <div className="mt-0.5 text-sm font-medium truncate">{c.value}</div>
        </a>
      ))}
    </section>
  );

  return (
    <div className="space-y-8 max-w-3xl">
      <section className="flex items-start gap-4">
        <a href={`#/agents/${agent.id}/look`} title="Change its look" className="rounded-xl p-1 -m-1 hover:bg-hover transition-colors">
          <AgentAvatar agent={agent} size={80} live />
        </a>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="grid sm:grid-cols-2 gap-3 max-w-lg">
              <Field label="Display name" hint={`Mentions stay @${agent.handle}.`}>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button variant="primary" onClick={saveProfile}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => (setEditing(false), setForm({ name: agent.name }))}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                {agent.name}
                <button onClick={() => setEditing(true)} className="p-1 rounded-md text-muted hover:text-ink hover:bg-hover" aria-label="Edit profile" title="Edit profile">
                  <Pencil size={15} />
                </button>
              </h2>
              <p className="text-sm text-muted flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                <span>
                  @{agent.handle} · {harnessLabel(agent.harness)}
                </span>
                <StatusChip status={agent.status} />
              </p>
              <p className="text-sm text-muted mt-2">
                {myTeams.length || bossOf.length ? (
                  <>
                    {myTeams.map((t, i) => {
                      const role = t.leads.includes(agent.id) ? "lead" : t.members.find((m) => m.agentId === agent.id)?.role;
                      return (
                        <span key={t.id}>
                          {i > 0 && ", "}
                          {role ? `${role} on ` : "on "}
                          <a className="text-accent-text hover:underline" href={href({ view: "chat", channelId: t.channelId, threadId: null })}>
                            #{t.name}
                          </a>
                        </span>
                      );
                    })}
                    {bossOf.length > 0 && (
                      <span>
                        {myTeams.length ? "; " : ""}boss of{" "}
                        {bossOf.map((t, i) => (
                          <span key={t.id}>
                            {i > 0 && ", "}
                            <a className="text-accent-text hover:underline" href={href({ view: "chat", channelId: t.channelId, threadId: null })}>
                              #{t.name}
                            </a>
                          </span>
                        ))}
                      </span>
                    )}
                  </>
                ) : (
                  "Works on its own."
                )}
              </p>
            </>
          )}
        </div>
      </section>

      {problem(runs) && (
        <section role="alert" className="rounded-xl border border-warn/40 bg-warn/10 p-4 flex items-start gap-3">
          <ShieldAlert size={18} className="text-warn shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium">{agent.name} can't work right now</div>
            <div className="text-muted mt-0.5">{problem(runs)}</div>
          </div>
        </section>
      )}

      {simple && (
        <section className="rounded-xl border border-line p-4 space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Status</span>
            <StatusChip status={agent.status} />
            {!readiness.ready && <Pill>Setup incomplete</Pill>}
          </div>
          {!readiness.ready && (
            <p className="text-muted">
              {readiness.problem}. Messages to {agent.name} will wait until that's fixed.
              {next && (
                <span className="mt-1 block">
                  What to do: {next.text}{" "}
                  <a href={next.href} className="text-accent-text underline">
                    {next.action}
                  </a>
                </span>
              )}
            </p>
          )}
          <Button onClick={() => void openDm(agent.id)}>
            <MessageSquare size={15} /> Send a test message
          </Button>
        </section>
      )}

      {cardGrid(cards)}
      {simple && <Advanced title="Technical details">{cardGrid(technicalCards)}</Advanced>}

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Personality</h3>
          <a className="text-sm text-accent-text hover:underline" href={`#/agents/${agent.id}/soul`}>
            Edit
          </a>
        </div>
        {soulHtml ? (
          <div className="prose-w rounded-xl border border-line p-4 text-sm text-muted max-h-48 overflow-hidden" dangerouslySetInnerHTML={{ __html: soulHtml }} />
        ) : (
          <div className="rounded-xl border border-line p-4 text-sm text-muted">{soul === null ? "Loading…" : "No personality yet. Give it one on the Personality page."}</div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Recent activity</h3>
          <a className="text-sm text-accent-text hover:underline" href={`#/agents/${agent.id}/runs`}>
            All activity
          </a>
        </div>
        <RunList runs={runs} compact />
      </section>

      <section className="pt-6 border-t border-line space-y-2">
        <h3 className="font-semibold text-bad">Remove agent</h3>
        <p className="text-sm text-muted">Removes @{agent.handle} from the workspace. Its memory notes and personality stay in the vault.</p>
        <Button
          variant="danger"
          onClick={async () => {
            if (!confirm(`Remove @${agent.handle}? Its memory notes stay in the vault.`)) return;
            await api("DELETE", `/api/agents/${agent.id}`);
            await refreshAgents();
            go({ view: "agents", agentId: null });
          }}
        >
          <Trash2 size={15} /> Remove @{agent.handle}
        </Button>
      </section>
    </div>
  );
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
    <div className="rounded-xl border border-line divide-y divide-line">
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
              ? `When someone @mentions @${agent.handle}, ${device.name} starts ${harnessLabel(agent.harness)}, gives it the warren tools, and posts the reply.`
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
    </div>
  );
}
