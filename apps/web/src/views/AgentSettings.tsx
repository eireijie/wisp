import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, GitCommitHorizontal, ShieldAlert, X } from "lucide-react";
import { HARNESSES, VM_HARNESSES, runsInVm, type AccessLevel, type Agent, type HarnessCatalog } from "@bubble-ai/core";
import { HarnessLogo } from "../components/HarnessLogo.tsx";
import { soulPath, soulTemplate } from "@bubble-ai/core/src/soul.ts";
import { ConnectionInstructions } from "../components/ConnectionInstructions.tsx";
import { useAccess } from "../access.ts";
import { connectorBlocker, connectorOrigin } from "../components/Access.tsx";
import { ApiError, api } from "../api.ts";
import { useStore, useTeams } from "../store.ts";
import { closePopup, go, guardLeaving, href, mayLeave, type AgentTab } from "../router.ts";
import { effortName, prettyModel } from "../components/EffortSlider.tsx";
import { SaveBar } from "./SettingsParts.tsx";
import { useFeatures } from "../features.ts";
import { AccessPanel, CARD, CanUse, HandleLine, InPlace, Knows, Line, RemoveConfirm, SELECT, TAB_TITLES, Toggle } from "./AgentSections.tsx";
import { AgentWatches } from "./AgentWatches.tsx";
import { Button, CopyBlock, Field, harnessLabel, Input, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { RoutinesPanel, runsOnDevice, type RoutineDraft } from "./AgentComputer.tsx";
import { RunsOn } from "./AgentRunsOn.tsx";
import { BackgroundPanel } from "./AgentBackground.tsx";
import { agentReadiness, isSharedComputer, useDevices, type DeviceInfo } from "../devices.ts";
import { useComputerMode } from "../computerMode.ts";
import { setupNextStep } from "../components/AgentPanel.tsx";
import { BackgroundTab, LibraryTab, MemoryTab, MoreTab, PART_PARENT, RecentRuns, RolePart, VoiceTab, WatchSomething, profilePlace } from "./AgentProfile.tsx";
import { BubbleLook, ComputerStage, EditAgent, ShortProfile } from "./AgentShort.tsx";

export type NodeInfo = DeviceInfo;

type FullAgent = Agent & { instructions?: string };

export { runStatusLabel, runTitle, tookFor } from "./AgentProfile.tsx";

/**
 * One agent's profile (round 11, board 12): on desktops a panel beside the chat with X, on phones a
 * page with Back. No part: the short list (ShortProfile). Edit, Bubble and Computer are pages of
 * their own with their own top bars; every other part opens under a back arrow to where it came
 * from. Parts you type in stay mounted, so a draft survives looking elsewhere.
 */
export function AgentDetail({ agent, nodes, tab }: { agent: FullAgent; nodes: NodeInfo[]; tab: AgentTab | null }) {
  const features = useFeatures();
  // a part for a mod that's off isn't there; its old address lands on the profile
  const offTabs: AgentTab[] = [...(features.routines ? [] : ["routines" as const]), ...(features.background ? [] : ["background" as const])];
  const active = tab && offTabs.includes(tab) ? "overview" : (tab ?? "overview");
  const part = profilePlace(active).part;
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
      // Parts stay mounted, so moving between them keeps all edits.
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

  const devices = useDevices();
  const readiness = agentReadiness(agent, devices);
  const next = setupNextStep(agent, devices);
  // a fix that lives in the profile is the Computer part right there
  const fixHere = !!next && next.href.startsWith(`#/agents/${agent.id}/`);

  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [part]);

  const to = (t: AgentTab) => href({ view: "agents", agentId: agent.id, tab: t });
  const [routineStart, setRoutineStart] = useState<RoutineDraft | null>(null);
  // Edit, Bubble and the computer bring their own top bars
  const ownBar = !part || part === "settings" || part === "look" || part === "screen";
  const back = to((part && PART_PARENT[part]) || "overview");
  const partTitle = part === "notes" ? "Memory" : part === "library" ? "Library" : part === "more" ? "All settings" : part ? TAB_TITLES[part] : "";
  const close = (
    <button type="button" onClick={closePopup} className="gl r11-circle size-9!" aria-label="Close profile" title="Close (Esc)">
      <X size={16} strokeWidth={2} />
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!ownBar && (
        <header className="r11-page relative z-10 flex h-14 shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)]">
          <a href={back} className="gl r11-circle size-9!" aria-label="Back">
            <ChevronLeft size={19} />
          </a>
          <h2 className="pointer-events-none absolute inset-x-14 truncate text-center text-[15px] font-semibold">{partTitle}</h2>
          <span className="ml-auto max-md:hidden">{close}</span>
        </header>
      )}
      <div ref={content} className={cx("flex min-h-0 flex-1 flex-col overflow-y-auto", part === "screen" ? "bg-black" : "r11-page")}>
        {!part && <ShortProfile agent={agent} />}
        {part === "settings" && <EditAgent agent={agent} />}
        {part === "screen" && <ComputerStage agent={agent} />}
        <Panel show={part === "look"}>
          <BubbleLook agent={agent} onDirty={markDirty("look")} active={part === "look"} />
        </Panel>
        <div className={cx(!ownBar ? "px-3.5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]" : "hidden")}>
          <div className="mx-auto max-w-[680px] space-y-4">
            {part === "notes" && <MemoryTab agent={agent} />}
            {part === "wallpaper" && <BackgroundTab agent={agent} />}
            {part === "more" && <MoreTab agent={agent} />}
            {part === "voice" && <VoiceTab agent={agent} />}
            {part === "library" && <LibraryTab agent={agent} />}
            {part === "runs" && <RecentRuns agent={agent} />}
            {part === "role" && <RolePart agent={agent} />}
            {(part === "model" || part === "harness" || part === "effort") && <ThinksWith agent={agent} nodes={nodes} />}
            {(part === "device" || part === "computer") && <RunsOn agent={agent} nodes={nodes} problem={readiness.ready ? null : (readiness.problem ?? "Setup incomplete")} fix={fixHere ? null : next} />}
            {(part === "apps" || part === "skills") && <CanUse agent={agent} />}
            {part === "permissions" && <AsksFirst agent={agent} nodes={nodes} />}
            {part === "memory" && <Knows agent={agent} />}
            {part === "access" && (
              <>
                <AccessPanel agent={agent} device={nodes.find((n) => n.id === agent.nodeId)} />
                <NameAndTeams agent={agent} />
              </>
            )}
            {part === "watches" && (
              <>
                <AgentWatches agent={agent} bare />
                <WatchSomething agent={agent} />
                {features.background && (
                  <div className={CARD}>
                    <Line label="Background checks" to={to("background")} />
                  </div>
                )}
              </>
            )}
            {part === "connect" && <ConnectPanel agent={agent} />}
            <Panel show={part === "soul"}>
              <SoulPanel agent={agent} onDirty={markDirty("soul")} active={part === "soul"} />
            </Panel>
            <Panel show={part === "instructions"}>
              <InstructionsPanel agent={agent} onDirty={markDirty("instructions")} active={part === "instructions"} />
            </Panel>
            <Panel show={part === "background"}>
              <BackgroundPanel agent={agent} active={part === "background"} onDirty={markDirty("background")} />
            </Panel>
            <Panel show={part === "routines"}>
              <RoutinesPanel agent={agent} active={part === "routines"} start={part === "routines" ? routineStart : null} onStarted={() => setRoutineStart(null)} />
            </Panel>
          </div>
        </div>
        {active === "remove" && <RemoveConfirm agent={agent} onClose={() => go({ view: "agents", agentId: agent.id, tab: "more" })} />}
      </div>
    </div>
  );
}

