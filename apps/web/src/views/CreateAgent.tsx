import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Check, ChevronRight, Cloud, Download, Laptop, Loader2, Lock, Monitor, Plus, Search, Shuffle, UserPlus, X } from "lucide-react";
import { GHOST_WHITE, randomAppearance, type GhostAppearance } from "@wisp/core/src/appearance.ts";
import { Ghost } from "../components/Ghost.tsx";
import { GhostColors } from "../components/GhostColors.tsx";
import { HarnessLogo } from "../components/HarnessLogo.tsx";
import { ConnectionInstructions } from "../components/ConnectionInstructions.tsx";
import { prettyModel } from "../components/EffortSlider.tsx";
import { HARNESSES, runsInVm, type Agent, type Connector, type DiscoveredAgent, type Skill } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go } from "../router.ts";
import type { NodeInfo } from "./AgentSettings.tsx";
import { computerKindLabel, usableDevices } from "../devices.ts";
import { defaultComputer, resolveComputer, vmOnDevice, withComputer, type ComputerChoice } from "../agentComputer.ts";
import { Advanced, useSimple } from "../experience.tsx";
import { useFeature } from "../features.ts";
import { LookEditorScreen } from "./LookEditor.tsx";
import { Button, Field, harnessLabel, Input, Modal, Pill, Textarea, cx } from "../components/ui.tsx";

