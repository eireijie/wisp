import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Cloud,
  Download,
  Laptop,
  Loader2,
  Lock,
  Monitor,
  Plus,
  Search,
  Shuffle,
  UserPlus,
} from "lucide-react";
import {
  defaultAppearance,
  randomAppearance,
  type GhostAppearance,
} from "@warren/core/src/appearance.ts";
import { Ghost } from "../components/Ghost.tsx";
import { HarnessLogo } from "../components/HarnessLogo.tsx";
import { ConnectionInstructions } from "../components/ConnectionInstructions.tsx";
import {
  HARNESSES,
  runsInVm,
  soulTemplate,
  type Agent,
  type DiscoveredAgent,
} from "@warren/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go } from "../router.ts";
import type { NodeInfo } from "./AgentSettings.tsx";
import { computerKindLabel, usableDevices } from "../devices.ts";
import { TEMPLATES, type AgentTemplate } from "../templates.ts";
import { defaultComputer, resolveComputer, vmOnDevice, withComputer, type ComputerChoice } from "../agentComputer.ts";
import {
  Button,
  Field,
  HARNESS_LABELS,
  Input,
  Modal,
  Pill,
  Textarea,
  cx,
} from "../components/ui.tsx";

function ComputerPicker({
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
      <div className="text-sm font-medium mb-1">Computer</div>
      <p className="text-xs text-muted mb-2">
        Where it works: it opens apps and websites there, and you can watch and
        take over.
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        {node &&
          opt(
            { kind: "vm" },
            <Monitor size={15} />,
            `New VM on ${node.name}`,
            node.capabilities?.vm.ok
              ? "Its own Linux desktop. Doesn't touch your screen."
              : (node.capabilities?.vm.detail ?? "Connect the device to check"),
            !node.capabilities?.vm.ok,
          )}
        {node?.mine &&
          !screenExists &&
          opt(
            { kind: "screen" },
            <Lock size={15} />,
            "Your own screen",
            node.capabilities?.screen.off
              ? `Off. Turn it on at ${node.name}: warren node screen on`
              : node.capabilities?.screen.ok === false
                ? node.capabilities.screen.detail
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
        {opt(
          { kind: "later" },
          <Plus size={15} />,
          "Choose later",
          "Pick one on its Computer tab.",
        )}
      </div>
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
    </div>
  );
}

type Step =
  | "name"
  | "harness"
  | "configure"
  | "external"
  | "discover"
  | "invitation";
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);

export function CreateAgent({
  nodes,
  onClose,
}: {
  nodes: NodeInfo[];
  onClose: () => void;
}) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const [step, setStep] = useState<Step>("name");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    body?.scrollTo({ top: 0 });
    const target = body?.querySelector<HTMLElement>("input") ?? body?.querySelector<HTMLElement>("h1");
    target?.focus();
  }, [step]);
  const [invite, setInvite] = useState(false);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [harness, setHarness] = useState("claude-code");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const usable = usableDevices(nodes);
  const [nodeId, setNodeId] = useState(
    usable.find((n) => n.online)?.id ?? usable[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState("");
  const [computer, setComputer] = useState<ComputerChoice>(() =>
    defaultComputer(
      nodes.find((n) => n.id === nodeId),
      computers,
    ),
  );
  const chooseComputer = (choice: ComputerChoice) => {
    setComputer(choice);
    if (choice.kind === "existing") {
      const c = computers.find((c) => c.id === choice.id);
      if (c?.kind === "vm" && c.nodeId && usable.some((n) => n.id === c.nodeId))
        setNodeId(c.nodeId);
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shuffled, setShuffled] = useState<GhostAppearance | null>(null);
  const [created, setCreated] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const node = nodes.find((n) => n.id === nodeId);
  const installed = new Set((node?.harnesses ?? []).map((h) => h.id));
  const declared = [
    ...new Map(
      usable.flatMap((n) =>
        (n.harnesses ?? [])
          .filter((h) => h.id.startsWith("acp:"))
          .map((h) => [h.id, h] as const),
      ),
    ).values(),
  ];
  const harnesses = [
    ...HARNESSES.filter((h) => h.id !== "custom"),
    ...declared.map((h) => ({
      id: h.id,
      label: h.id.slice(4),
      protocol: "acp" as const,
      note: "Available on a connected device",
      binary: "",
    })),
    HARNESSES.find((h) => h.id === "custom")!,
  ];
  const selectedHarness = harnesses.find((h) => h.id === harness)!;
  const external = invite || selectedHarness.protocol === "mcp";
  const cleanName = name.trim();
  const finalHandle = handle || slug(cleanName);
  // every agent has its own colors: the ghost follows its handle until you shuffle
  const look = shuffled ?? defaultAppearance(finalHandle || "new-agent");
  const invalidHandle = !/^[a-z][a-z0-9-]{0,31}$/.test(finalHandle);
  const taken = agents.some((a) => a.handle === finalHandle);
  const validName = !!cleanName && !invalidHandle && !taken;
  const move = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const finish = () => {
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
        const computerId = external
          ? null
          : await resolveComputer(computer, nodeId, cleanName);
        const vmHere = vmOnDevice(computer, nodeId, computers);
        const soul = template
          ? soulTemplate(cleanName, finalHandle).replace(
              /## Voice\n(?:- .*\n?)*/,
              `## Voice\n- ${template.voice}\n`,
            )
          : undefined;
        a = await api<Agent>("POST", "/api/agents", {
          harness,
          name: cleanName,
          handle: finalHandle,
          nodeId: external ? null : nodeId || null,
          computerId,
          instructions,
          soul,
          settings: {
            ...(shuffled ? { appearance: shuffled } : {}),
            ...(!external && computer.kind === "headless"
              ? { headless: true }
              : {}),
            ...(!external && vmHere && runsInVm(harness)
              ? { runIn: "computer" as const }
              : {}),
          },
        });
        setCreated(a);
      }
      await Promise.all([
        refreshAgents(),
        useStore.getState().refreshComputers(),
      ]);
      if (external) {
        const r = await api<{ token: string }>(
          "POST",
          `/api/agents/${a.id}/token`,
        );
        setToken(r.token);
        move("invitation");
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

  const progress =
    step === "external" || step === "discover" ? (
      <p className="agent-step-label">Bring your agent</p>
    ) : step === "invitation" ? (
      <p className="agent-step-label">Invitation ready</p>
    ) : (
      <nav
        className="agent-step-progress"
        aria-label="Add agent steps"
      >
        {(
          [
            ["name", "Identity"],
            ["harness", "Harness"],
            ["configure", "Workspace"],
          ] as const
        ).map(([id, label], i) => (
          <span key={id} className="agent-step-stop">
            <button
              type="button"
              aria-current={step === id ? "step" : undefined}
              aria-label={`${label}, step ${i + 1} of 3`}
              disabled={
                busy ||
                !!created ||
                (id !== "name" && !validName) ||
                (id === "configure" && step === "name")
              }
              onClick={() => move(id)}
              className={cx(
                "agent-step-dot",
                step === id && "current",
                ["name", "harness", "configure"].indexOf(step) > i && "complete",
              )}
            >
              <span className="sr-only">{label}</span>
            </button>
          </span>
        ))}
        <span className="agent-step-label">
          {step === "name" ? "Identity" : step === "harness" ? "Harness" : "Workspace"} · {["name", "harness", "configure"].indexOf(step) + 1} of 3
        </span>
      </nav>
    );
  const footer = (
    back: () => void,
    backLabel: string,
    action: React.ReactNode,
  ) => (
    <div className={cx("agent-wizard-footer", !action && "back-only")}>
      <Button
        type="button"
        variant="ghost"
        disabled={busy || (!!created && step !== "invitation")}
        onClick={back}
      >
        {backLabel === "Back" && <ArrowLeft size={17} />}
        {backLabel}
      </Button>
      {action}
      {step === "name" && <p className="agent-footer-hint">Harness and workspace are next.</p>}
    </div>
  );
  const primary = (label: string, action: () => void, disabled = false) => (
    <Button
      type="button"
      variant="primary"
      className="h-11! rounded-lg! px-5!"
      disabled={disabled || busy}
      onClick={action}
    >
      {busy ? <Loader2 size={17} className="animate-spin" /> : null}
      {label}
      {!busy && <ArrowRight size={17} />}
    </Button>
  );

  return (
    <Modal
      title={<span className="agent-drawer-eyebrow">Add to Warren</span>}
      label="Add an agent"
      onClose={busy ? () => {} : onClose}
      drawer
      className="agent-wizard"
      contentClassName="p-0!"
    >
      <div className="agent-wizard-progress">{progress}</div>
      {step === "name" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (validName) move("harness");
          }}
        >
          <div ref={bodyRef} className="agent-wizard-body agent-identity-step">
            <div className="agent-wizard-hero">
              <h1 tabIndex={-1}>Who’s joining?</h1>
              <p>A name first. Their setup comes next.</p>
            </div>
            <div className="agent-identity-row">
              <Ghost look={look} size={112} trackPointer label="Your new agent, looking toward your pointer" />
              <div className="min-w-0 flex-1 space-y-2">
              <Field label="Agent name">
                <Input
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!handleEdited) setHandle(slug(e.target.value));
                  }}
                  placeholder="e.g. Darnold"
                  className="h-12! text-base! bg-bg"
                  required
                />
              </Field>
              <p className="agent-handle-preview">@{finalHandle || "your-agent"}</p>
              {cleanName && invalidHandle && (
                <p className="text-xs text-bad">
                  Include a letter from a–z so your agent can have an @handle.
                </p>
              )}
              {taken && (
                <p className="text-xs text-bad">
                  @{finalHandle} is already taken. Choose another name or{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setHandle(
                        freeHandle(
                          cleanName,
                          agents.map((a) => a.handle),
                        ),
                      );
                      setHandleEdited(true);
                    }}
                  >
                    use an available handle
                  </button>
                  .
                </p>
              )}
              </div>
            </div>
            <p className="agent-identity-hint">You can change their name and look later.</p>
            <div className="agent-join-options">
              <h2>Already running somewhere?</h2>
              <button type="button" onClick={() => { setInvite(true); move(validName ? "harness" : "external"); }} className="agent-invite-link">
                <UserPlus size={18} /> <span>Send an invitation</span> <ArrowRight size={18} />
              </button>
              <button type="button" onClick={() => move("discover")} className="agent-discover-link">Discover on a connected device</button>
            </div>
          </div>
          {footer(
            onClose,
            "Cancel",
            <Button
              type="submit"
              variant="primary"
              className="h-12! rounded-lg! px-5!"
              disabled={!validName}
            >
              Next: choose harness <ArrowRight size={17} />
            </Button>,
          )}
        </form>
      )}

      {step === "harness" && (
        <>
          <div ref={bodyRef} className="agent-wizard-body">
            <div className="agent-wizard-hero compact">
              <h1 tabIndex={-1}>Choose a harness</h1>
              <p>How should {cleanName} work?</p>
            </div>
            {invite && (
              <p className="mb-5 text-sm text-muted">
                Choose the harness your existing agent uses. You'll get an
                invitation to connect its session.
              </p>
            )}
            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-label="Agent harness"
            >
              {harnesses.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  aria-pressed={harness === h.id}
                  onClick={() => setHarness(h.id)}
                  className={cx(
                    "agent-harness-card",
                    harness === h.id && "selected",
                  )}
                >
                  {harness === h.id && (
                    <Check size={14} className="agent-harness-check" />
                  )}
                  <HarnessLogo harness={h.id} size={24} />
                  <span className="text-sm font-medium">
                    {h.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
          {footer(
            () => move(invite ? "external" : "name"),
            "Back",
            primary("Next: workspace", () => move("configure")),
          )}
        </>
      )}

      {step === "configure" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div ref={bodyRef} className="agent-wizard-body space-y-6">
            <div className="flex items-center gap-4 pb-2">
              <Ghost
                look={look}
                size={68}
                trackPointer
                label={`${cleanName}'s ghost`}
              />
              <div className="flex-1 min-w-0">
                <h1 tabIndex={-1} className="text-xl font-semibold truncate">
                  {external ? "Invite" : "Set up"} {cleanName}
                </h1>
                <p className="text-sm text-muted mt-1 flex items-center gap-2">
                  <HarnessLogo harness={harness} size={16} />
                  {selectedHarness.label}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                aria-label="Shuffle agent appearance"
                disabled={!!created}
                onClick={() => setShuffled(randomAppearance())}
              >
                <Shuffle size={16} />
              </Button>
            </div>
            <fieldset
              disabled={busy || !!created}
              className="space-y-5 min-w-0"
            >
              <Field label="Handle" hint="How people and agents @mention it.">
                <Input
                  value={handle}
                  onChange={(e) => {
                    setHandle(slug(e.target.value));
                    setHandleEdited(true);
                  }}
                  placeholder={slug(cleanName)}
                  required
                />
                {taken && !created && (
                  <span className="text-xs text-bad">
                    That handle is already in use.
                  </span>
                )}
              </Field>
              {external ? (
                <div className="rounded-xl border border-line p-4 text-sm space-y-2">
                  <p className="font-medium">
                    Connect the agent where it already runs
                  </p>
                  <p className="text-muted">
                    The invitation gives its session Warren's chat, tasks,
                    memory, and file tools. You can assign a computer on its
                    Computer tab afterward.
                  </p>
                  <p className="text-muted">
                    Its local memory and skills stay with its harness. It can
                    choose what to save to the vault using Warren's memory
                    tools.
                  </p>
                  <p className="text-xs text-muted">
                    MCP sessions act while they're running. To wake an agent
                    automatically on @mention, run a supported harness on a
                    connected device.
                  </p>
                </div>
              ) : (
                <>
                  <Field
                    label="Device"
                    hint={
                      usable.length
                        ? "Where Warren starts its harness."
                        : "You can connect a device later under Devices."
                    }
                  >
                    <select
                      value={nodeId}
                      onChange={(e) => {
                        setNodeId(e.target.value);
                        setComputer(
                          defaultComputer(
                            nodes.find((n) => n.id === e.target.value),
                            computers,
                          ),
                        );
                      }}
                      className="h-10 w-full rounded-lg border border-input bg-panel px-3 text-sm"
                    >
                      <option value="">Decide later</option>
                      {usable.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name} ({n.online ? "online" : "offline"})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <ComputerPicker
                    value={computer}
                    onChange={chooseComputer}
                    node={node}
                    nodes={nodes}
                  />
                  {node && !runsInVm(harness) && !installed.has(harness) && (
                    <p className="text-xs text-muted">
                      Install {selectedHarness.label} on {node.name} before its
                      first run.
                    </p>
                  )}
                </>
              )}
              <details className="rounded-xl border border-line p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Give it a job{" "}
                  <span className="font-normal text-muted">(optional)</span>
                </summary>
                <div className="space-y-4 mt-4">
                  <Field label="Starting role">
                    <select
                      value={template?.id ?? ""}
                      onChange={(e) => {
                        const t =
                          TEMPLATES.find((t) => t.id === e.target.value) ??
                          null;
                        setTemplate(t);
                        setInstructions(t?.instructions ?? "");
                      }}
                      className="h-10 w-full rounded-lg border border-input bg-panel px-3 text-sm"
                    >
                      <option value="">Start from scratch</option>
                      {TEMPLATES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {template && (
                    <p className="text-xs text-muted">{template.blurb}</p>
                  )}
                  <Field label="Instructions">
                    <Textarea
                      rows={4}
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      placeholder="What is this agent responsible for?"
                    />
                  </Field>
                </div>
              </details>
            </fieldset>
            {!external && node && !node.online && (
              <p role="status" className="rounded-xl border border-line bg-panel px-3 py-2 text-sm text-warn">
                {node.name} is offline. You can create {cleanName || "this agent"} now, but it can&apos;t answer until {node.name} reconnects.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-bad">
                {error}
                {created
                  ? " Your agent was created. Retry to finish its invitation."
                  : ""}
              </p>
            )}
          </div>
          {footer(
            () => move("harness"),
            "Back",
            <Button
              type="submit"
              variant="primary"
              className="h-11! rounded-lg! px-5!"
              disabled={busy || (!created && !validName)}
            >
              {busy && <Loader2 size={17} className="animate-spin" />}
              {external ? "Create invitation" : "Add agent"}
              {!busy && <ArrowRight size={17} />}
            </Button>,
          )}
        </form>
      )}

      {step === "external" && (
        <>
          <div ref={bodyRef} className="agent-wizard-body space-y-6">
            <div className="agent-wizard-hero compact">
              <h1 tabIndex={-1}>Bring your agent along</h1>
              <p>Invite it directly, or find it on a device.</p>
            </div>
            <Field label="Agent name">
              <Input
                value={name}
                maxLength={80}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!handleEdited) setHandle(slug(e.target.value));
                }}
                placeholder="e.g. Darnold"
              />
            </Field>
            <div className="space-y-3">
              <button
                type="button"
                disabled={!validName}
                onClick={() => {
                  setInvite(true);
                  move("harness");
                }}
                className="agent-external-choice disabled:opacity-50"
              >
                <UserPlus size={22} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  <span className="block font-medium">
                    Invite an agent <Pill>Recommended</Pill>
                  </span>
                  <span className="block text-sm text-muted mt-1">
                    Connect any MCP-capable session with an invitation. No
                    device search needed.
                  </span>
                </span>
                <ArrowRight size={18} className="shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => move("discover")}
                className="agent-external-choice"
              >
                <Search size={22} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  <span className="block font-medium">
                    Find on a connected device
                  </span>
                  <span className="block text-sm text-muted mt-1">
                    Import a saved setup with its personality, instructions, and
                    supported memory notes.
                  </span>
                </span>
                <ArrowRight size={18} className="shrink-0" />
              </button>
            </div>
            {(taken || (cleanName && invalidHandle)) && (
              <p className="text-xs text-bad">
                Choose a name with an available @handle to create an invitation.
              </p>
            )}
            <p className="text-xs text-muted leading-relaxed">
              Discovery checks known configuration folders, so custom setups may
              not appear. Neither option automatically copies skills. Your agent
              can save selected knowledge to the vault once connected.
            </p>
          </div>
          {footer(
            () => {
              setInvite(false);
              move("name");
            },
            "Back",
            null,
          )}
        </>
      )}

      {step === "discover" && (
        <>
          <div ref={bodyRef} className="agent-wizard-body space-y-5">
            <div>
              <h1 tabIndex={-1} className="text-2xl font-semibold">Find an existing agent</h1>
              <p className="text-sm text-muted mt-2">
                Choose a saved setup from one of your devices.
              </p>
            </div>
            <ImportAgent
              nodes={nodes}
              onClose={onClose}
              onInvite={() => {
                setInvite(true);
                move("external");
              }}
            />
          </div>
          {footer(() => move("external"), "Back", null)}
        </>
      )}

      {step === "invitation" && token && (
        <>
          <div ref={bodyRef} className="agent-wizard-body space-y-6">
            <div className="flex items-center gap-4">
              <Ghost look={look} size={72} trackPointer />
              <div>
                <h1 tabIndex={-1} className="text-2xl font-semibold">
                  Invite {cleanName} to Warren
                </h1>
                <p className="text-sm text-muted mt-1">
                  Add this connection to its existing session.
                </p>
              </div>
            </div>
            <ConnectionInstructions token={token} harness={harness} />
            <div className="rounded-xl border border-line p-4 text-sm text-muted">
              Once connected, ask it to introduce itself in #general and save
              selected notes with <code className="text-ink">memory_write</code>
              . Its local profile and skills aren't imported automatically.
            </div>
          </div>
          {footer(finish, "Close", primary("Open agent", finish))}
        </>
      )}
    </Modal>
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