/** A part that stays mounted while it is out of sight, so what was typed in it is kept; it slides in when shown. */
function Panel({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div hidden={!show} className="m-panel">
      {children}
    </div>
  );
}

/** Its @handle (how people message it) and the teams it is on, under Who can message. */
function NameAndTeams({ agent }: { agent: Agent }) {
  const teams = useTeams();
  const onTeams = teams.filter((t) => t.members.some((m) => m.agentId === agent.id)).map((t) => t.name);
  return (
    <div className={CARD}>
      <HandleLine agent={agent} />
      {onTeams.length > 0 && <Line label="Teams" value={onTeams.join(", ")} />}
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

/** Its personality (SOUL.md), as text. Whether it may rewrite it itself is a switch under Permissions. */
function SoulPanel({ agent, onDirty, active }: { agent: FullAgent; onDirty: (d: boolean) => void; active: boolean }) {
  const path = soulPath(agent.id);
  const [saved, setSaved] = useState<string | null>(null); // null = no soul yet
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [last, setLast] = useState<Commit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // pick up the agent's own edits when coming back to it
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

  const editedByAgent = last?.author === `@${agent.handle}`;

  return (
    <div>
      {!loaded ? (
        <p className="px-1 text-[13px] text-muted">Loading…</p>
      ) : saved === null && !draft ? (
        <div className="space-y-3">
          <p className="px-1 text-[14px] text-muted">Not written yet</p>
          <Button onClick={() => setDraft(soulTemplate(agent.name, agent.handle))}>Start from a template</Button>
        </div>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck
          aria-label="SOUL.md"
          className="min-h-[420px] w-full resize-y rounded-[12px] border border-line bg-bg px-4 py-3 font-mono text-[13.5px] leading-relaxed outline-none focus:border-ink/40"
        />
      )}
      {last && (
        <p className="mt-2 flex items-center gap-1.5 px-1 text-[13px] text-muted">
          <GitCommitHorizontal size={14} />
          {editedByAgent ? `Refined by @${agent.handle}` : `Edited by ${last.author}`} {timeAgo(last.date)} ·{" "}
          <a className="text-ink underline underline-offset-2" href={`#/vault/${path}`}>
            history
          </a>
        </p>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setDraft(saved ?? "")} active={active} />
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

/** The most instructions the hub keeps; the count shows once most of it is used. */
const INSTRUCTIONS_MAX = 20_000;

/** Its job in full: what the role covers, and the instructions sent with every request. The one-line role is the line under its name. */
function InstructionsPanel({ agent, onDirty, active }: { agent: FullAgent; onDirty: (d: boolean) => void; active: boolean }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const others = useStore((s) => s.agents).filter((a) => a.id !== agent.id);
  const saved = agent.instructions ?? "";
  const savedNotes = agent.settings.roleNotes ?? "";
  const [form, setForm] = useSavedDraft({ draft: saved, roleNotes: savedNotes });
  const { draft, roleNotes } = form;
  const setDraft = (value: string | ((d: string) => string)) => setForm((f) => ({ ...f, draft: typeof value === "function" ? value(f.draft) : value }));
  const setRoleNotes = (value: string) => setForm((f) => ({ ...f, roleNotes: value }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notesDirty = roleNotes !== savedNotes;
  const dirty = draft !== saved || notesDirty;
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
      await api("PATCH", `/api/agents/${agent.id}`, { instructions: draft, ...(notesDirty ? { settings: { roleNotes } } : {}) });
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
      <div className="mb-4">
        <Field label="What the role covers">
          <Input value={roleNotes} onChange={(e) => setRoleNotes(e.target.value)} maxLength={2000} placeholder="Owns the backend and the build; send it bugs and API work." aria-label="What the role covers" />
        </Field>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {snippets.map((s) => (
          <button key={s.label} onClick={() => setDraft((d) => (d.trim() ? d.replace(/\s*$/, "\n\n") : "") + s.text + "\n")} className="text-xs rounded-[8px] border border-line px-2.5 py-1 hover:bg-hover">
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
      {draft.length > INSTRUCTIONS_MAX * 0.8 && (
        <div className="mt-1 text-xs text-faint text-right">
          {draft.length.toLocaleString()} / {INSTRUCTIONS_MAX.toLocaleString()}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => (setDraft(saved), setRoleNotes(savedNotes))} active={active} />
    </div>
  );
}

// --- Model, harness and effort --------------------------------------------------------------

/**
 * The harnesses an agent can switch to: the ones installed where it runs (its device, or the computer it
 * runs inside), and the one it has now. Agents that join from outside keep theirs.
 */
export function harnessChoices(agent: Pick<Agent, "harness" | "computerId" | "settings">, device: Pick<DeviceInfo, "harnesses" | "vmSignIns"> | undefined): string[] {
  const inVm = runsInVm(agent.harness) && agent.settings.runIn === "computer" && !!agent.computerId;
  const vm = inVm ? Object.keys(device?.vmSignIns?.[agent.computerId!] ?? {}) : [];
  const here = inVm ? (vm.length ? vm : VM_HARNESSES) : (device?.harnesses ?? []).map((h) => h.id);
  const list = [...new Set([agent.harness, ...here])].filter((id) => id === agent.harness || runsOnDevice(id));
  // the order Bubble AI lists them in everywhere, then any a device declared itself
  const order = HARNESSES.map((h) => h.id);
  return list.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

/**
 * Model, Harness, Effort as rows (switch the harness here, as /harness does in chat), and Fast when
 * the model has it. Each saves as it changes. A model that isn't on the list is
 * typed in ("Other model…").
 */
function ThinksWith({ agent, nodes }: { agent: FullAgent; nodes: NodeInfo[] }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const device = nodes.find((n) => n.id === agent.nodeId);
  const choices = harnessChoices(agent, device);
  const [info, setInfo] = useState<{ device: { name: string; online: boolean } | null; catalog: HarnessCatalog | null } | null>(null);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hLabel = harnessLabel(agent.harness);
  const headless = runsOnDevice(agent.harness);

  useEffect(() => {
    if (headless) api<NonNullable<typeof info>>("GET", `/api/agents/${agent.id}/models`).then(setInfo, () => setInfo({ device: null, catalog: null }));
  }, [agent.id, agent.nodeId, headless]);

  const models = info?.catalog?.models ?? [];
  const model = agent.model ?? "";
  // a model id the catalog doesn't know about is shown as a custom model
  useEffect(() => {
    if (info && model && !models.some((m) => m.id === model)) setCustom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, model]);

  if (!headless)
    return (
      <div className={CARD}>
        <Line label="Harness" value={hLabel} />
        <Line label="Model" value={`Set in ${hLabel}`} />
      </div>
    );

  // with no model picked the harness uses its own default, which has the efforts and fast tier too
  const offered = (id: string) => {
    const m = models.find((x) => x.id === (id || info?.catalog?.defaultModel));
    return { model: m, efforts: m?.efforts ?? info?.catalog?.efforts ?? ["low", "medium", "high"] };
  };
  const { model: selected, efforts } = offered(model);
  const fallback = info?.catalog?.defaultModel ? models.find((x) => x.id === info.catalog?.defaultModel) : undefined;
  const defaultName = fallback ? prettyModel(fallback.label) : (info?.catalog?.defaultModel ?? null);
  const effort = agent.settings.effort ?? "";
  const effortDropped = !!effort && !efforts.includes(effort);
  // the device's configured effort wins over the model's own default, as in Codex
  const defaultEffort = [info?.catalog?.defaultEffort, selected?.defaultEffort].find((e) => e && efforts.includes(e)) ?? efforts[0];

  const patch = async (body: unknown) => {
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, body);
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  // a new AI starts on its own default model and effort; its memory, skills and chats stay
  const setHarness = (id: string) => {
    if (id === agent.harness) return;
    setCustom(false);
    void patch({ harness: id, model: null, settings: { effort: null, fast: false } }).catch(() => {});
  };
  // an effort the new model doesn't offer goes back to the default with it
  const setModel = (id: string) => patch({ model: id.trim() || null, ...(effort && !offered(id.trim()).efforts.includes(effort) ? { settings: { effort: null } } : {}) });

  // why there are no models to pick, for whoever hovers the picker
  const why = !agent.nodeId
    ? "No device yet"
    : !info?.device
      ? null
      : !info.catalog
        ? info.device.online
          ? `${info.device.name} hasn't reported ${hLabel} models`
          : `${info.device.name} is offline`
        : null;

  return (
    <>
      <div className={CARD}>
        <Line label="Model">
          <select
            aria-label="Model"
            title={why ?? undefined}
            value={custom ? "__custom" : model}
            onChange={(e) => {
              if (e.target.value === "__custom") return setCustom(true);
              setCustom(false);
              void setModel(e.target.value).catch(() => {});
            }}
            className={SELECT}
          >
            {/* what Automatic runs right now, so this says the same as the chat's header */}
            <option value="">{defaultName ? `Automatic (${defaultName})` : "Automatic"}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {prettyModel(m.label)}
              </option>
            ))}
            <option value="__custom">Other model…</option>
          </select>
        </Line>
        {custom && (
          <Line label="Model id">
            <InPlace look="bare" value={model} onSave={setModel} label="Model id" placeholder={agent.harness === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"} className="h-8 w-48 border border-line bg-panel text-[13px] text-ink" />
          </Line>
        )}
        <Line label="Harness">
          <HarnessLogo harness={agent.harness} size={16} />
          <select aria-label="Harness" value={agent.harness} onChange={(e) => setHarness(e.target.value)} disabled={choices.length < 2} title={choices.length < 2 ? "Nothing else is installed where it runs" : undefined} className={SELECT}>
            {choices.map((id) => (
              <option key={id} value={id}>
                {harnessLabel(id)}
              </option>
            ))}
          </select>
        </Line>
        {efforts.length > 0 && (
          <Line label="Effort">
            <select aria-label="Reasoning effort" value={effortDropped ? "" : effort} onChange={(e) => void patch({ settings: { effort: e.target.value || null } }).catch(() => {})} className={SELECT}>
              <option value="">Default ({effortName(defaultEffort)})</option>
              {efforts.map((x) => (
                <option key={x} value={x}>
                  {effortName(x)}
                </option>
              ))}
            </select>
          </Line>
        )}
        {selected?.fast && (
          <Line label="Fast">
            {selected.fast.description && <span className="truncate">{selected.fast.description}</span>}
            <Toggle label="Fast mode" on={!!agent.settings.fast} onChange={(v) => void patch({ settings: { fast: v } }).catch(() => {})} />
          </Line>
        )}
      </div>
      {effortDropped && (
        <p className="px-1 text-[13px] text-st-needs">
          {selected?.label ?? "This model"} doesn't support “{effort}”; it uses its default.
        </p>
      )}
      {error && <p className="px-1 text-[13px] text-bad">{error}</p>}
    </>
  );
}

// --- Permissions ---------------------------------------------------------------

const ACCESS: Record<AccessLevel, string> = { "read-only": "Read only", edit: "Can edit files", full: "Full access" };

/** Where an agent's files are, for the access text: the shared computer, its own, or a device's folder. */
export interface AccessPlace {
  /** the device its AI runs on */
  device?: string;
  /** the computer it works on: the shared one, its own, or none (it works in a folder on the device) */
  computer: "shared" | "own" | null;
  handle: string;
  advanced: boolean;
}

/**
 * The effective reach of an access level, plainly (edit = the harness's workspace sandbox: its own
 * folder). An agent with a computer works in that computer's files (on the shared one, a folder of
 * its own in them); without one, in a folder on its device. Paths and caveats are for Advanced.
 */
export function accessScope(access: AccessLevel, name: string, p: AccessPlace): string {
  if (!p.device) return "It has no device yet, so it can't touch any files.";
  const folder = p.computer === "shared" ? "its own folder on the shared computer" : p.computer === "own" ? "its computer's files" : `its own folder on ${p.device}`;
  const path = p.computer === "shared" ? `~/files/${p.handle}` : p.computer === "own" ? "~/files" : `~/.bubble-ai/agents/${p.handle}`;
  if (access === "read-only") return `${name} reads files and asks before changing any.`;
  if (access === "edit") return `${name} can change files in ${folder}, and asks before changing anything else.${p.advanced ? ` (${path}; some AI tools can't hold to this strictly.)` : ""}`;
  return `${name} can change any file and run any command on ${p.device}, where its AI runs, if ${p.device} allows full access. If it doesn't, ${name} can edit files only.`;
}

/** Harnesses Bubble AI can keep the person's own plugins out of. */
const OWN_PLUGINS_HARNESSES = ["codex", "claude-code", "gemini"];

/**
 * What it may do without asking: its level for files and commands, and whether it may rewrite its
 * own personality. Each saves as it changes, and so does using the person's own plugins (which skip
 * Bubble AI's approvals); the level's reach in full is the picker's tooltip.
 */
function AsksFirst({ agent, nodes }: { agent: FullAgent; nodes: NodeInfo[] }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const computer = useStore((s) => s.computers).find((c) => c.id === agent.computerId);
  const { advanced } = useComputerMode();
  const place: AccessPlace = {
    device: nodes.find((n) => n.id === agent.nodeId)?.name,
    computer: isSharedComputer(computer) ? "shared" : computer?.kind === "vm" ? "own" : null,
    handle: agent.handle,
    advanced,
  };
  const access = agent.settings.access ?? "edit";
  const ownPlugins = !!agent.settings.ownPlugins;
  const canOwnPlugins = OWN_PLUGINS_HARNESSES.includes(agent.harness);
  const [error, setError] = useState<string | null>(null);

  const patch = async (settings: { access?: AccessLevel; ownPlugins?: boolean; soulLocked?: boolean }) => {
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className={CARD}>
        <Line label="Files and commands">
          <select aria-label="Files and commands" title={accessScope(access, agent.name, place)} value={access} onChange={(e) => void patch({ access: e.target.value as AccessLevel })} className={SELECT}>
            {(Object.keys(ACCESS) as AccessLevel[]).map((a) => (
              <option key={a} value={a}>
                {ACCESS[a]}
              </option>
            ))}
          </select>
        </Line>
        <Line label="Edits its personality">
          <Toggle label={`Let @${agent.handle} refine its own personality`} on={!agent.settings.soulLocked} onChange={(v) => void patch({ soulLocked: !v })} />
        </Line>
        <Line label="Approvals" value="For all agents" to={href({ view: "settings", page: "agents" })} />
        {canOwnPlugins && (
          <Line label={`My own ${harnessLabel(agent.harness)} plugins`}>
            <Toggle label={`Use my own ${harnessLabel(agent.harness)} plugins`} on={ownPlugins} onChange={(v) => void patch({ ownPlugins: v })} />
          </Line>
        )}
        <Line label="Edits its instructions" value="Only people" />
      </div>
      {access === "full" && (
        <p className="flex gap-2 px-1 text-[13px] text-bad">
          <ShieldAlert size={15} className="shrink-0 mt-0.5" />
          {advanced ? (
            <span>
              It can run any command as {place.device ?? "the device"}'s user. The device must opt in with <code>bubble-ai node start --allow-full-access</code>; otherwise it runs with edit access.
            </span>
          ) : (
            <span>Only for an agent you trust: it can change anything{place.device ? ` on ${place.device}` : ""}.</span>
          )}
        </p>
      )}
      {canOwnPlugins && ownPlugins && (
        <p className="flex gap-2 px-1 text-[13px] text-bad">
          <ShieldAlert size={15} className="shrink-0 mt-0.5" />
          These skip Bubble AI's approvals and the screen switch.
        </p>
      )}
      {error && <p className="px-1 text-[13px] text-bad">{error}</p>}
    </>
  );
}

// --- Connect ------------------------------------------------------------------

/** Another app as this agent: a token for a session that is already running, the address for apps that connect by URL, and the apps connected so far. */
function ConnectPanel({ agent }: { agent: FullAgent }) {
  const [token, setToken] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <section className="space-y-2.5">
        <h3 className="px-1 text-[13px] font-semibold text-muted">From an app that's already open</h3>
        {token ? (
          <ConnectionInstructions token={token} harness={agent.harness} />
        ) : (
          <Button onClick={async () => setToken((await api<{ token: string }>("POST", `/api/agents/${agent.id}/token`)).token)}>Get a sign-in key</Button>
        )}
      </section>
      <RemoteMcp agent={agent} />
    </div>
  );
}

/** The hub's remote MCP address, for Grok, ChatGPT and Claude connectors, and the apps connected as this agent. */
function RemoteMcp({ agent }: { agent: FullAgent }) {
  const info = useAccess();
  // a private address (Tailscale without its public door, or home Wi-Fi) is never offered: the apps' servers can't reach it
  const origin = connectorOrigin(info);
  const [apps, setApps] = useState<{ id: string; name: string; approvedBy: string | null; lastUsed: string | null; createdAt: string }[]>([]);
  const load = useCallback(() => {
    api<typeof apps>("GET", `/api/agents/${agent.id}/apps`).then(setApps, () => {});
  }, [agent.id]);
  useEffect(load, [load]);
  return (
    <section className="space-y-2.5">
      <h3 className="px-1 text-[13px] font-semibold text-muted">From an app that connects by link</h3>
      {origin ? (
        <CopyBlock text={`${origin}/mcp`} />
      ) : (
        <p className="px-1 text-[13px] text-muted">
          {connectorBlocker(info)}{" "}
          <a className="text-ink underline underline-offset-2" href={href({ view: "settings", page: "devices" })}>
            Turn it on
          </a>
        </p>
      )}
      {apps.length > 0 && (
        <ul className={CARD}>
          {apps.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3.5 py-2 text-sm">
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