export function ComputerPicker({
  value,
  onChange,
  node,
  nodes,
}: {
  value: ComputerChoice;
  onChange: (c: ComputerChoice) => void;
  node: NodeInfo | undefined;
  nodes: NodeInfo[];
}) {
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const simple = useSimple();
  const screenExists = computers.some(
    (c) => c.kind === "device" && c.nodeId === node?.id,
  );
  const opt = (
    c: ComputerChoice,
    icon: React.ReactNode,
    title: string,
    body: string,
    disabled?: boolean,
  ) => {
    const selected =
      value.kind === c.kind &&
      (c.kind !== "existing" ||
        (value.kind === "existing" && value.id === c.id));
    return (
      <button
        type="button"
        key={c.kind === "existing" ? c.id : c.kind}
        disabled={disabled}
        onClick={() => onChange(c)}
        className={cx(
          "rounded-xl border p-2.5 text-left flex gap-2.5 disabled:opacity-45 disabled:pointer-events-none",
          selected
            ? "border-accent bg-accent-soft"
            : "border-line hover:bg-hover",
        )}
      >
        <span className="size-7 shrink-0 rounded-lg bg-chip grid place-items-center text-muted">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium truncate">{title}</span>
          <span className="block text-[11px] text-muted leading-tight">
            {body}
          </span>
        </span>
      </button>
    );
  };
  return (
    <div>
      {simple ? (
        <div className="text-sm font-medium mb-2">Where should it work?</div>
      ) : (
        <>
          <div className="text-sm font-medium mb-1">Computer</div>
          <p className="text-xs text-muted mb-2">
            Where it works: it opens apps and websites there, and you can watch
            and take over.
          </p>
        </>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        {node &&
          opt(
            { kind: "vm" },
            <Monitor size={15} />,
            simple ? `Its own desktop on ${node.name}` : `New VM on ${node.name}`,
            node.capabilities?.vm.ok
              ? simple
                ? "It opens apps and websites there. Your screen stays yours."
                : "Its own Linux desktop. Doesn't touch your screen."
              : (node.capabilities?.vm.detail ?? "Connect the device to check"),
            !node.capabilities?.vm.ok,
          )}
        {node?.mine &&
          !screenExists &&
          opt(
            { kind: "screen" },
            <Lock size={15} />,
            simple ? "My own screen" : "Your own screen",
            node.capabilities?.screen.off
              ? `Off. Turn it on at ${node.name}: wisp node screen on`
              : node.capabilities?.screen.ok === false
                ? node.capabilities.screen.detail
                : simple
                  ? "Only while you lend it."
                  : "Only while you lend it, and only for things you ask.",
            node.capabilities?.screen.ok !== true,
          )}
        {computers.map((c) =>
          opt(
            { kind: "existing", id: c.id },
            c.kind === "orgo" ? (
              <Cloud size={15} />
            ) : c.kind === "vm" ? (
              <Monitor size={15} />
            ) : (
              <Laptop size={15} />
            ),
            c.name,
            `${computerKindLabel(c, nodes)}${
              c.agents.length
                ? `, shared with ${agents
                    .filter((a) => c.agents.includes(a.id))
                    .map((a) => "@" + a.handle)
                    .join(", ")}`
                : ""
            }`,
          ),
        )}
        {/* the device's job left it without a desktop; in Simple the switch for that is folded away, so show the choice here */}
        {simple &&
          value.kind === "headless" &&
          opt({ kind: "headless" }, <Bot size={15} />, "No desktop (answers only)", "It can chat and use files, but can't open apps or websites.")}
        {opt(
          { kind: "later" },
          <Plus size={15} />,
          simple ? "Decide later" : "Choose later",
          simple ? "You can pick on its Computer tab." : "Pick one on its Computer tab.",
        )}
      </div>
      <Advanced title="More options" className="mt-2">
        <label className="mt-2 flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={value.kind === "headless"}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? { kind: "headless" }
                  : withComputer(defaultComputer(node, computers)),
              )
            }
          />
          Run it headless: no computer, so no apps or websites
        </label>
      </Advanced>
    </div>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);

type HarnessChoice = { id: string; label: string; blurb?: string; account?: string; signup?: string; protocol?: string };

/** ACP harnesses can't use HTTP MCP connectors (Gmail etc.); native ones can. */
export const canUseConnectedApps = (h: { id: string; protocol?: string }) => h.protocol !== "acp" && !h.id.startsWith("acp:");

function HarnessGrid({ list, harness, onPick, label }: { list: HarnessChoice[]; harness: string; onPick: (id: string) => void; label: string }) {
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label={label}>
      {list.map((h) => (
        <button
          type="button"
          key={h.id}
          aria-pressed={harness === h.id}
          onClick={() => onPick(h.id)}
          className={cx("agent-harness-card", harness === h.id && "selected")}
        >
          {harness === h.id && <Check size={14} className="agent-harness-check" />}
          <HarnessLogo harness={h.id} size={24} />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{h.label}</span>
            {h.blurb && <span className="block text-xs text-muted">{h.blurb}</span>}
            {h.account && <span className="block text-xs text-muted">{h.account}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** What "Use my defaults" means, from GET /api/settings/agent-defaults. */
export interface AgentDefaults {
  harness: string | null;
  model: string | null;
  computer: "own-vm" | "none";
  nodeId: string | null;
}

type View = "form" | "look" | "external" | "discover" | "invitation";
type RespondTo = "me" | "anyone" | "people";

/** "Claude Code · Sonnet 5.5" and "Its own computer on my-mac": the defaults in a line each. */
export function defaultsSummary(d: AgentDefaults, nodes: Pick<NodeInfo, "id" | "name">[]): { ai: string; computer: string } {
  const harness = d.harness ? (harnessLabel(d.harness) ?? d.harness) : "Not picked yet";
  const node = nodes.find((n) => n.id === d.nodeId);
  return {
    ai: `${harness} · ${d.model ? prettyModel(d.model) : "Automatic model"}`,
    computer: d.computer === "own-vm" ? (node ? `Its own computer on ${node.name}` : "Its own computer") : "No computer",
  };
}

/**
 * New agent, on one screen (Buzz style): its ghost on the left (colors, Shuffle, the full look
 * editor), and on the right its name, what it does, a starting role, instructions, and which AI
 * and computer it uses (your defaults, or picked here). Handle, who it answers, apps and skills
 * are under Advanced, open from the start in the Advanced experience. Agents that already run
 * somewhere come in through the link at the bottom.
 */
/** `onCreated`: hand the new agent back (to a team being built, say) instead of opening its page. */
export function CreateAgent({ nodes, onClose, onCreated }: { nodes: NodeInfo[]; onClose: () => void; onCreated?: (agent: Agent) => void }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const people = useStore((s) => s.members);
  const simple = useSimple();
  const inviteOn = useFeature("invite");
  const [view, setView] = useState<View>("form");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    body?.scrollTo({ top: 0 });
    (body?.querySelector<HTMLElement>("input") ?? body?.querySelector<HTMLElement>("h1"))?.focus();
  }, [view]);

  // who it is
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  // every new agent starts white with a face and outfit of its own, picked once (typing its name doesn't change it)
  const [appearance, setAppearance] = useState<GhostAppearance>(() => ({ ...randomAppearance(), ...GHOST_WHITE }));

  // which AI and computer
  const [defaults, setDefaults] = useState<AgentDefaults | null | "error">(null);
  const [mode, setMode] = useState<"defaults" | "custom">("defaults");
  const [harness, setHarness] = useState("claude-code");
  const [model, setModel] = useState("");
  const usable = usableDevices(nodes);
  const [nodeId, setNodeId] = useState(usable.find((n) => n.online)?.id ?? usable[0]?.id ?? "");
  const [computer, setComputer] = useState<ComputerChoice>(() => defaultComputer(nodes.find((n) => n.id === nodeId), computers));
  const createdVm = useRef<{ id: string; nodeId: string } | null>(null);
  const [invite, setInvite] = useState(false);
  const touched = useRef(false);
  useEffect(() => {
    let live = true;
    api<AgentDefaults>("GET", "/api/settings/agent-defaults").then(
      (d) => {
        if (!live) return;
        setDefaults(d);
        // Customize starts from the defaults, unless you already changed something
        if (touched.current) return;
        if (d.harness) setHarness(d.harness);
        if (d.model) setModel(d.model);
        if (d.nodeId && usable.some((n) => n.id === d.nodeId)) {
          setNodeId(d.nodeId);
          setComputer(d.computer === "none" ? { kind: "headless" } : defaultComputer(nodes.find((n) => n.id === d.nodeId), computers));
        }
      },
      () => {
        if (!live) return;
        // an older hub has no defaults: pick here instead
        setDefaults("error");
        setMode("custom");
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chooseComputer = (choice: ComputerChoice) => {
    touched.current = true;
    setComputer(choice);
    if (choice.kind === "existing") {
      const c = computers.find((c) => c.id === choice.id);
      if (c?.kind === "vm" && c.nodeId && usable.some((n) => n.id === c.nodeId)) setNodeId(c.nodeId);
    }
  };

  // Advanced: handle, who it answers, apps and skills
  const [advanced, setAdvanced] = useState(!simple);
  const [respondTo, setRespondTo] = useState<RespondTo>("me");
  const [respondPeople, setRespondPeople] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [pickedApps, setPickedApps] = useState<string[]>([]);
  const [pickedSkills, setPickedSkills] = useState<string[]>([]);
  useEffect(() => {
    if (!advanced || connectors) return;
    api<Connector[]>("GET", "/api/connectors").then(setConnectors, () => setConnectors([]));
    api<Skill[]>("GET", "/api/skills").then(setSkills, () => setSkills([]));
  }, [advanced, connectors]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const node = nodes.find((n) => n.id === nodeId);
  const installed = new Set((node?.harnesses ?? []).map((h) => h.id));
  const declared = [...new Map(usable.flatMap((n) => (n.harnesses ?? []).filter((h) => h.id.startsWith("acp:")).map((h) => [h.id, h] as const))).values()];
  const harnesses = [
    ...HARNESSES.filter((h) => h.id !== "custom"),
    ...declared.map((h) => ({ id: h.id, label: h.id.slice(4), protocol: "acp" as const, note: "Available on a connected device", binary: "" })),
    HARNESSES.find((h) => h.id === "custom")!,
  ];
  const useDefaults = mode === "defaults" && !invite && defaults !== null && defaults !== "error";
  const effectiveHarness = useDefaults ? ((defaults as AgentDefaults).harness ?? harness) : harness;
  const selectedHarness = harnesses.find((h) => h.id === effectiveHarness) ?? harnesses[0];
  const external = invite || selectedHarness.protocol === "mcp";

  const cleanName = name.trim();
  const finalHandle = handle || slug(cleanName);
  // every agent has its own colors: the ghost follows its handle until you pick a look
  const look = appearance;
  const invalidHandle = !/^[a-z][a-z0-9-]{0,31}$/.test(finalHandle);
  const taken = agents.some((a) => a.handle === finalHandle);
  const validName = !!cleanName && !invalidHandle && !taken;

  const others = people.filter((p) => p.id !== me?.user.id);
  const togglePick = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const finish = () => {
    if (created && onCreated) return onCreated(created);
    onClose();
    if (created) go({ view: "agents", agentId: created.id, tab: "connect" });
  };

  const submit = async () => {
    if ((!created && !validName) || busy) return;
    setBusy(true);
    setError(null);
    try {
      let a = created;
      if (!a) {
        const settings = {
          appearance,
          ...(role.trim() ? { role: role.trim().slice(0, 60) } : {}),
          ...(inviteOn ? { respondTo, ...(respondTo === "people" ? { respondPeople } : {}) } : {}),
        };
        const common = { name: cleanName, handle: finalHandle, instructions };
        if (useDefaults) {
          a = await api<Agent>("POST", "/api/agents", { ...common, useDefaults: true, settings });
        } else {
          const computerId = external ? null : await resolveComputer(computer, nodeId, cleanName);
          // Keep a newly created computer selected if creating the agent needs a retry.
          if (computerId && (computer.kind === "vm" || computer.kind === "screen")) setComputer({ kind: "existing", id: computerId });
          if (computerId && computer.kind === "vm") createdVm.current = { id: computerId, nodeId };
          const vmHere = vmOnDevice(computer, nodeId, computers) || (createdVm.current?.id === computerId && createdVm.current?.nodeId === nodeId);
          a = await api<Agent>("POST", "/api/agents", {
            ...common,
            harness,
            ...(model.trim() && !external ? { model: model.trim() } : {}),
            nodeId: external ? null : nodeId || null,
            computerId,
            settings: {
              ...settings,
              ...(!external && computer.kind === "headless" ? { headless: true } : {}),
              ...(!external && vmHere && runsInVm(harness) ? { runIn: "computer" as const } : {}),
            },
          });
        }
        setCreated(a);
        // apps and skills picked under Advanced; an app already on for every agent needs nothing
        const agentId = a.id;
        await Promise.all([
          ...pickedApps.flatMap((id) => {
            const c = connectors?.find((x) => x.id === id);
            return c && c.agentIds.length ? [api("PATCH", `/api/connectors/${id}`, { agentIds: [...c.agentIds, agentId] }).catch(() => {})] : [];
          }),
          ...pickedSkills.map((id) => api("PUT", `/api/skills/${id}/agents/${agentId}`).catch(() => {})),
        ]);
      }
      await Promise.all([refreshAgents(), useStore.getState().refreshComputers()]);
      if (external) {
        const r = await api<{ token: string }>("POST", `/api/agents/${a.id}/token`);
        setToken(r.token);
        setError(null);
        setView("invitation");
      } else if (onCreated) {
        onCreated(a);
      } else {
        onClose();
        go({ view: "agents", agentId: a.id, tab: "overview" });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = defaults && defaults !== "error" ? defaultsSummary(defaults, nodes) : null;

  return (
    <Modal title="New agent" label="New agent" onClose={busy ? () => {} : onClose} headerless className="sm:max-w-[920px]!" contentClassName="p-0!">
      <div ref={bodyRef}>
        {view === "form" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-start justify-between gap-4 px-5 sm:px-7 pt-6 pb-1">
              <div>
                <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight">
                  {invite ? "Invite an agent" : "New agent"}
                </h1>
                <p className="text-sm text-muted mt-0.5">{invite ? "Name it and pick the harness it already runs on. You'll get an invitation for its session." : "Give it a name and a job. You can change everything later."}</p>
              </div>
              <button type="button" onClick={onClose} disabled={busy} className="size-9 shrink-0 rounded-xl bg-chip hover:bg-hover grid place-items-center text-muted hover:text-ink" aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className="flex flex-col md:flex-row gap-6 md:gap-7 px-5 sm:px-7 pt-4 pb-6">
              {/* its ghost */}
              <div className="md:w-60 shrink-0 self-stretch md:self-start md:sticky md:top-4 rounded-[1.25rem] bg-bg px-4 py-6 flex flex-col items-center gap-3.5">
                <Ghost look={look} size={140} trackPointer label="Your new agent, looking toward your pointer" />
                <div className="text-center min-w-0 max-w-full">
                  <div className="text-lg font-semibold truncate">{cleanName || "Your agent"}</div>
                  <div className="text-[13px] text-muted truncate">@{finalHandle || "your-agent"}</div>
                </div>
                <GhostColors look={look} onChange={(c) => setAppearance({ ...look, ...c })} limit={5} size={26} disabled={!!created} />
                <div className="flex gap-2">
                  <Button type="button" className="h-8! rounded-full! px-3.5! text-[13px]" disabled={!!created} onClick={() => setAppearance(randomAppearance())} aria-label="Shuffle its look">
                    <Shuffle size={14} /> Shuffle
                  </Button>
                  <Button type="button" variant="primary" className="h-8! rounded-full! px-3.5! text-[13px]" disabled={!!created} onClick={() => setView("look")}>
                    Edit look
                  </Button>
                </div>
              </div>

              {/* the form */}
              <fieldset disabled={busy || !!created} className="flex-1 min-w-0 space-y-5">
                <div className="flex flex-col sm:flex-row gap-3.5">
                  <label className="flex-1 space-y-1.5">
                    <span className="block text-sm font-semibold">Name</span>
                    <Input
                      maxLength={80}
                      value={name}
                      required
                      placeholder="e.g. Nova"
                      className="h-11! text-[15px]!"
                      onChange={(e) => {
                        setName(e.target.value);
                        if (!handleEdited) setHandle(slug(e.target.value));
                      }}
                    />
                  </label>
                  <label className="flex-[1.4] space-y-1.5">
                    <span className="block text-sm font-semibold">
                      What it does <span className="font-normal text-muted">· Optional</span>
                    </span>
                    <Input maxLength={60} value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Builds and ships websites" className="h-11! text-[15px]!" />
                  </label>
                </div>
                {cleanName && invalidHandle && <p className="text-xs text-bad -mt-3">Include a letter from a–z so your agent can have an @handle.</p>}
                {taken && (
                  <p className="text-xs text-bad -mt-3">
                    @{finalHandle} is already taken. Choose another name or{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => {
                        setHandle(freeHandle(cleanName, agents.map((a) => a.handle)));
                        setHandleEdited(true);
                      }}
                    >
                      use an available handle
                    </button>
                    .
                  </p>
                )}

                <label className="block space-y-1.5">
                  <span className="block text-sm font-semibold">Instructions</span>
                  <Textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What is this agent responsible for, and how should it work?" />
                </label>

                {invite ? (
                  <div className="space-y-2.5">
                    <span className="block text-sm font-semibold">Harness it runs on</span>
                    <HarnessGrid list={harnesses} harness={harness} onPick={setHarness} label="Agent harness" />
                    <p className="text-xs text-muted">The invitation gives its session Wisp's chat, tasks, memory and file tools. You can give it a computer on its Computer tab afterward.</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-sm font-semibold">AI and computer</span>
                      {defaults !== "error" && (
                        <div className="flex rounded-xl bg-chip p-0.5" role="radiogroup" aria-label="AI and computer">
                          {(
                            [
                              ["defaults", "Use my defaults"],
                              ["custom", "Customize"],
                            ] as const
                          ).map(([m, label]) => (
                            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx("h-8 px-3.5 rounded-[10px] text-[13px] font-semibold", mode === m ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {mode === "defaults" && defaults !== "error" ? (
                      <div className="rounded-2xl bg-bg px-4 py-3 flex flex-wrap items-center gap-4">
                        <div className="flex-1 min-w-36">
                          <div className="text-xs font-semibold text-muted">AI</div>
                          <div className="text-sm font-semibold flex items-center gap-1.5">
                            {defaults?.harness && <HarnessLogo harness={defaults.harness} size={16} />}
                            {summary ? summary.ai : "Loading…"}
                          </div>
                        </div>
                        <div className="flex-1 min-w-36">
                          <div className="text-xs font-semibold text-muted">Computer</div>
                          <div className="text-sm font-semibold">{summary ? summary.computer : "Loading…"}</div>
                        </div>
                        <a href="#/settings/agent-defaults" onClick={onClose} className="text-[13px] font-semibold text-accent-text hover:underline">
                          Change defaults
                        </a>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {defaults === "error" && <p className="text-xs text-muted">Pick which AI it uses and where it works.</p>}
                        <div className="grid sm:grid-cols-3 gap-3">
                          <label className="space-y-1.5">
                            <span className="block text-[13px] font-semibold text-muted">Runs on</span>
                            <select
                              value={harness}
                              onChange={(e) => {
                                touched.current = true;
                                setHarness(e.target.value);
                              }}
                              className="h-10 w-full rounded-xl border border-input bg-panel px-2.5 text-sm"
                            >
                              {harnesses.map((h) => (
                                <option key={h.id} value={h.id}>
                                  {h.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-1.5">
                            <span className="block text-[13px] font-semibold text-muted">Model</span>
                            <Input
                              value={model}
                              onChange={(e) => {
                                touched.current = true;
                                setModel(e.target.value);
                              }}
                              placeholder="Automatic"
                              list="new-agent-models"
                              className="h-10!"
                            />
                            <datalist id="new-agent-models">{defaults && defaults !== "error" && defaults.model && <option value={defaults.model} />}</datalist>
                          </label>
                          {/* only ask which device when there's a real choice */}
                          {usable.length < 2 ? (
                            <div className="space-y-1.5">
                              <span className="block text-[13px] font-semibold text-muted">Device</span>
                              <div className="h-10 flex items-center text-sm">
                                {usable[0] ? `${usable[0].name}${usable[0].online ? "" : " (offline)"}` : "None yet. Connect one under Devices."}
                              </div>
                            </div>
                          ) : (
                          <label className="space-y-1.5">
                            <span className="block text-[13px] font-semibold text-muted">Device</span>
                            {/* only ask which device when there's a real choice */}
                            {usable.length < 2 ? (
                              <p className="h-10 flex items-center text-sm text-muted">
                                {usable[0] ? `Runs on ${usable[0].name}${usable[0].online ? "" : " (offline)"}.` : "No device yet. Connect one under Devices and pick it then."}
                              </p>
                            ) : (
                            <select
                              value={nodeId}
                              onChange={(e) => {
                                touched.current = true;
                                setNodeId(e.target.value);
                                setComputer(defaultComputer(nodes.find((n) => n.id === e.target.value), computers));
                              }}
                              className="h-10 w-full rounded-xl border border-input bg-panel px-2.5 text-sm"
                            >
                              <option value="">Decide later</option>
                              {usable.map((n) => (
                                <option key={n.id} value={n.id}>
                                  {n.name} ({n.online ? "online" : "offline"})
                                </option>
                              ))}
                            </select>
                            )}
                          </label>
                          )}
                        </div>
                        {selectedHarness.protocol !== "mcp" && <ComputerPicker value={computer} onChange={chooseComputer} node={node} nodes={nodes} />}
                        {node && !runsInVm(harness) && !installed.has(harness) && selectedHarness.protocol !== "mcp" && (
                          <p className="text-xs text-muted">
                            Install {selectedHarness.label} on {node.name} before its first run.
                          </p>
                        )}
                        {node && !node.online && (
                          <p role="status" className="text-xs text-warn">
                            {node.name} is offline. You can create {cleanName || "this agent"} now, but it can't answer until {node.name} reconnects.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded-2xl border border-line">
                  <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced} className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left">
                    <ChevronRight size={16} className={cx("shrink-0 transition-transform", advanced && "rotate-90")} />
                    <span className="text-sm font-semibold">Advanced</span>
                    <span className="text-[13px] text-muted truncate">Handle{inviteOn ? ", who it answers" : ""}, apps and skills</span>
                  </button>
                  {advanced && (
                    <div className="grid sm:grid-cols-2 gap-4 px-4 pb-4 pt-1">
                      <label className="space-y-1.5">
                        <span className="block text-[13px] font-semibold text-muted">Handle</span>
                        <Input
                          value={handle}
                          onChange={(e) => {
                            setHandle(slug(e.target.value));
                            setHandleEdited(true);
                          }}
                          placeholder={slug(cleanName) || "your-agent"}
                          aria-label="Handle"
                          className="h-10!"
                        />
                        <span className="block text-xs text-muted">How people and agents @mention it.</span>
                      </label>
                      {inviteOn && (
                        <div className="space-y-1.5">
                          <span className="block text-[13px] font-semibold text-muted">Answers</span>
                          <div className="flex rounded-xl bg-chip p-0.5" role="radiogroup" aria-label="Who it answers">
                            {(
                              [
                                ["me", "Only me"],
                                ["anyone", "Anyone"],
                                ["people", "Picked people"],
                              ] as const
                            ).map(([v, label]) => (
                              <button key={v} type="button" role="radio" aria-checked={respondTo === v} onClick={() => setRespondTo(v)} className={cx("flex-1 h-8 px-2 rounded-[10px] text-[13px] font-semibold whitespace-nowrap", respondTo === v ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>
                                {label}
                              </button>
                            ))}
                          </div>
                          {respondTo === "people" &&
                            (others.length ? (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {others.map((p) => (
                                  <Chip key={p.id} small on={respondPeople.includes(p.id)} onClick={() => setRespondPeople(togglePick(respondPeople, p.id))}>
                                    {p.name}
                                  </Chip>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted">Nobody else is here yet. Invite people first; until then it answers only you.</p>
                            ))}
                        </div>
                      )}
                      <div className="space-y-1.5">
                        <span className="block text-[13px] font-semibold text-muted">Connected apps</span>
                        <div className="flex flex-wrap gap-1.5">
                          {connectors === null && <span className="text-xs text-muted">Loading…</span>}
                          {connectors?.map((c) =>
                            c.agentIds.length === 0 ? (
                              <span key={c.id} className="h-8 px-2.5 rounded-lg bg-chip text-[13px] font-medium inline-flex items-center gap-1" title="On for every agent">
                                <Check size={13} /> {c.name}
                              </span>
                            ) : (
                              <Chip key={c.id} small on={pickedApps.includes(c.id)} onClick={() => setPickedApps(togglePick(pickedApps, c.id))}>
                                {c.name}
                              </Chip>
                            ),
                          )}
                          <AddChip onClick={() => (onClose(), go({ view: "connectors" }))} />
                        </div>
                        {!canUseConnectedApps(selectedHarness) && <p className="text-xs text-muted">{selectedHarness.label} can't use connected apps yet.</p>}
                      </div>
                      <div className="space-y-1.5">
                        <span className="block text-[13px] font-semibold text-muted">Skills</span>
                        <div className="flex flex-wrap gap-1.5">
                          {skills === null && <span className="text-xs text-muted">Loading…</span>}
                          {skills?.map((sk) => (
                            <Chip key={sk.id} small on={pickedSkills.includes(sk.id)} onClick={() => setPickedSkills(togglePick(pickedSkills, sk.id))} title={sk.description}>
                              {sk.name}
                            </Chip>
                          ))}
                          <AddChip onClick={() => (onClose(), go({ view: "skills" }))} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </fieldset>
            </div>

            {error && (
              <p role="alert" className="px-5 sm:px-7 pb-3 text-sm text-bad">
                {error}
                {created ? " Your agent was created. Retry to finish its invitation." : ""}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-7 py-4 border-t border-line bg-bg rounded-b-3xl">
              {invite ? (
                <button type="button" disabled={busy || !!created} onClick={() => setInvite(false)} className="text-[13px] font-semibold text-muted hover:text-ink">
                  Make a new agent instead
                </button>
              ) : (
                <button type="button" disabled={busy || !!created} onClick={() => setView("external")} className="text-[13px] font-semibold text-muted hover:text-ink underline-offset-2 hover:underline">
                  Already running somewhere? Bring it in
                </button>
              )}
              <div className="flex gap-2.5 ml-auto">
                <Button type="button" variant="ghost" disabled={busy} onClick={onClose} className="h-11! rounded-full! px-5!">
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={busy || (!created && (!validName || (mode === "defaults" && !invite && defaults === null)))} className="h-11! rounded-full! px-5!">
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {external ? "Create invitation" : "Create agent"}
                </Button>
              </div>
            </div>
          </form>
        )}

        {view === "look" && (
          <div className="p-5 sm:p-7">
            <LookEditorScreen
              initial={look}
              name={cleanName}
              saveLabel="Use this look"
              onBack={() => setView("form")}
              onSave={(l) => {
                setAppearance(l);
                setView("form");
              }}
            />
          </div>
        )}

        {view === "external" && (
          <div className="p-5 sm:p-7 space-y-5">
            <BackHeader title="Bring your agent along" body="Invite it directly, or find it on a device." onBack={() => setView("form")} />
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => {
                  setInvite(true);
                  setView("form");
                }}
                className="agent-external-choice"
              >
                <UserPlus size={22} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  <span className="block font-medium">
                    Invite an agent <Pill>Recommended</Pill>
                  </span>
                  <span className="block text-sm text-muted mt-1">Connect any MCP-capable session with an invitation. No device search needed.</span>
                </span>
                <ArrowRight size={18} className="shrink-0" />
              </button>
              <button type="button" onClick={() => setView("discover")} className="agent-external-choice">
                <Search size={22} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  <span className="block font-medium">Find on a connected device</span>
                  <span className="block text-sm text-muted mt-1">Import a saved setup with its personality, instructions, and supported memory notes.</span>
                </span>
                <ArrowRight size={18} className="shrink-0" />
              </button>
            </div>
            <p className="text-xs text-muted leading-relaxed">Discovery checks known configuration folders, so custom setups may not appear. Neither option automatically copies skills. Your agent can save selected knowledge to the vault once connected.</p>
          </div>
        )}

        {view === "discover" && (
          <div className="p-5 sm:p-7 space-y-5">
            <BackHeader title="Find an existing agent" body="Choose a saved setup from one of your devices." onBack={() => setView("external")} />
            <ImportAgent
              nodes={nodes}
              onClose={onClose}
              onInvite={() => {
                setInvite(true);
                setView("form");
              }}
            />
          </div>
        )}

        {view === "invitation" && token && (
          <div className="p-5 sm:p-7 space-y-6">
            <div className="flex items-center gap-4">
              <Ghost look={look} size={72} trackPointer />
              <div>
                <h1 tabIndex={-1} className="text-2xl font-semibold">
                  Invite {cleanName} to Wisp
                </h1>
                <p className="text-sm text-muted mt-1">Add this connection to its existing session.</p>
              </div>
            </div>
            <ConnectionInstructions token={token} harness={harness} />
            <div className="rounded-xl border border-line p-4 text-sm text-muted">
              Once connected, ask it to introduce itself in #general and save selected notes with <code className="text-ink">memory_write</code>. Its local profile and skills aren't imported automatically.
            </div>
            <div className="flex justify-end gap-2">
              {!onCreated && (
                <Button type="button" variant="ghost" onClick={finish}>
                  Close
                </Button>
              )}
              <Button type="button" variant="primary" onClick={finish}>
                {onCreated ? "Back to the team" : "Open agent"} <ArrowRight size={16} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Chip({ on, onClick, children, title, small }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string; small?: boolean }) {
  return (
    <button type="button" role={small ? undefined : "radio"} aria-checked={small ? undefined : on} aria-pressed={small ? on : undefined} onClick={onClick} title={title} className={cx("rounded-full border font-semibold transition-colors", small ? "h-8 px-2.5 text-[13px] rounded-lg" : "h-8 px-3.5 text-[13px]", on ? "bg-ink text-bg border-ink" : "bg-panel text-ink border-line hover:bg-hover")}>
      {children}
    </button>
  );
}

function AddChip({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-8 px-2.5 rounded-lg border border-dashed border-line text-[13px] font-semibold text-muted hover:text-ink inline-flex items-center gap-1">
      <Plus size={13} /> Add
    </button>
  );
}

function BackHeader({ title, body, onBack }: { title: string; body: string; onBack: () => void }) {
  return (
    <div className="flex items-start gap-3">
      <button type="button" onClick={onBack} className="size-9 shrink-0 rounded-xl bg-chip hover:bg-hover grid place-items-center text-muted hover:text-ink" aria-label="Back">
        <ArrowLeft size={17} />
      </button>
      <div>
        <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="text-sm text-muted mt-0.5">{body}</p>
      </div>
    </div>
  );
}

/** Agents that already live on a device (Hermes, OpenClaw, Claude Code subagents): bring them in with their soul and notes. */
/** A free handle from a name: "Claude Code (your setup)" → "claude", or "claude-2" when that's taken. */
export function freeHandle(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .split("-")[0]
      .slice(0, 28) || "agent";
  let h = base;
  for (let i = 2; taken.includes(h); i++) h = `${base}-${i}`;
  return h;
}

/**
 * Bring in an agent found on a device. Claude Code, Codex, Hermes and Kimi CLI move into a VM on that device when
 * it has one (their instructions and memories come along); others keep running on the device.
 */
export async function importFound(
  x: { node: NodeInfo; d: DiscoveredAgent },
  o: {
    handle: string;
    computerId: string | null;
    headless?: boolean;
    computers: ComputerInfo[];
  },
): Promise<Agent> {
  const vmHere = o.computers.some(
    (c) => c.id === o.computerId && c.kind === "vm" && c.nodeId === x.node.id,
  );
  return api<Agent>("POST", "/api/agents/import", {
    nodeId: x.node.id,
    key: x.d.key,
    handle: o.handle,
    computerId: o.computerId,
    headless: !!o.headless,
    ...(vmHere && runsInVm(x.d.harness) ? { runIn: "computer" } : {}),
  });
}

export function ImportAgent({
  nodes: initialNodes,
  onClose,
  onInvite,
}: {
  nodes: NodeInfo[];
  onClose: () => void;
  onInvite: () => void;
}) {
  const [nodes, setNodes] = useState(initialNodes);
  const [scanning, setScanning] = useState(false);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scanTimer.current) clearTimeout(scanTimer.current);
    },
    [],
  );
  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      await Promise.all(
        usableDevices(nodes)
          .filter((n) => n.online)
          .map((n) => api("POST", `/api/nodes/${n.id}/discover`)),
      );
      const refresh = async (remaining: number) => {
        try {
          setNodes(await api<NodeInfo[]>("GET", "/api/nodes"));
        } catch (err) {
          setError((err as Error).message);
          setScanning(false);
          return;
        }
        if (remaining > 0)
          scanTimer.current = setTimeout(
            () => void refresh(remaining - 1),
            1000,
          );
        else setScanning(false);
      };
      await refresh(3);
    } catch (err) {
      setError((err as Error).message);
      setScanning(false);
    }
  };
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const found = useMemo(
    () =>
      usableDevices(nodes).flatMap((n) =>
        (n.discovered ?? []).map((d) => ({ node: n, d })),
      ),
    [nodes],
  );
  const [pick, setPick] = useState<{
    node: NodeInfo;
    d: DiscoveredAgent;
  } | null>(null);
  const [handle, setHandle] = useState("");
  const [computer, setComputer] = useState<ComputerChoice>({ kind: "later" });
  const imported = useRef(new Map<string, Agent>());
  const importComputers = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 32);

  const choose = (x: { node: NodeInfo; d: DiscoveredAgent }) => {
    setPick(x);
    setHandle(
      freeHandle(
        x.d.name,
        agents.map((a) => a.handle),
      ),
    );
    const existing = importComputers.current.get(`${x.node.id}:${x.d.key}`);
    setComputer(existing ? { kind: "existing", id: existing } : defaultComputer(x.node, computers));
  };

  if (!found.length)
    return (
      <div className="rounded-xl border border-line p-5 space-y-4 text-sm">
        <p className="font-medium">No saved setups found yet</p>
        <p className="text-muted">
          Wisp checks known configuration folders on your connected devices.
          Custom locations and other profiles may not appear; it doesn't search
          for running processes.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={onInvite}>
            <UserPlus size={16} />
            Invite instead
          </Button>
          <Button
            type="button"
            disabled={scanning || !usableDevices(nodes).some((n) => n.online)}
            onClick={() => void scan()}
          >
            {scanning ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Search size={16} />
            )}
            {scanning ? "Looking…" : "Look again"}
          </Button>
        </div>
        {!usableDevices(nodes).some((n) => n.online) && (
          <p className="text-xs text-muted">
            Connect a device under Devices to discover its saved agent setups.
          </p>
        )}
        {error && (
          <p role="alert" className="text-bad">
            {error}
          </p>
        )}
      </div>
    );

  const fresh = found.filter(
    (x) =>
      !imported.current.has(`${x.node.id}:${x.d.key}`) &&
      !agents.some(
        (a) =>
          a.nodeId === x.node.id &&
          a.harness === x.d.harness &&
          a.name === x.d.name,
      ),
  );
  const bringAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const taken = [...agents, ...imported.current.values()].map((a) => a.handle);
    try {
      for (const x of fresh) {
        const handle = freeHandle(x.d.name, taken);
        taken.push(handle);
        const c = defaultComputer(x.node, computers);
        const key = `${x.node.id}:${x.d.key}`;
        const computerId = importComputers.current.get(key) ?? await resolveComputer(c, x.node.id, x.d.name);
        if (computerId) importComputers.current.set(key, computerId);
        const all = c.kind === "vm" ? await api<ComputerInfo[]>("GET", "/api/computers") : computers;
        const a = await importFound(x, {
          handle,
          computerId,
          headless: c.kind === "headless",
          computers: all,
        });
        imported.current.set(key, a);
      }
      await Promise.all([
        refreshAgents(),
        useStore.getState().refreshComputers(),
      ]);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-3">
        <p className="text-xs text-muted">
          Imports personality, instructions, and supported notes. Skills stay on
          the original device.
        </p>
        <Button type="button" disabled={scanning} onClick={() => void scan()}>
          {scanning ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Search size={15} />
          )}
          Look again
        </Button>
      </div>
      {error && !pick && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {fresh.length > 0 && (fresh.length > 1 || imported.current.size > 0) && !pick && (
        <div className="flex items-center gap-3 rounded-xl bg-hover px-3 py-2.5 text-sm">
          <span className="flex-1">
            {fresh.length} agents found. Bring them all in with their
            instructions and notes, each on{" "}
            {computers.some((c) => c.kind !== "device")
              ? "a computer you already have"
              : "its device"}
            .
          </span>
          <Button variant="primary" disabled={busy} onClick={bringAll}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Download size={15} />
            )}{" "}
            Bring in all
          </Button>
        </div>
      )}
      <div className="rounded-xl border border-line divide-y divide-line">
        {found.map((x) => {
          const taken = imported.current.has(`${x.node.id}:${x.d.key}`) || agents.some(
            (a) =>
              a.nodeId === x.node.id &&
              a.harness === x.d.harness &&
              a.name === x.d.name,
          );
          return (
            <button
              key={`${x.node.id}:${x.d.key}`}
              disabled={busy || taken}
              onClick={() => choose(x)}
              className={cx(
                "w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-hover",
                pick?.d.key === x.d.key &&
                  pick.node.id === x.node.id &&
                  "bg-accent-soft",
              )}
            >
              <HarnessLogo harness={x.d.harness} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">
                  {x.d.name}{" "}
                  <span className="font-normal text-muted">
                    · {harnessLabel(x.d.harness)} on {x.node.name}
                  </span>
                </span>
                <span className="block text-xs text-muted truncate">
                  {[
                    x.d.description,
                    x.d.hasSoul && "has a soul",
                    x.d.memoryCount
                      ? `${x.d.memoryCount} note${x.d.memoryCount === 1 ? "" : "s"}`
                      : null,
                    x.d.model,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {taken && <Pill>already here</Pill>}
            </button>
          );
        })}
      </div>
      {pick && (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              const key = `${pick.node.id}:${pick.d.key}`;
              const computerId = await resolveComputer(
                computer,
                pick.node.id,
                pick.d.name,
              );
              if (computerId && (computer.kind === "vm" || computer.kind === "screen")) {
                importComputers.current.set(key, computerId);
                setComputer({ kind: "existing", id: computerId });
              }
              const all =
                computer.kind === "vm" || (computer.kind === "existing" && !computers.some((c) => c.id === computerId))
                  ? await api<ComputerInfo[]>("GET", "/api/computers")
                  : computers;
              const a = await importFound(pick, {
                handle,
                computerId,
                headless: computer.kind === "headless",
                computers: all,
              });
              imported.current.set(key, a);
              await Promise.all([
                refreshAgents(),
                useStore.getState().refreshComputers(),
              ]);
              onClose();
              go({ view: "agents", agentId: a.id, tab: "overview" });
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Handle"
            hint={`Its soul, instructions and notes are copied into Wisp's memory. ${pick.d.path}`}
          >
            <Input
              value={handle}
              onChange={(e) => setHandle(slug(e.target.value))}
              required
            />
          </Field>
          <ComputerPicker
            value={computer}
            onChange={setComputer}
            node={pick.node}
            nodes={nodes}
          />
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy}>
              {busy ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}{" "}
              Bring in {pick.d.name}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
