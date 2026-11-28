import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Bot, Check, ChevronDown, ChevronRight, Cloud, Download, Laptop, Loader2, Lock, MessageSquare, Monitor, Plus, Search, Shuffle, UserPlus, Users, X } from "lucide-react";
import { LAYER } from "../components/layers.ts";
import { newBubbleLook, shuffleBubbleLook, type GhostAppearance } from "@bubble-ai/core/src/appearance.ts";
import { Ghost } from "../components/Ghost.tsx";
import { HarnessLogo } from "../components/HarnessLogo.tsx";
import { ConnectionInstructions } from "../components/ConnectionInstructions.tsx";
import { effortName, prettyModel } from "../components/EffortSlider.tsx";
import { AppTile } from "../components/MarketParts.tsx";
import { AGENT_TYPES, START_APPS, type AgentType, type AgentTypeId } from "./onboarding/agentTypes.ts";
import { HARNESSES, accountsSignedIn, preferSignedIn, roleSentence, runsInVm, type Agent, type AgentSignIn, type Connector, type DiscoveredAgent, type Skill } from "@bubble-ai/core";
import { HarnessSignInButton } from "../components/HarnessSignInButton.tsx";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go } from "../router.ts";
import { openDm } from "../openDm.ts";
import type { NodeInfo } from "./AgentSettings.tsx";
import { computerKindLabel, usableDevices } from "../devices.ts";
import { defaultComputer, resolveComputer, vmOnDevice, withComputer, type ComputerChoice } from "../agentComputer.ts";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { useFeature } from "../features.ts";
import { useComputerMode } from "../computerMode.ts";
import { LookEditorScreen, LookRows } from "./LookEditor.tsx";
import { useNarrow } from "../components/SetupShell.tsx";
import { Button, Field, harnessLabel, Input, Modal, Pill, Textarea, cx, touchFirst } from "../components/ui.tsx";

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
      <div className="text-sm font-medium mb-2">Where should it work?</div>
      <div className="grid sm:grid-cols-2 gap-2">
        {node &&
          opt(
            { kind: "vm" },
            <Monitor size={15} />,
            `Its own desktop on ${node.name}`,
            node.capabilities?.vm.ok
              ? "It opens apps and websites there. Your screen stays yours."
              : (node.capabilities?.vm.detail ?? "Connect the device to check"),
            !node.capabilities?.vm.ok,
          )}
        {node?.mine &&
          !screenExists &&
          opt(
            { kind: "screen" },
            <Lock size={15} />,
            "My own screen",
            node.capabilities?.screen.off
              ? `Off. Turn it on at ${node.name}: bubble-ai node screen on`
              : node.capabilities?.screen.ok === false
                ? node.capabilities.screen.detail
                : "It runs on this computer.",
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
        {/* the device's job left it without a desktop; the switch for that is under More options, so show the choice here */}
        {value.kind === "headless" &&
          opt({ kind: "headless" }, <Bot size={15} />, "No desktop (answers only)", "It can chat and use files, but can't open apps or websites.")}
        {opt(
          { kind: "later" },
          <Plus size={15} />,
          "Decide later",
          "You can pick on its Computer tab.",
        )}
      </div>
      <MoreOptions className="mt-2">
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
      </MoreOptions>
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
  /** "device": on its device directly (the default once one is connected); "none": no computer */
  computer: "device" | "shared" | "own-vm" | "none";
  nodeId: string | null;
}

type AiChoice = { id: string; label: string; notInstalled: boolean; signedOut: boolean };

/**
 * The AI a new agent runs on, as one picker: its logo and name, and a list of every AI it can run
 * with, the ones installed on the device first ("Not installed" on the rest). The list is drawn on
 * the page (fixed) so the form's scroll area can't cut it off.
 */
export function AiPicker({ list, value, onPick }: { list: AiChoice[]; value: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const current = list.find((h) => h.id === value) ?? list[0];
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const h = panel.current?.offsetHeight ?? 0;
    const below = window.innerHeight - r.bottom - 12;
    const up = h > below && r.top - 12 > below;
    setPos({ position: "fixed", left: Math.max(8, r.left), width: Math.max(r.width, 240), maxHeight: Math.max(160, (up ? r.top : window.innerHeight - r.bottom) - 16), overflowY: "auto", ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }), transformOrigin: up ? "bottom left" : "top left" });
    panel.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    const scrolled = (e: Event) => !panel.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", scrolled);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", scrolled);
    };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <>
      <button ref={button} type="button" aria-label="Harness" aria-haspopup="listbox" aria-expanded={open} onClick={() => (setPos(null), setOpen(!open))} onKeyDown={(e) => e.key === "ArrowDown" && (e.preventDefault(), setOpen(true))} className={cx(SELECT, "flex items-center gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40")}>
        {current && <HarnessLogo harness={current.id} size={16} />}
        <span className="min-w-0 flex-1 truncate font-medium">{current?.label}</span>
        {current?.notInstalled && <span className="shrink-0 text-[11px] text-muted">Not installed</span>}
        {current && !current.notInstalled && current.signedOut && <span className="size-1.5 shrink-0 rounded-full bg-warn" title="Not signed in" aria-label="Not signed in" />}
        <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div ref={panel} role="listbox" aria-label="Harness" onKeyDown={move} style={pos ?? { position: "fixed", visibility: "hidden", top: 0, left: 0 }} className={cx("m-menu glass rounded-[12px] p-1.5", LAYER.menu)}>
            {list.map((h) => (
              <button
                key={h.id}
                type="button"
                role="option"
                aria-selected={h.id === value}
                onClick={() => {
                  onPick(h.id);
                  setOpen(false);
                  button.current?.focus();
                }}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover"
              >
                <HarnessLogo harness={h.id} size={18} />
                <span className="min-w-0 flex-1 truncate font-medium">{h.label}</span>
                {h.notInstalled && <span className="shrink-0 text-[11px] text-muted">Not installed</span>}
                {!h.notInstalled && h.signedOut && <span className="size-1.5 shrink-0 rounded-full bg-warn" title="Not signed in" aria-label="Not signed in" />}
                <Check size={14} className={cx("shrink-0", h.id === value ? "text-ink" : "invisible")} aria-hidden />
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** "Use my defaults" can't create an agent until the defaults name an AI: then you pick one right in the form. */
export const defaultsNeedPicking = (d: AgentDefaults | "error" | null) => d === "error" || (d !== null && !d.harness);

type View = "form" | "look" | "external" | "discover" | "invitation";
export type RespondTo = "me" | "anyone" | "people";

/** "Claude Code · Sonnet 5.5" and "Its own computer on my-mac": the defaults in a line each. */
export function defaultsSummary(d: AgentDefaults, nodes: Pick<NodeInfo, "id" | "name">[], simple = false): { ai: string; computer: string } {
  const harness = d.harness ? (harnessLabel(d.harness) ?? d.harness) : "Not picked yet";
  const node = nodes.find((n) => n.id === d.nodeId);
  return {
    ai: `${harness} · ${d.model ? prettyModel(d.model) : "Automatic model"}`,
    computer: computerSummary(d, node, simple),
  };
}

/**
 * Where "Use my defaults" puts it: the device directly, unless the owner picked otherwise; no
 * computer while there's no device. A member's agent never gets the owner's shared computer.
 */
function computerSummary(d: AgentDefaults, node: Pick<NodeInfo, "name"> | undefined, _simple: boolean): string {
  if (d.computer === "device") return node ? `${node.name} directly` : "No computer";
  if (d.computer === "shared") return "The shared computer";
  if (d.computer === "own-vm") return node ? `Its own computer on ${node.name}` : "Its own computer";
  return "No computer";
}

/** Names a new agent is offered: one is already in the field when the sheet opens. */
export const AGENT_NAMES = ["Nova", "Milo", "Wren", "Otto", "Iris", "Finn", "Luna", "Hugo", "Remy", "Sage", "Piper", "Echo", "Maple", "Quill", "Pixel", "Clover", "Indigo", "Ziggy", "Juniper", "Atlas"];

type Named = Pick<Agent, "name" | "handle">;

/** A name none of the agents here has yet, picked at random; numbered ("Nova 2") once every one is used. */
export function suggestName(agents: Named[], random: () => number = Math.random): string {
  const used = new Set(agents.flatMap((a) => [a.handle, slug(a.name)]));
  const pick = <T,>(list: T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const free = AGENT_NAMES.filter((n) => !used.has(slug(n)));
  if (free.length) return pick(free);
  const base = pick(AGENT_NAMES);
  for (let i = 2; ; i++) if (!used.has(slug(`${base} ${i}`))) return `${base} ${i}`;
}

/** The handle a name gets when nobody typed one: its slug, numbered when that's taken ("nova", then "nova-2"); "agent" for a name with no letter a to z. */
export function autoHandle(name: string, taken: string[]): string {
  const base = slug(name) || "agent";
  let h = base;
  for (let i = 2; taken.includes(h); i++) h = `${base.slice(0, 28).replace(/-+$/, "")}-${i}`;
  return h;
}

/**
 * What stops this agent being made, as one short line; null when nothing does. A handle typed by
 * hand is checked as typed. Without one a free handle is picked silently, so only a name another
 * agent already has is a problem.
 */
export function nameProblem(name: string, typedHandle: string, agents: Named[]): string | null {
  const clean = name.trim();
  if (!clean) return null;
  if (typedHandle) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(typedHandle)) return "A handle starts with a letter.";
    return agents.some((a) => a.handle === typedHandle) ? `@${typedHandle} is taken.` : null;
  }
  return agents.some((a) => a.name.trim().toLowerCase() === clean.toLowerCase()) ? `${clean} is already here.` : null;
}

const LABEL = "block text-[13px] font-medium text-muted";
const QUIET = "h-9 px-2.5 rounded-[8px] text-[13px] text-muted hover:text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 disabled:pointer-events-none";
const SELECT = "h-9 w-full rounded-[10px] border border-input bg-panel px-2.5 text-[13px]";
const CHOICE = "flex h-[46px] w-full items-center gap-3 px-3.5 text-left text-[14px] hover:bg-hover outline-none focus-visible:bg-hover";
/** a picked tile or chip: inked outline, no fill change, so the picks read at a glance */
const TILE = "relative flex items-center gap-2.5 rounded-[12px] border px-3 text-left outline-none transition-[border-color,background-color,box-shadow] duration-200 focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-45 disabled:pointer-events-none";
const TILE_ON = "border-ink bg-panel shadow-[inset_0_0_0_0.5px_var(--ink)]";
const TILE_OFF = "border-line bg-panel hover:bg-hover";

/** Where a new agent works: Automatic follows your defaults (the shared computer, in Simple), or one picked here. */
type Place = { kind: "auto" } | ComputerChoice;

/** The efforts a model offers, else its harness's, else the usual three. */
function effortsFor(h: { models?: { id: string; efforts?: string[] }[]; efforts?: string[]; defaultModel?: string } | undefined, model: string): string[] {
  const m = h?.models?.find((x) => x.id === (model || h?.defaultModel));
  const list = m?.efforts ?? h?.efforts ?? [];
  return list.length ? list : ["low", "medium", "high"];
}

const listOf = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What the new agent will say first, from what's picked so far: the preview under its bubble. */
export function sampleGreeting({ name, role, apps, instructions }: { name: string; role: string; apps: string[]; instructions: string }): string {
  const lines = [`Hi, I'm ${name.trim() || "your new agent"}.`];
  // said in its own words, not spliced in ("Says pong" is "I'm here to say pong.")
  const job = roleSentence(role);
  if (job) lines.push(job);
  if (apps.length) lines.push(`I can use ${listOf(apps.slice(0, 3))}${apps.length > 3 ? ` and ${apps.length - 3} more` : ""}.`);
  if (instructions.trim()) lines.push("I've read your instructions.");
  lines.push("What should I start on?");
  return lines.join(" ");
}

/**
 * New agent, on one sheet, already filled in so Create works at once (design "Calmer layout", D1).
 * On the left, its bubble, name, handle and shuffle, then its look as seven short rows. On the
 * right: a template to start from, what it does, and its AI on one row (the AI, model, effort).
 * Instructions, the computer it works on, apps, skills and who it answers are under More options,
 * whose closed row says what's picked. "Bring one in" and "Make it a team" sit by Create.
 */
/** `onCreated`: hand the new agent back (to a team being built, say) instead of opening its page. `nodeId`: start on this device. `template`: start from one of the agent templates. */
export function CreateAgent({ nodes, onClose, onCreated, nodeId: startOn, bringIn, template: startTemplate, initialName, initialLook }: { nodes: NodeInfo[]; onClose: () => void; onCreated?: (agent: Agent) => void; nodeId?: string; bringIn?: boolean; template?: AgentTypeId; /** from the New agent sheet: what was already picked there */ initialName?: string; initialLook?: GhostAppearance }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const people = useStore((s) => s.members);
  const inviteOn = useFeature("invite");
  const [view, setView] = useState<View>(bringIn ? "external" : "form");
  const bodyRef = useRef<HTMLDivElement>(null);
  const phone = useNarrow("(max-width: 767px)");
  // phones: a field the keyboard would cover scrolls up into view once the keyboard has opened
  useEffect(() => {
    const body = bodyRef.current;
    if (!body?.addEventListener) return;
    const onFocus = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el?.matches?.("input, textarea, select") || !touchFirst()) return;
      setTimeout(() => el.scrollIntoView?.({ block: "center", behavior: "smooth" }), 300);
    };
    body.addEventListener("focusin", onFocus);
    return () => body.removeEventListener("focusin", onFocus);
  }, []);
  useEffect(() => {
    const body = bodyRef.current;
    body?.scrollTo?.({ top: 0 });
    // phones: the heading, so no keyboard opens over the sheet (and a stray tap can't type over the name)
    const touch = touchFirst();
    const first = (!touch && body?.querySelector<HTMLElement>("input")) || body?.querySelector<HTMLElement>("h1");
    first?.focus({ preventScroll: true });
    // the suggested name is selected, so typing replaces it
    if (view === "form" && !touch) (first as Partial<HTMLInputElement> | undefined)?.select?.();
  }, [view]);

  // who it is
  const [name, setName] = useState(() => initialName?.trim() || suggestName(agents));
  // only what was typed; without it a free handle follows the name
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [templateId, setTemplateId] = useState<AgentTypeId | null>(null);
  // every new agent gets a bubble of its own: round, in one of the bubble colours
  const [appearance, setAppearance] = useState<GhostAppearance>(() => initialLook ?? newBubbleLook());

  // which AI and computer
  const [defaults, setDefaults] = useState<AgentDefaults | null | "error">(null);
  const [harness, setHarness] = useState("claude-code");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const usable = usableDevices(nodes);
  const [nodeId, setNodeId] = useState((startOn && usable.some((n) => n.id === startOn) ? startOn : null) ?? usable.find((n) => n.online)?.id ?? usable[0]?.id ?? "");
  // a device picked already (its page's "Add an agent here") starts on a computer there
  const [place, setPlace] = useState<Place>(() => (startOn ? defaultComputer(nodes.find((n) => n.id === nodeId), computers) : { kind: "auto" }));
  const createdVm = useRef<{ id: string; nodeId: string } | null>(null);
  const [invite, setInvite] = useState(false);
  // the AI was picked here: send it, rather than leave it to the defaults
  const aiPicked = useRef(false);
  const placePicked = useRef(false);
  // a device picked here goes with it, even when the rest comes from your defaults
  const devicePicked = useRef(false);
  // devices can arrive after the dialog opened with none: settle on one then
  const firstUsable = usable.find((n) => n.online)?.id ?? usable[0]?.id;
  useEffect(() => {
    if (nodeId || !firstUsable) return;
    setNodeId(firstUsable);
    if (place.kind !== "auto") setPlace(defaultComputer(nodes.find((n) => n.id === firstUsable), computers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUsable]);
  useEffect(() => {
    let live = true;
    // no default AI to use: start on one that's signed in on its device
    const startSignedIn = () => {
      const on = nodes.find((n) => n.id === nodeId);
      const pick = preferSignedIn((on?.harnesses ?? []).map((h) => h.id), (id) => accountsSignedIn(on?.harnesses?.find((h) => h.id === id)?.accounts));
      if (pick && !aiPicked.current) setHarness(pick);
    };
    // without defaults, it works where the device offers (its own computer there, usually)
    const placeHere = (id: string) => {
      if (!placePicked.current) setPlace(defaultComputer(nodes.find((n) => n.id === id), computers));
    };
    api<AgentDefaults>("GET", "/api/settings/agent-defaults").then(
      (d) => {
        if (!live) return;
        setDefaults(d);
        if (defaultsNeedPicking(d)) {
          aiPicked.current = true;
          startSignedIn();
        }
        if (!aiPicked.current) {
          // the defaults' AI isn't installed on this device while another is: start on one that is
          const on = nodes.find((n) => n.id === nodeId);
          const here = (on?.harnesses ?? []).map((h) => h.id);
          if (d.harness && here.length && !here.includes(d.harness)) startSignedIn();
          else {
            if (d.harness) setHarness(d.harness);
            if (d.model) setModel(d.model);
          }
        }
        if (d.nodeId && !startOn && usable.some((n) => n.id === d.nodeId)) setNodeId(d.nodeId);
      },
      () => {
        if (!live) return;
        // an older hub has no defaults: pick here instead
        setDefaults("error");
        aiPicked.current = true;
        startSignedIn();
        placeHere(nodeId);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const choosePlace = (choice: Place) => {
    placePicked.current = true;
    setPlace(choice);
    if (choice.kind === "existing") {
      const c = computers.find((c) => c.id === choice.id);
      if (c?.kind === "vm" && c.nodeId && usable.some((n) => n.id === c.nodeId)) setNodeId(c.nodeId);
    }
  };
  const pickAi = (patch: { harness?: string; model?: string; effort?: string }) => {
    aiPicked.current = true;
    if (patch.harness !== undefined && patch.harness !== harness) {
      setHarness(patch.harness);
      // a model belongs to its harness: the new one starts on its own default
      setModel("");
      setEffort("");
    }
    if (patch.model !== undefined) setModel(patch.model);
    if (patch.effort !== undefined) setEffort(patch.effort);
  };

  // instructions, computer, apps, skills and who can ask it stay folded until asked for
  const [moreOpen, setMoreOpen] = useState(false);
  const [respondTo, setRespondTo] = useState<RespondTo>("me");
  const [respondPeople, setRespondPeople] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [pickedApps, setPickedApps] = useState<string[]>([]);
  const [pickedSkills, setPickedSkills] = useState<string[]>([]);
  useEffect(() => {
    api<Connector[]>("GET", "/api/connectors").then((c) => setConnectors(Array.isArray(c) ? c : []), () => setConnectors([]));
    api<Skill[]>("GET", "/api/skills").then((s) => setSkills(Array.isArray(s) ? s : []), () => setSkills([]));
  }, []);

  /** A template fills in what it does and turns on the apps of its kind that are already here. */
  const applyTemplate = (t: AgentType, list = connectors) => {
    setTemplateId(t.id);
    setRole(t.role.replace(/[.\s]+$/, "").slice(0, 60));
    const wanted = new Set(t.apps.map((a) => START_APPS[a]?.catalogId).filter(Boolean));
    setPickedApps((list ?? []).filter((c) => !c.allAgents && c.catalogId && wanted.has(c.catalogId)).map((c) => c.id));
  };
  const templated = useRef(false);
  useEffect(() => {
    if (templated.current || !startTemplate || connectors === null) return;
    templated.current = true;
    const t = AGENT_TYPES.find((x) => x.id === startTemplate);
    if (t) applyTemplate(t, connectors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors, startTemplate]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const node = nodes.find((n) => n.id === nodeId);
  // installed here just now: counts before the device's next report arrives
  const [justInstalled, setJustInstalled] = useState<string[]>([]);
  const installed = new Set([...(node?.harnesses ?? []).map((h) => h.id), ...justInstalled.filter((x) => x.startsWith(`${nodeId}:`)).map((x) => x.slice(nodeId.length + 1))]);
  const declared = [...new Map(usable.flatMap((n) => (n.harnesses ?? []).filter((h) => h.id.startsWith("acp:")).map((h) => [h.id, h] as const))).values()];
  const harnesses = [
    ...HARNESSES.filter((h) => h.id !== "custom"),
    ...declared.map((h) => ({ id: h.id, label: h.id.slice(4), protocol: "acp" as const, note: "Available on a connected device", binary: "" })),
    HARNESSES.find((h) => h.id === "custom")!,
  ];
  // every AI it can run with, the ones installed on the device first; the rest say "Not installed" and offer Install
  const notInstalled = (id: string) => !!node?.harnesses && !installed.has(id);
  const runnable = harnesses.filter((h) => h.protocol !== "mcp").sort((a, b) => Number(notInstalled(a.id)) - Number(notInstalled(b.id)));
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const installHere = async (id: string) => {
    if (!node || installing) return;
    setInstalling(id);
    setInstallError(null);
    try {
      await api("POST", `/api/nodes/${node.id}/install`, { harness: id });
      setJustInstalled((list) => [...list, `${node.id}:${id}`]);
      await api("POST", `/api/nodes/${node.id}/refresh`).catch(() => {});
    } catch (e) {
      setInstallError((e as Error).message);
    } finally {
      setInstalling(null);
    }
  };
  const { advanced: pickWhere } = useComputerMode();
  const useDefaults = place.kind === "auto" && !invite && defaults !== null && defaults !== "error";
  const selectedHarness = harnesses.find((h) => h.id === harness) ?? harnesses[0];
  const external = invite || selectedHarness.protocol === "mcp";
  // the AI picked is known not to be signed in on its device: say so, with Sign in, before it's made
  const signedInOn = (id: string) => accountsSignedIn(node?.harnesses?.find((h) => h.id === id)?.accounts);
  const signInFirst: AgentSignIn | null = node?.mine && !external && signedInOn(selectedHarness.id) === false ? { harness: selectedHarness.id, where: node.name, nodeId: node.id, computerId: null, account: "default" } : null;
  const noneSignedIn = !!signInFirst && !(node?.harnesses ?? []).some((h) => accountsSignedIn(h.accounts) !== false);
  const catalog = node?.harnesses?.find((h) => h.id === harness);
  const models = catalog?.models ?? [];
  const efforts = effortsFor(catalog, model);

  const cleanName = name.trim();
  const typedHandle = slug(handle);
  const finalHandle = typedHandle || autoHandle(cleanName, agents.map((a) => a.handle));
  const look = appearance;
  // one short line under the field it is about
  const problem = nameProblem(cleanName, typedHandle, agents);
  const validName = !!cleanName && !problem;

  const others = people.filter((p) => p.id !== me?.user.id);
  const togglePick = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const appNames = (connectors ?? []).filter((c) => c.allAgents || pickedApps.includes(c.id)).map((c) => c.name);

  const finish = () => {
    if (created && onCreated) return onCreated(created);
    onClose();
    if (created) go({ view: "agents", agentId: created.id, tab: "connect" });
  };
  // a team instead: the same flow the sidebar's plus opens
  const makeTeam = () => {
    onClose();
    useStore.setState({ channelBrowser: { sectionId: null, create: true } });
  };
  const startInvite = () => {
    setInvite(true);
    setView("form");
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
          ...(effort && !external ? { effort } : {}),
          ...(inviteOn || others.length ? { respondTo, ...(respondTo === "people" ? { respondPeople } : {}) } : {}),
        };
        const common = { name: cleanName, handle: finalHandle, instructions };
        if (useDefaults) {
          // the AI picked here, the rest placed by your defaults
          const ai = aiPicked.current && !external ? { harness, ...(model.trim() ? { model: model.trim() } : {}) } : {};
          const where = devicePicked.current && nodeId && !external ? { nodeId } : {};
          a = await api<Agent>("POST", "/api/agents", { ...common, ...ai, ...where, useDefaults: true, settings });
        } else {
          const computer: ComputerChoice = place.kind === "auto" ? { kind: "later" } : place;
          const computerId = external ? null : await resolveComputer(computer, nodeId, cleanName);
          // Keep a newly created computer selected if creating the agent needs a retry.
          if (computerId && (computer.kind === "vm" || computer.kind === "screen")) setPlace({ kind: "existing", id: computerId });
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
        // apps and skills picked here; ones on for all agents already include it
        const agentId = a.id;
        await Promise.all([
          ...pickedApps.flatMap((id) => {
            const c = connectors?.find((x) => x.id === id);
            return c && !c.allAgents ? [api("PUT", `/api/connectors/${id}/agents/${agentId}`).catch(() => {})] : [];
          }),
          ...pickedSkills.flatMap((id) => (skills?.find((x) => x.id === id)?.allAgents ? [] : [api("PUT", `/api/skills/${id}/agents/${agentId}`).catch(() => {})])),
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
        // straight to its chat, where it has already said hello
        await openDm(a.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = defaults && defaults !== "error" ? defaultsSummary(defaults, nodes, !pickWhere) : null;
  const failed = error ? `${error}${created ? " Your agent was created. Retry to finish its invitation." : ""}` : null;
  const handleProblem = problem && typedHandle ? problem : null;
  const underName = handleProblem ? null : problem;
  const width = view === "look" ? "sm:max-w-[920px]!" : view === "form" ? "sm:max-w-[880px]!" : "sm:max-w-[460px]!";
  const placeLine = place.kind === "auto" ? (summary?.computer ?? "Automatic") : place.kind === "vm" ? "Its own computer" : place.kind === "screen" ? "Your screen" : place.kind === "headless" ? "No computer" : place.kind === "later" ? "Computer later" : (computers.find((c) => c.id === place.id)?.name ?? "Computer");
  const askable = inviteOn || others.length > 0;
  const title = invite ? "Invite an agent" : "New agent";
  // phones: close on the left and the title centred, like a sheet; desktop: title, then close on the right
  const header = phone ? (
    <div className="grid grid-cols-[32px_minmax(0,1fr)_32px] items-center px-3 pt-3">
      <button type="button" onClick={onClose} disabled={busy} className="circle circle-sm border-0! text-muted hover:text-ink" aria-label="Close">
        <X size={18} />
      </button>
      <h1 tabIndex={-1} className="truncate text-center text-[16px] font-semibold leading-6 outline-none">
        {title}
      </h1>
    </div>
  ) : (
    <div className="flex items-center gap-3 px-6 pt-5">
      <h1 tabIndex={-1} className="t-title min-w-0 flex-1 truncate outline-none">
        {title}
      </h1>
      <button type="button" onClick={onClose} disabled={busy} className="circle circle-sm border-0! bg-chip text-muted hover:text-ink" aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
  // More options' closed row: what's picked inside, in a line
  const moreSummary = [
    instructions.trim() ? "Instructions" : null,
    !invite && selectedHarness.protocol !== "mcp" ? `Computer: ${placeLine}` : null,
    appNames.length ? `${appNames.length} ${appNames.length === 1 ? "app" : "apps"}` : null,
    pickedSkills.length ? `${pickedSkills.length} ${pickedSkills.length === 1 ? "skill" : "skills"}` : null,
    askable ? { me: "Only me", anyone: "Anyone", people: "Picked people" }[respondTo] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Modal title="New agent" label="New agent" onClose={busy ? () => {} : onClose} headerless className={cx("sm:rounded-[18px]! transition-[max-width] duration-300 ease-[cubic-bezier(.165,.84,.44,1)] motion-reduce:transition-none", width)} contentClassName="p-0!">
      <div ref={bodyRef}>
        {view === "form" && (
          <form
            className="flex flex-col md:h-[min(600px,calc(92vh-2px))] md:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {/* phones: the title and close sit on top of the sheet */}
            {phone && header}
            {/* who it is: its bubble, name, handle and shuffle, then its look */}
            <aside className="flex shrink-0 flex-col items-center border-line bg-card/50 px-4 pb-4 pt-4 md:w-[324px] md:overflow-y-auto md:border-r md:px-5 md:pb-5 md:pt-6">
              {/* phones: a small preview that opens the bigger look editor; on a desktop a click gives it another look */}
              <button type="button" disabled={busy || !!created} onClick={() => (phone ? setView("look") : setAppearance(shuffleBubbleLook()))} aria-label="Change its look" title={phone ? "Change its look" : "Shuffle its look"} className="rounded-[20px] outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none">
                <Ghost look={look} seed={finalHandle} size={phone ? 64 : 104} trackPointer={!phone} label="" />
              </button>
              <fieldset disabled={busy || !!created} className="w-full min-w-0">
                <div className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-1 pt-1.5">
                  <span aria-hidden />
                  <input
                    aria-label="Name"
                    placeholder="Name"
                    maxLength={80}
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="off"
                    className="w-full min-w-0 bg-transparent text-center text-[19px] leading-7 font-[650] outline-none placeholder:text-faint border-b border-transparent focus-visible:border-line2"
                  />
                  <button type="button" onClick={() => setAppearance(shuffleBubbleLook())} aria-label="Shuffle its look" title="Shuffle its look" className="grid size-7 place-items-center rounded-full text-muted outline-none hover:bg-hover hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/40">
                    <Shuffle size={15} aria-hidden />
                  </button>
                </div>
                <label className="mx-auto flex w-fit max-w-full items-center text-[12px] text-muted">
                  <span aria-hidden>@</span>
                  <input
                    value={handle}
                    // loose while typing (a dash can be followed by more); the handle used is its tidy form
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32))}
                    placeholder={finalHandle}
                    aria-label="Handle"
                    aria-invalid={!!handleProblem}
                    size={Math.max(4, (handle || finalHandle).length)}
                    className="min-w-0 bg-transparent outline-none placeholder:text-muted focus:text-ink"
                  />
                </label>
                {(underName || handleProblem) && (
                  <p role="alert" className="pt-1 text-center text-[13px] text-bad">
                    {underName ?? handleProblem}
                  </p>
                )}
                {/* its look, one row per kind: every choice in view, a long row scrolls sideways */}
                <div className="mt-3 w-full">
                  <LookRows value={look} onChange={setAppearance} name={finalHandle} />
                </div>
              </fieldset>
            </aside>

            {/* what it does and what it works with */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {!phone && header}
              <fieldset disabled={busy || !!created} className="min-h-0 min-w-0 flex-1 space-y-4 px-4 pb-5 pt-3 sm:px-6 md:overflow-y-auto">
                {!invite && (
                  <section className="space-y-1.5">
                    <span className={LABEL}>Start from</span>
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Start from">
                      {AGENT_TYPES.filter((t) => t.id !== "other").map((t) => (
                        <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} onClick={() => applyTemplate(t)} className={cx(TILE, "h-8 gap-1.5 rounded-full px-3", templateId === t.id ? TILE_ON : TILE_OFF)}>
                          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted" aria-hidden>
                            <path d={t.icon} />
                          </svg>
                          <span className="min-w-0 truncate text-[13px] font-medium">{t.name.replace(/ assistant$/, "")}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                <label className="block space-y-1.5">
                  <span className={LABEL}>What it does</span>
                  <Input maxLength={60} value={role} onChange={(e) => (setRole(e.target.value), setTemplateId(null))} aria-label="What it does" placeholder="Keeps my inbox in order" className="h-10!" />
                </label>

                {invite ? (
                  <div className="space-y-1.5">
                    <span className={LABEL}>Joins from</span>
                    <HarnessGrid list={harnesses} harness={harness} onPick={setHarness} label="Agent harness" />
                  </div>
                ) : (
                  <section className="space-y-2">
                    <span className={LABEL}>Harness</span>
                    {/* one row: which harness, its model and how hard it thinks */}
                    <div className="na-ai">
                      <AiPicker list={runnable.map((h) => ({ id: h.id, label: h.label, notInstalled: notInstalled(h.id), signedOut: !!node?.mine && signedInOn(h.id) === false }))} value={harness} onPick={(id) => pickAi({ harness: id })} />
                      <label className={cx(SELECT, "flex items-center gap-1.5")}>
                        <span className="shrink-0 text-muted">Model</span>
                        {models.length ? (
                          <select aria-label="Model" value={model} onChange={(e) => pickAi({ model: e.target.value })} className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent font-medium outline-none">
                            <option value="">Auto</option>
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {prettyModel(m.label)}
                              </option>
                            ))}
                            {model && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
                          </select>
                        ) : (
                          <input aria-label="Model" value={model} onChange={(e) => pickAi({ model: e.target.value })} placeholder="Auto" className="min-w-0 flex-1 bg-transparent font-medium outline-none placeholder:text-ink" />
                        )}
                        {models.length > 0 && <ChevronDown size={14} className="pointer-events-none shrink-0 text-muted" aria-hidden />}
                      </label>
                      <label className={cx(SELECT, "flex items-center gap-1.5")}>
                        <span className="shrink-0 text-muted">Effort</span>
                        <select aria-label="Effort" value={effort} onChange={(e) => pickAi({ effort: e.target.value })} className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent font-medium outline-none">
                          {["", ...efforts].map((x) => (
                            <option key={x || "default"} value={x}>
                              {x ? effortName(x) : "Auto"}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="pointer-events-none shrink-0 text-muted" aria-hidden />
                      </label>
                    </div>
                    {node && notInstalled(harness) && selectedHarness.protocol !== "mcp" && (
                      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-card px-3.5 py-2.5 text-[13px]">
                        <span className="min-w-0 flex-1">{installError ?? `${selectedHarness.label} isn't installed on ${node.name}.`}</span>
                        <Button type="button" size="sm" disabled={!!installing || !node.online} onClick={() => void installHere(harness)}>
                          {installing === harness ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                          {installing === harness ? "Installing…" : "Install"}
                        </Button>
                      </div>
                    )}
                    {signInFirst && !notInstalled(harness) && (
                      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-card px-3.5 py-2.5 text-[13px]">
                        <span className="min-w-0 flex-1">{noneSignedIn ? `No AI is signed in on ${signInFirst.where} yet.` : `${harnessLabel(signInFirst.harness)} isn't signed in on ${signInFirst.where}.`}</span>
                        <HarnessSignInButton signIn={signInFirst} />
                      </div>
                    )}
                  </section>
                )}

                {/* the rest, folded: its closed row says what's picked */}
                <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)} className="na-more">
                  <ChevronRight size={15} className={cx("shrink-0 text-muted transition-transform duration-200", moreOpen && "rotate-90")} aria-hidden />
                  <span className="shrink-0">More options</span>
                  {!moreOpen && <span className="na-more-sum">{moreSummary}</span>}
                </button>

                {moreOpen && (
                  <div className="na-opts space-y-4">
                    <label className="block space-y-1.5">
                      <span className={LABEL}>Instructions</span>
                      <Textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Instructions" placeholder="How it should work, what to ask first, what to leave alone" />
                    </label>

                    {!invite && selectedHarness.protocol !== "mcp" && (
                      <PlacePicker value={place} onChange={choosePlace} node={node} nodes={nodes} usable={usable} nodeId={nodeId} onNode={(id) => ((devicePicked.current = true), setNodeId(id), choosePlace(place.kind === "auto" ? place : defaultComputer(nodes.find((n) => n.id === id), computers)))} auto={defaults !== "error" ? (summary?.computer ?? "Automatic") : null} advanced={pickWhere} />
                    )}
                    {!invite && place.kind !== "auto" && node && !node.online && (
                      <p role="status" className="text-xs text-warn">
                        {node.name} is offline. It answers once {node.name} reconnects.
                      </p>
                    )}

                    <section className="space-y-2">
                      <span className={LABEL}>Apps</span>
                      <div className="flex flex-wrap gap-1.5">
                        {connectors === null && <span className="text-xs text-muted">Loading…</span>}
                        {connectors?.map((c) =>
                          c.allAgents ? (
                            <span key={c.id} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-chip pl-1.5 pr-2.5 text-[13px] font-medium" title="On for all agents">
                              <AppTile name={c.name} size={20} /> {c.name}
                            </span>
                          ) : (
                            <Chip key={c.id} small on={pickedApps.includes(c.id)} onClick={() => setPickedApps(togglePick(pickedApps, c.id))} icon={<AppTile name={c.name} size={20} />}>
                              {c.name}
                            </Chip>
                          ),
                        )}
                        <AddChip onClick={() => (onClose(), go({ view: "connectors" }))} />
                      </div>
                      {!canUseConnectedApps(selectedHarness) && <p className="text-xs text-muted">{selectedHarness.label} can't use apps yet.</p>}
                    </section>
                    <section className="space-y-2">
                      <span className={LABEL}>Skills</span>
                      <div className="flex flex-wrap gap-1.5">
                        {skills === null && <span className="text-xs text-muted">Loading…</span>}
                        {skills?.map((sk) =>
                          sk.allAgents ? (
                            <span key={sk.id} className="inline-flex h-8 items-center gap-1 rounded-lg bg-chip px-2.5 text-[13px] font-medium" title="On for all agents">
                              <Check size={13} /> {sk.name}
                            </span>
                          ) : (
                            <Chip key={sk.id} small on={pickedSkills.includes(sk.id)} onClick={() => setPickedSkills(togglePick(pickedSkills, sk.id))} title={sk.description}>
                              {sk.name}
                            </Chip>
                          ),
                        )}
                        <AddChip onClick={() => (onClose(), go({ view: "skills" }))} />
                      </div>
                    </section>
                    {askable && (
                      <section className="space-y-2">
                        <span className={LABEL}>Who can ask it</span>
                        <RespondPicker value={respondTo} onChange={setRespondTo} />
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
                            <p className="text-xs text-muted">Nobody else is here yet.</p>
                          ))}
                      </section>
                    )}
                  </div>
                )}
              </fieldset>

              <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-5 py-3 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
                <div className="-ml-2.5 flex min-w-0 flex-1 flex-wrap gap-x-1">
                  {invite ? (
                    <button type="button" className={QUIET} disabled={busy || !!created} onClick={() => setInvite(false)}>
                      New agent instead
                    </button>
                  ) : (
                    <>
                      {!onCreated && (
                        <button type="button" className={QUIET} disabled={busy || !!created} onClick={makeTeam}>
                          Make it a team
                        </button>
                      )}
                      <button type="button" className={QUIET} disabled={busy || !!created} onClick={() => setView("external")}>
                        Bring one in
                      </button>
                    </>
                  )}
                </div>
                {failed && (
                  <p role="alert" className="w-full text-sm text-bad sm:order-none sm:w-auto">
                    {failed}
                  </p>
                )}
                <Button type="submit" variant="primary" disabled={busy || (!created && (!validName || (place.kind === "auto" && !invite && defaults === null)))} className="h-10! min-w-[120px] text-[15px]">
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {external ? "Create invitation" : "Create"}
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
          <div className="p-5 sm:p-6 space-y-4">
            <BackHeader title="Bring one in" onBack={() => setView("form")} />
            <div className="rounded-[12px] bg-card overflow-hidden">
              <button type="button" onClick={startInvite} className={CHOICE}>
                <UserPlus size={17} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">Invite an agent</span>
                <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />
              </button>
              <button type="button" onClick={() => setView("discover")} className={CHOICE}>
                <Search size={17} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">Find on a device</span>
                <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />
              </button>
            </div>
          </div>
        )}

        {view === "discover" && (
          <div className="p-5 sm:p-6 space-y-4">
            <BackHeader title="Find an agent" onBack={() => setView("external")} />
            <ImportAgent nodes={nodes} onClose={onClose} onInvite={startInvite} />
          </div>
        )}

        {view === "invitation" && token && (
          <div className="p-5 sm:p-6 space-y-5">
            <div className="flex items-center gap-3.5">
              <Ghost look={look} size={56} trackPointer />
              <h1 tabIndex={-1} className="min-w-0 text-[19px] font-semibold leading-[26px] outline-none">
                Invite {cleanName} to Bubble AI
              </h1>
            </div>
            <ConnectionInstructions token={token} harness={harness} />
            <div className="flex justify-end gap-2">
              {!onCreated && (
                <Button type="button" variant="ghost" onClick={finish}>
                  Close
                </Button>
              )}
              <Button type="button" variant="primary" onClick={finish}>
                {onCreated ? "Back to team" : "Open agent"} <ArrowRight size={16} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Only me / Anyone / Picked people: who an agent answers. Also on the agent's page. */
export function RespondPicker({ value, onChange, disabled }: { value: RespondTo; onChange: (v: RespondTo) => void; disabled?: boolean }) {
  return (
    <div className="flex rounded-[10px] bg-chip p-0.5" role="radiogroup" aria-label="Who it answers">
      {(
        [
          ["me", "Only me"],
          ["anyone", "Anyone"],
          ["people", "Picked people"],
        ] as const
      ).map(([v, label]) => (
        <button key={v} type="button" role="radio" disabled={disabled} aria-checked={value === v} onClick={() => onChange(v)} className={cx("h-8 flex-1 whitespace-nowrap rounded-[8px] px-2 text-[13px] font-medium transition-colors", value === v ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Where a new agent works, as tiles: Automatic (your defaults: the shared computer in Simple), its
 * own computer, your screen, or none, and which device it runs on. In Advanced, also the
 * computers already here.
 */
function PlacePicker({ value, onChange, node, nodes, usable, nodeId, onNode, auto, advanced }: { value: Place; onChange: (p: Place) => void; node: NodeInfo | undefined; nodes: NodeInfo[]; usable: NodeInfo[]; nodeId: string; onNode: (id: string) => void; auto: string | null; advanced: boolean }) {
  const computers = useStore((s) => s.computers);
  const screenExists = computers.some((c) => c.kind === "device" && c.nodeId === node?.id);
  const same = (p: Place) => value.kind === p.kind && (p.kind !== "existing" || (value.kind === "existing" && value.id === p.id));
  const tile = (p: Place, icon: React.ReactNode, title: string, sub?: string, disabled?: boolean) => (
    <button key={p.kind === "existing" ? p.id : p.kind} type="button" role="radio" aria-checked={same(p)} disabled={disabled} title={sub} onClick={() => onChange(p)} className={cx(TILE, "h-14", same(p) ? TILE_ON : TILE_OFF)}>
      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-chip text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        {sub && <span className="block truncate text-[11.5px] text-muted">{sub}</span>}
      </span>
    </button>
  );
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={cx(LABEL, "flex-1")}>Computer</span>
        {/* which device: for everyone, not only in Advanced (round 16, board 16c) */}
        {usable.length > 1 && (
          <select aria-label="Runs on" title="Runs on" value={nodeId} onChange={(e) => onNode(e.target.value)} className="h-8 rounded-[8px] border border-input bg-panel px-2 text-[12px]">
            {usable.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
                {n.online ? "" : " (offline)"}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Computer">
        {auto !== null &&
          (auto.endsWith(" directly")
            ? tile({ kind: "auto" }, <Laptop size={15} />, "This device", `Uses ${auto}`)
            : tile({ kind: "auto" }, <Users size={15} />, auto === "The shared computer" ? "Shared computer" : "Automatic", auto === "The shared computer" ? "With your other agents" : auto === "Automatic" ? "Your defaults" : auto))}
        {node && tile({ kind: "vm" }, <Monitor size={15} />, "Its own computer", node.capabilities?.vm.ok ? `A desktop on ${node.name}` : (node.capabilities?.vm.detail ?? "Connect the device to check"), !node.capabilities?.vm.ok)}
        {node?.mine && !screenExists && tile({ kind: "screen" }, <Laptop size={15} />, "My screen", node.capabilities?.screen.ok ? `Uses ${node.name}` : (node.capabilities?.screen.detail ?? "Off"), node.capabilities?.screen.ok !== true)}
        {advanced &&
          computers.map((c) => tile({ kind: "existing", id: c.id }, c.kind === "orgo" ? <Cloud size={15} /> : c.kind === "vm" ? <Monitor size={15} /> : <Laptop size={15} />, c.name, computerKindLabel(c, nodes)))}
        {tile({ kind: "headless" }, <MessageSquare size={15} />, "No computer", "Chat and files only")}
      </div>
    </section>
  );
}

function Chip({ on, onClick, children, title, small, icon }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string; small?: boolean; icon?: React.ReactNode }) {
  return (
    <button type="button" role={small ? undefined : "radio"} aria-checked={small ? undefined : on} aria-pressed={small ? on : undefined} onClick={onClick} title={title} className={cx("inline-flex items-center gap-1.5 border font-medium transition-colors duration-150", small ? "h-8 rounded-lg text-[13px]" : "h-8 rounded-[8px] px-3.5 text-[13px]", small && (icon ? "pl-1.5 pr-2.5" : "px-2.5"), on ? "bg-ink text-bg border-ink" : "bg-panel text-ink border-line hover:bg-hover")}>
      {icon}
      {children}
    </button>
  );
}

function AddChip({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-8 px-2.5 rounded-lg border border-dashed border-line text-[13px] font-medium text-muted hover:text-ink inline-flex items-center gap-1">
      <Plus size={13} /> Add
    </button>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={onBack} className="circle circle-sm border-0! bg-chip text-muted hover:text-ink" aria-label="Back">
        <ArrowLeft size={16} />
      </button>
      <h1 tabIndex={-1} className="min-w-0 truncate text-[17px] font-semibold leading-6 outline-none">
        {title}
      </h1>
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
      <div className="rounded-[12px] bg-card p-4 space-y-3 text-sm">
        <p className="font-medium">No saved setups found yet</p>
        <p className="text-muted">
          {usableDevices(nodes).some((n) => n.online) ? "Bubble AI checks known folders on your connected devices." : "Connect a device first."}
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
      <div className="flex justify-end">
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
        <div className="flex items-center gap-3 rounded-[12px] bg-card px-3.5 py-2.5 text-sm">
          <span className="flex-1">{fresh.length} agents found</span>
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
      <div className="rounded-[12px] bg-card overflow-hidden">
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
                    x.d.hasSoul && "has a personality",
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
              await openDm(a.id);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Handle"
            hint={pick.d.path}
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