function ImportAgent({
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
    setComputer(defaultComputer(x.node, computers));
  };

  if (!found.length)
    return (
      <div className="rounded-xl border border-line p-5 space-y-4 text-sm">
        <p className="font-medium">No saved setups found yet</p>
        <p className="text-muted">
          Warren checks known configuration folders on your connected devices.
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
      !agents.some(
        (a) =>
          a.nodeId === x.node.id &&
          a.harness === x.d.harness &&
          a.name === x.d.name,
      ),
  );
  const bringAll = async () => {
    setBusy(true);
    setError(null);
    const taken = agents.map((a) => a.handle);
    try {
      for (const x of fresh) {
        const handle = freeHandle(x.d.name, taken);
        taken.push(handle);
        const c = defaultComputer(x.node, computers);
        await importFound(x, {
          handle,
          computerId: c.kind === "existing" ? c.id : null,
          computers,
        });
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
      {fresh.length > 1 && !pick && (
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
          const taken = agents.some(
            (a) =>
              a.nodeId === x.node.id &&
              a.harness === x.d.harness &&
              a.name === x.d.name,
          );
          return (
            <button
              key={`${x.node.id}:${x.d.key}`}
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
                    · {HARNESS_LABELS[x.d.harness]} on {x.node.name}
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
            setBusy(true);
            setError(null);
            try {
              const computerId = await resolveComputer(
                computer,
                pick.node.id,
                pick.d.name,
              );
              const all =
                computer.kind === "vm"
                  ? await api<ComputerInfo[]>("GET", "/api/computers")
                  : computers;
              const a = await importFound(pick, {
                handle,
                computerId,
                headless: computer.kind === "headless",
                computers: all,
              });
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
            hint={`Its soul, instructions and notes are copied into Warren's memory. ${pick.d.path}`}
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
