import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Apple,
  AudioLines,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  Code2,
  Download,
  FileText,
  Ghost,
  GitPullRequest,
  HardDrive,
  Image,
  Laptop,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  MonitorSmartphone,
  MousePointerClick,
  NotebookText,
  Palette,
  Plug,
  Presentation,
  Rocket,
  Search,
  Share2,
  Sheet,
  Shield,
  SquareTerminal,
  UserPlus,
  X,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import {
  CONNECTOR_CATALOG,
  FEATURE_INFO,
  FEATURE_KEYS,
  POPULAR_APPS,
  SKILL_CATALOG,
  UNLISTED_FEATURES,
  appCategory,
  catalogSkill,
  shelfSummary,
  skillSlug,
  skillTitle,
  trustLabel,
  type AppCategory,
  type CatalogConnector,
  type CatalogSkill,
  type Connector,
  type DeviceShelf,
  type FeatureKey,
  type ShelfItem,
  type Skill,
  type SignInOption,
  type StoreApp,
  type StoreSkill,
  type TeamTemplate,
} from "@bubble-ai/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { setFeatures, useFeatures } from "../features.ts";
import { go, href, SETTINGS_CLOSING, type MarketSection, type Route } from "../router.ts";
import { useInPopup } from "../components/SettingsDialog.tsx";
import { Button, Loader, Menu, cx } from "../components/ui.tsx";
import { AppTile, Dlg, FactRow, Item, ItemHead, NeedDot, Panel, RemoveBtn, Rows, TextBtn, Tile, matchWords, queryWords, sectionWord, type AddSection } from "../components/MarketParts.tsx";
import "../round11-settings.css";
import { useThisMacRows, isDesktopMac } from "../components/ThisMacRows.tsx";
import { ConnectRow, Done, FilterChip, GoPill, LineTile, LogoStack, MAIN_CHIPS, MORE_CHIPS, TOPICS, appTopics, connectedLogos, thisComputer, useAgentPicks, type Topic } from "../components/ConnectParts.tsx";
import { CatalogIcon } from "../components/ShopParts.tsx";
import { PickApps, noAppsPicked } from "../components/ConnectCard.tsx";
import { ConnectorForm, registryCatalog } from "./ConnectorsView.tsx";
import { AppPage, ConnectSignIn, type AppItem } from "./AppPages.tsx";
import { SkillDetail, SkillEditor, SkillShare, StoreSkillDetail, skillOrigin, type Open } from "./SkillsView.tsx";
import { LAYER } from "../components/layers.ts";
import { useTemplates } from "../team/Templates.tsx";
import type { NodeInfo } from "./AgentSettings.tsx";
import { lazyView } from "../lazy.tsx";
import type { AgentTypeId } from "./onboarding/agentTypes.ts";
import { AgentCards, ShowAll, TeamCards, TeamSheet } from "./MarketTemplates.tsx";
import { AGENT_TEMPLATES, agentHit, teamHit } from "./marketTemplateData.ts";

// New agent is only needed once Use is pressed on an agent template
const CreateAgent = lazyView(() => import("./CreateAgent.tsx").then((m) => m.CreateAgent));

const HARNESS_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", hermes: "Hermes" };
const harnessName = (h: string) => HARNESS_NAMES[h] ?? h;

/** Bubble AI's own catalog sorted onto the store's shelves. */
const BUILT_IN_SHELF: Record<CatalogConnector["category"], AppCategory> = {
  Code: "Developer",
  "Chat & docs": "Docs and notes",
  "Work tracking": "Tasks",
  Data: "Data",
  "Web & browser": "Research",
  Payments: "Finance",
  Utilities: "Developer",
  "Cloud keys": "Developer",
};

/** Which section of the page an address opens at (the old Marketplace sections, #/connectors, #/skills, #/mods). */
const SECTION_OF: Record<MarketSection | "mods", AddSection | null> = { all: null, apps: "apps", skills: "skills", agents: null, teams: null, devices: "found", installed: "added", mods: "mods" };
const SECTION_TITLE: Record<AddSection, string> = { added: "Added", found: "Found on your computers", apps: "Apps", skills: "Skills", mods: "Mods" };

const MOD_ICON: Record<FeatureKey, LucideIcon> = {
  background: Bell,
  routines: Clock,
  teach: CircleDot,
  tasks: ListChecks,
  buddy: Ghost,
  invite: UserPlus,
  remoteDesktop: MonitorSmartphone,
  storage: HardDrive,
  code: SquareTerminal,
  apple: Apple,
};
/** A mod in a few words, for its row. */
const MOD_WORDS: Record<FeatureKey, string> = {
  background: "They check in first",
  routines: "Work on a timer",
  teach: "Show it once",
  tasks: "Hand out work",
  buddy: "Bubble on your desktop",
  invite: "Bring people in",
  remoteDesktop: "Reach your computers",
  storage: "Files on your drive",
  code: "Terminals, side by side",
  apple: "Messages, Calendar, Reminders",
};
/** Where a mod lives once it's on, for the note that says it's on: "Each agent, under More", "In Settings › Storage". */
export function modWhere(k: FeatureKey): string {
  const r = MOD_ROWS[k][0];
  if (r.value) return r.value;
  if (r.to?.view === "settings") return `In Settings › ${r.label}`;
  return `In ${r.label}`;
}

/** A mod's own settings, as rows on its page: where they live, and the way there. */
const MOD_ROWS: Record<FeatureKey, { label: string; value?: string; to?: Route }[]> = {
  background: [{ label: "Checks", value: "Each agent, under More" }],
  routines: [{ label: "Routines", value: "Each agent, under More" }],
  teach: [{ label: "Teach", value: "Each agent, under Knows" }],
  tasks: [{ label: "Tasks", to: { view: "tasks" } }],
  buddy: [{ label: "Where", value: "On your desktop" }],
  invite: [{ label: "People", to: { view: "settings", page: "people" } }],
  remoteDesktop: [{ label: "Computers", to: { view: "settings", page: "devices" } }],
  storage: [{ label: "Drives and folders", to: { view: "settings", page: "storage" } }],
  code: [{ label: "Code", to: { view: "code" } }],
  apple: [{ label: "Mac, iPhone and apps", to: { view: "settings", page: "apple" } }],
};

type SkillItem = { key: string; name: string; description: string; who: string; icon: ReactNode; bigIcon: ReactNode } & ({ library: CatalogSkill } | { store: StoreSkill });
type Pending = { device: DeviceShelf; item: ShelfItem };

/** The item whose page is open in place of the list. */
type Detail =
  | { kind: "app"; app: AppItem }
  | { kind: "connector"; id: string }
  | { kind: "skill"; open: Open; icon?: ReactNode }
  | { kind: "store"; skill: StoreSkill; icon: ReactNode }
  | { kind: "mod"; mod: FeatureKey }
  | { kind: "found"; device: DeviceShelf; item: ShelfItem };

/** One row of the pop-up, whatever it is. */
type RowDef = { key: string; tile: ReactNode; name: string; mark?: string; desc?: string; status?: ReactNode; action?: ReactNode; onOpen?: () => void; topics?: Topic[] };
/** A section of the pop-up: its title (and a note beside it), its rows two to a line, and how many show before "Show all". */
type Sec = { id: string; title: string; note?: string; rows: RowDef[]; loading?: boolean; limit?: number; head?: ReactNode; foot?: ReactNode; empty?: string; /** cards of its own in place of rows (Agents, Teams) */ cards?: ReactNode };

/** One from each maker in turn, so a short list shows a bit of everyone's. */
function takeTurns<T extends { who: string }>(list: T[]): T[] {
  const by = new Map<string, T[]>();
  for (const x of list) by.set(x.who, [...(by.get(x.who) ?? []), x]);
  const lanes = [...by.values()];
  const out: T[] = [];
  for (let i = 0; out.length < list.length; i++) for (const lane of lanes) if (lane[i]) out.push(lane[i]);
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A plain line icon for a skill, from what it's about. */
function skillIcon(text: string, size = 17): ReactNode {
  const t = text.toLowerCase();
  const pick: [RegExp, LucideIcon][] = [
    [/\b(xlsx|spreadsheet|sheets?|excel|csv)\b/, Sheet],
    [/\b(pptx|slides?|deck|presentation)\b/, Presentation],
    [/\b(pdf|docx|documents?|docs?|writ\w+)\b/, FileText],
    [/\b(design|art|theme|canvas|frontend|figma|brand|ui)\b/, Palette],
    [/\b(images?|gif|imagegen|screenshot)\b/, Image],
    [/\b(speech|transcribe|audio|voice)\b/, AudioLines],
    [/\b(deploy\w*|vercel|netlify|render|cloudflare|ship)\b/, Rocket],
    [/\b(security|threat|secure)\b/, Shield],
    [/\b(gh|github|pull request|pr|ci|review)\b/, GitPullRequest],
    [/\b(test\w*|playwright|browser|webapp)\b/, MousePointerClick],
    [/\b(research|search|arxiv|papers?)\b/, Search],
    [/\b(notion|notes?|knowledge|wiki|meeting)\b/, NotebookText],
    [/\b(comms|slack|messages?|email|chat)\b/, MessageSquare],
    [/\b(mcp|api|cli|code|aspnet|winui|jupyter|sdk)\b/, Code2],
  ];
  const I = pick.find(([re]) => re.test(t))?.[1] ?? Wand2;
  return <I size={size} strokeWidth={1.7} />;
}

/** How a shelf skill is known to Bubble AI once it's brought in. */
const deviceSkillId = (nodeId: string, i: ShelfItem) => `device:${nodeId}:${i.harness}:${i.key.split(":skill:")[1] ?? i.name}`;

/** A server a harness has, as something the connector form can fill in: its keys asked for, or a sign-in. */
function shelfConnector(nodeId: string, i: ShelfItem): CatalogConnector {
  // an Authorization header is a login: Bubble AI signs in itself instead (log in once, every agent gets it)
  const headers = (i.headers ?? []).filter((h) => h.toLowerCase() !== "authorization");
  const fields = [...(i.secrets ?? []), ...headers].map((k) => ({ key: k.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(), label: k, secret: true, hint: "Kept on the device; enter it here once." }));
  return {
    id: `device:${nodeId}:${i.harness}:${i.name}`,
    name: i.name,
    description: `From ${harnessName(i.harness)}.`,
    icon: "Plug",
    category: "Utilities",
    kind: i.transport === "http" ? "mcp-http" : "mcp-stdio",
    command: i.command,
    args: i.args,
    url: i.url,
    headers: Object.fromEntries(headers.map((h) => [h, `{{${h.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}}}`])),
    fields,
  };
}

/** Ready to bring in as it is: nothing secret left behind on the device. */
const readyAsIs = (i: ShelfItem) => i.kind === "mcp" && !(i.secrets ?? []).length && !(i.headers ?? []).some((h) => h.toLowerCase() !== "authorization");

/** An app has a sign-in that isn't done yet. */
const needsSignIn = (c: Connector) => !!c.auth?.required && !c.auth.signedIn;
const CONNECTING = "wisp.connecting";

const added = (label = "Added") => (
  <span role="img" aria-label={label} className="pr-1.5 text-muted">
    <Check size={14} aria-hidden />
  </span>
);

/**
 * Add: one page for apps (MCP servers from the MCP Registry and Bubble AI's own list), skills (Bubble AI's
 * library and public SKILL.md repos) and mods. One search over all of it; sections with tiny
 * headers (Added, Found on your computers, Apps, Skills, Mods), each a few rows of tile, name, a
 * few words and one action; and "Make or bring your own" last. A row's name opens the item's page.
 * It replaces the Marketplace, the Mods page, Connected apps and Skills, whose addresses open it
 * at the matching section.
 */
export function MarketplaceView({ section, app: appKey = null, onBack, embedded = false, forAgent }: { section: MarketSection | "mods"; /** the app whose page the address opens (#/marketplace/app/<key>) */ app?: string | null; onBack?: () => void; embedded?: boolean; /** opened from an agent's Can use: what is added goes to that agent alone */ forAgent?: string | null }) {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const inPopup = useInPopup();
  const forA = forAgent ? agents.find((a) => a.id === forAgent) : undefined;
  /** who gets what is added here: the agent this was opened for, or every agent */
  const who = forA ? { agentIds: [forA.id], allAgents: false } : { agentIds: [] as string[], allAgents: true };
  const features = useFeatures();
  const canEdit = !!me && me.role !== "guest";
  const isOwner = me?.role === "owner";
  const target = SECTION_OF[section];
  // a section picked in the side list shows on its own, in full; All (and the Mods address) shows every section
  const only = section !== "all" && section !== "mods" ? target : null;
  // in Settings the page stays where it is; on its own, each app's page has its own address
  const routed = !embedded;
  const [q, setQ] = useState("");
  // the sections showing every row (the one an address opened, and any "Show all" pressed), and whether "Make or bring your own" is unfolded
  const [expanded, setExpanded] = useState<string[]>(() => (target ? [target] : []));
  const [making, setMaking] = useState(false);
  // a topic chip (Productivity, Communication, the ones under More); the address keeps All, Apps, Skills, This Mac and Connected
  const [topic, setTopic] = useState<Topic | null>(() => (section === "mods" ? "mods" : null));
  const nextTopic = useRef<Topic | null>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [market, setMarket] = useState<{ q: string; entries: StoreApp[] | null; error: string | null }>({ q: "", entries: null, error: null });
  const [featured, setFeatured] = useState<StoreApp[]>([]);
  const [store, setStore] = useState<{ skills: StoreSkill[]; errors: string[] } | null>(null);
  const [shelves, setShelves] = useState<DeviceShelf[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // the item whose page is open (an app's comes from the address), and the dialogs on top
  const [local, setLocal] = useState<Detail | null>(null);
  // skills added from their row stay where they were, marked added, until the page is opened again
  const [kept, setKept] = useState<string[]>([]);
  // an app linked to by its address that isn't among the featured ones or the last search
  const [linked, setLinked] = useState<StoreApp | null>(null);
  // coming here from another page (an "Add it" link, the menu) opens the list, not the last item looked at;
  // closing Settings on top of an item (App's closePop says so first) keeps it open
  useEffect(() => {
    let closing = false;
    const close = () => (closing = true);
    const arrived = () => {
      // Settings opening over this page leaves it as it is
      if (location.hash.startsWith("#/settings")) return;
      if (!closing) setLocal(null);
      closing = false;
    };
    window.addEventListener(SETTINGS_CLOSING, close);
    window.addEventListener("hashchange", arrived);
    return () => {
      window.removeEventListener(SETTINGS_CLOSING, close);
      window.removeEventListener("hashchange", arrived);
    };
  }, []);
  const [form, setForm] = useState<{ entry?: CatalogConnector; existing?: Connector; presetEnv?: Record<string, string>; title?: string } | null>(null);
  const [signInFor, setSignInFor] = useState<string | null>(null);
  // catalog apps with one-click sign-in: whether it works from this address
  const [signInOptions, setSignInOptions] = useState<Record<string, SignInOption>>({});
  const [signInEntry, setSignInEntry] = useState<CatalogConnector | null>(null);
  const [sharing, setSharing] = useState<Skill | "import" | "pick" | null>(null);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  // what is being added right now: a row's key, or "n of m" while everything found comes in
  const [adding, setAdding] = useState<string | null>(null);
  const [bringing, setBringing] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [modOn, setModOn] = useState<FeatureKey | null>(null);
  // Agents and Teams (round 12): New agent from a template, a team's sheet, and the builder with a team loaded
  const [agentFrom, setAgentFrom] = useState<AgentTypeId | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [teamOpen, setTeamOpen] = useState<TeamTemplate | null>(null);
  const teamTemplates = useTemplates();
  const [signedIn] = useState(() => new URLSearchParams(location.search).get("signin"));
  // an old address scrolls to its section as the lists arrive, until the person scrolls or types
  const auto = useRef(true);
  useEffect(() => {
    if (signedIn) history.replaceState(null, "", location.pathname + location.hash);
  }, [signedIn]);

  const loadConnectors = () => api<Connector[]>("GET", "/api/connectors").then((c) => (setConnectors(c), c), (e) => (setConnectors([]), setError((e as Error).message), [] as Connector[]));
  const loadSkills = () => api<Skill[]>("GET", "/api/skills").then((s) => (setSkills(s), s), () => (setSkills([]), [] as Skill[]));
  const loadShelves = () => (canEdit ? api<DeviceShelf[]>("GET", "/api/shelf").then(setShelves, () => setShelves([])) : Promise.resolve());
  useEffect(() => {
    void loadConnectors().then((list) => {
      // an app hub (Composio) nobody asked about yet: ask now, so its row can say "No apps picked yet"
      const unknown = list.filter((c) => c.linkedApps === null && c.auth?.signedIn);
      if (unknown.length) void Promise.all(unknown.map((c) => api("GET", `/api/connectors/${c.id}/linked-apps`).catch(() => {}))).then(() => loadConnectors());
      // back from an app's sign-in page: its page, now signed in
      if (signedIn === "ok") {
        let id: string | null = null;
        try {
          id = sessionStorage.getItem(CONNECTING);
          sessionStorage.removeItem(CONNECTING);
        } catch {
          /* private window */
        }
        if (id && list.some((c) => c.id === id)) setDetail({ kind: "connector", id });
      }
    });
    void loadSkills();
    void loadShelves();
    if (canEdit) api<Record<string, SignInOption>>("GET", `/api/connectors/sign-in?origin=${encodeURIComponent(location.origin)}`).then(setSignInOptions, () => {});
    api<{ skills: StoreSkill[]; errors: string[] }>("GET", "/api/skill-store").then(setStore, (e) => setStore({ skills: [], errors: [(e as Error).message] }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const searchGeneration = useRef(0);
  // the MCP Registry, searched on the hub (popular ones until someone types)
  useEffect(() => {
    // a word that names a whole section ("apps") isn't a search of the registry
    const query = sectionWord(q) ? "" : q.trim();
    // only the latest search may fill the list: an older, slower answer must not overwrite it
    const generation = ++searchGeneration.current;
    setMarket((m) => ({ ...m, entries: m.q === query ? m.entries : null, error: null }));
    const t = setTimeout(
      () =>
        api<{ entries: StoreApp[] }>("GET", `/api/marketplace?q=${encodeURIComponent(query)}`).then(
          (r) => {
            if (generation !== searchGeneration.current) return;
            setMarket({ q: query, entries: r.entries, error: null });
            if (!query) setFeatured(r.entries);
          },
          (e) => generation === searchGeneration.current && setMarket({ q: query, entries: [], error: (e as Error).message }),
        ),
      query ? 350 : 0,
    );
    return () => {
      searchGeneration.current++;
      clearTimeout(t);
    };
  }, [q, retry]);

  // another address closes what was open and opens its section
  useEffect(() => {
    setLocal(null);
    setSharing(null);
    setEditing(null);
    setExpanded(target ? [target] : []);
    setTopic(nextTopic.current ?? (section === "mods" ? "mods" : null));
    nextTopic.current = null;
    auto.current = true;
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = connectors !== null && skills !== null;
  const stopAuto = () => {
    auto.current = false;
  };
  useEffect(() => {
    if (!target || detail || !auto.current) return;
    document.getElementById(`add-${target}`)?.scrollIntoView({ block: "start" });
  }, [target, loaded, featured.length > 0, shelves.length > 0, store !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!modOn) return;
    const t = setTimeout(() => setModOn(null), 8000);
    return () => clearTimeout(t);
  }, [modOn]);

  // --- what was typed: words over every section, or one section by name ---
  const words = queryWords(q);
  const whole = sectionWord(q);
  const searching = words.length > 0;
  const hit = (sec: AddSection, ...fields: (string | null | undefined)[]) => (whole ? whole === sec : matchWords(words, fields));

  // --- apps ---
  /** Signs in with one click from here (until the hub says, a company's own sign-in is taken to work and Bubble AI's app with it not). */
  const connectsNow = (c: CatalogConnector) => !!c.signIn && (signInOptions[c.id]?.signIn ?? c.signIn.via === "mcp");
  /** Only signs in, and that sign-in isn't made yet: nothing to add it with today. */
  const comingSoon = (c: CatalogConnector) => !!signInOptions[c.id]?.soon && !signInOptions[c.id]?.key && !c.fields.length;
  // Bubble AI's own list knows its shelves; only chat and docs apps are told apart by name (Slack is chat, Drive is docs)
  const builtInItem = (c: CatalogConnector): AppItem => ({ key: `b:${c.id}`, name: c.name, description: c.description, category: c.recommended ? "Automation" : c.category === "Chat & docs" ? (appCategory(c) ?? BUILT_IN_SHELF[c.category]) : BUILT_IN_SHELF[c.category], who: "Bubble AI", builtIn: c });
  const registryItem = (e: StoreApp): AppItem => ({ key: `r:${e.id}`, name: e.name, description: e.description, category: e.category, who: e.publisher, registry: e });
  const haveConnector = (a: AppItem) => (connectors ?? []).find((c) => c.catalogId === ("registry" in a ? `registry:${a.registry.id}` : a.builtIn.id) || squash(c.name) === squash(a.name));
  const apps: AppItem[] = useMemo(() => {
    // Bubble AI's own one-click sign-in beats a registry entry of the same name (often someone else's server)
    const signsIn = new Set(CONNECTOR_CATALOG.filter((c) => c.signIn).map((c) => squash(c.name)));
    // the registry's answer to what was typed and, as the category and maker chips did, the well-known ones on that shelf or by that maker
    const shelf = searching && !whole ? featured.filter((e) => matchWords(words, [e.category, e.publisher])) : [];
    const seen = new Set<string>();
    const fromRegistry = [...(market.entries ?? []), ...shelf].filter((e) => !signsIn.has(squash(e.name)) && !seen.has(e.id) && !!seen.add(e.id)).map(registryItem);
    const names = new Set(fromRegistry.map((a) => squash(a.name)));
    // "Cloudflare token" or "Playwright browser" next to the real Cloudflare or Playwright app is the same thing twice
    const sameAs = (c: CatalogConnector) => names.has(squash(c.name)) || names.has(squash(c.name.replace(/\s+(token|keys?|browser)$/i, "")));
    const builtIn = CONNECTOR_CATALOG.filter((c) => !sameAs(c))
      .map(builtInItem)
      .filter((a) => hit("apps", a.name, a.description, a.category, a.who));
    // first the always-recommended one (Composio), then the apps that sign in with one click from here; last the ones whose sign-in is still to come
    const first = builtIn.filter((a) => "builtIn" in a && connectsNow(a.builtIn)).sort((a, b) => Number(!!("builtIn" in b && b.builtIn.recommended)) - Number(!!("builtIn" in a && a.builtIn.recommended)));
    const later = builtIn.filter((a) => "builtIn" in a && comingSoon(a.builtIn));
    return [...first, ...fromRegistry, ...builtIn.filter((a) => !first.includes(a) && !later.includes(a)), ...later];
  }, [market.entries, featured, q, signInOptions]); // eslint-disable-line react-hooks/exhaustive-deps
  const popular = POPULAR_APPS.map((id) => apps.find((a) => a.key === `r:${id}`)).filter((a): a is AppItem => !!a);
  /** The catalog's entry for an added app, when there is one. */
  const appFor = (c: Connector): AppItem | null => {
    const listed = apps.find((a) => haveConnector(a)?.id === c.id);
    if (listed) return listed;
    const builtIn = CONNECTOR_CATALOG.find((x) => x.id === c.catalogId);
    if (builtIn) return builtInItem(builtIn);
    const entry = c.catalogId?.startsWith("registry:") ? featured.find((e) => `registry:${e.id}` === c.catalogId) : undefined;
    return entry ? registryItem(entry) : null;
  };

  // --- the page an address opens ---
  const appByKey = (key: string): AppItem | null => {
    if (key.startsWith("b:")) {
      const c = CONNECTOR_CATALOG.find((x) => x.id === key.slice(2));
      return c ? builtInItem(c) : null;
    }
    const id = key.slice(2);
    const e = [...(market.entries ?? []), ...featured, ...(linked ? [linked] : [])].find((x) => x.id === id);
    return e ? registryItem(e) : null;
  };
  // m:<mod> is a mod's own page (Tasks while it's off lands there, not at the top of everything)
  const routeMod = appKey?.startsWith("m:") ? FEATURE_KEYS.find((k) => k === appKey.slice(2)) : undefined;
  const routeDetail: Detail | null = !routed || !appKey ? null : routeMod ? { kind: "mod", mod: routeMod } : appKey.startsWith("c:") ? { kind: "connector", id: appKey.slice(2) } : (() => {
    const a = appByKey(appKey);
    return a ? { kind: "app", app: a } : null;
  })();
  // a registry app linked to directly: look it up by name
  useEffect(() => {
    if (!routed || !appKey?.startsWith("r:") || routeDetail || linked?.id === appKey.slice(2)) return;
    const id = appKey.slice(2);
    let live = true;
    api<{ entries: StoreApp[] }>("GET", `/api/marketplace?q=${encodeURIComponent((id.split("/").pop() ?? id).replace(/[-_]+/g, " "))}`).then(
      (r) => live && setLinked(r.entries.find((e) => e.id === id) ?? null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [appKey, featured.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const detail: Detail | null = routeDetail ?? local;
  const listRoute = { view: "marketplace" as const, section: section === "mods" ? null : section, ...(forA ? { forAgent: forA.id } : {}) };
  /** Open an item's page: an app's at its own address, anything else in place. Null goes back to the list. */
  const setDetail = (d: Detail | null) => {
    if (routed && d && (d.kind === "app" || d.kind === "connector")) {
      setLocal(null);
      go({ ...listRoute, app: d.kind === "app" ? d.app.key : `c:${d.id}` });
      return;
    }
    if (routed && !d && appKey) go(listRoute);
    setLocal(d);
  };

  // --- skills ---
  const skillItems: SkillItem[] = useMemo(
    () => [
      ...SKILL_CATALOG.map((e) => ({ key: `w:${e.id}`, name: e.name, description: e.description, who: "Bubble AI", icon: <CatalogIcon name={e.icon} fallback={Wand2} size={20} />, bigIcon: <CatalogIcon name={e.icon} fallback={Wand2} size={26} />, library: e })),
      ...(store?.skills ?? []).map((s) => ({ key: `s:${s.id}`, name: s.name, description: s.description, who: s.source.label, icon: skillIcon(`${s.id} ${s.name}`, 20), bigIcon: skillIcon(`${s.id} ${s.name}`, 26), store: s })),
    ],
    [store],
  );
  const installedSkill = (s: SkillItem) => (skills ?? []).find((k) => k.catalogId === ("library" in s ? s.library.id : s.store.id));
  const skillTile = (s: Skill, size: number) => (catalogSkill(s.catalogId ?? "") ? <CatalogIcon name={catalogSkill(s.catalogId ?? "")!.icon} fallback={Wand2} size={size} /> : skillIcon(`${s.slug} ${s.name}`, size));
  const openSkill = (s: SkillItem) => {
    const have = installedSkill(s);
    if (have) setDetail({ kind: "skill", open: { skill: have }, icon: s.bigIcon });
    else if ("library" in s) setDetail({ kind: "skill", open: { entry: s.library }, icon: s.bigIcon });
    else setDetail({ kind: "store", skill: s.store, icon: s.bigIcon });
  };
  /** Add a skill for every agent, or for the one agent this was opened for (who can use it is on its page). `open` lands on its page. */
  async function addSkill(body: Record<string, string>, key: string, open = false) {
    setError(null);
    setAdding(key);
    try {
      const made = await api<Skill>("POST", "/api/skills", { ...body, ...who });
      if (!open) setKept((k) => [...k, key]);
      const list = await loadSkills();
      const got = list.find((x) => x.id === made.id);
      if (open && got) setDetail({ kind: "skill", open: { skill: got } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(null);
    }
  }

  // --- found on your computers ---
  const inWisp = (nodeId: string, i: ShelfItem) =>
    i.kind === "skill" ? (skills ?? []).some((s) => s.catalogId === deviceSkillId(nodeId, i) || s.slug === skillSlug(i.name)) : (connectors ?? []).some((c) => c.name.toLowerCase() === i.name.toLowerCase());
  const pending: Pending[] = shelves.flatMap((d) => d.items.filter((i) => !inWisp(d.nodeId, i)).map((i) => ({ device: d, item: i })));
  const foundKey = (p: Pending) => `f:${p.device.nodeId}:${p.item.key}`;
  const bringIn = (p: Pending, open = false) => {
    const { device: d, item: i } = p;
    if (i.kind === "skill") void addSkill({ nodeId: d.nodeId, harness: i.harness, skillId: i.key.split(":skill:")[1] ?? i.name }, foundKey(p), open);
    else setForm({ entry: shelfConnector(d.nodeId, i), presetEnv: i.env });
  };
  /** Everything found that needs nothing more, brought in for every agent; what needs a key stays, with "Set up". */
  async function bringAllIn() {
    const ready = pending.filter((p) => p.item.kind === "skill" || readyAsIs(p.item));
    if (!ready.length || !confirm(`Bring in ${shelfSummary(ready.map((p) => p.item))} for every agent?`)) return;
    setError(null);
    const failed: string[] = [];
    for (let n = 0; n < ready.length; n++) {
      setBringing(`${n + 1} of ${ready.length}`);
      const { device: d, item: i } = ready[n];
      try {
        if (i.kind === "skill") await api("POST", "/api/skills", { nodeId: d.nodeId, harness: i.harness, skillId: i.key.split(":skill:")[1] ?? i.name, agentIds: [], allAgents: true });
        else {
          const kind = i.transport === "http" ? "mcp-http" : "mcp-stdio";
          const catalogId = `device:${d.nodeId}:${i.harness}:${i.name}`;
          await api("POST", "/api/connectors", kind === "mcp-http" ? { kind, name: i.name, url: i.url, catalogId, agentIds: [], allAgents: true } : { kind, name: i.name, command: i.command, args: i.args ?? [], env: i.env ?? {}, catalogId, agentIds: [], allAgents: true });
        }
      } catch (e) {
        failed.push(`${i.name}: ${(e as Error).message}`);
      }
    }
    setBringing(null);
    if (failed.length) setError(failed.join(" · "));
    await Promise.all([loadSkills(), loadConnectors()]);
  }
  /** Ask every computer that's on to look through its harnesses again. */
  async function lookAgain() {
    setLooking(true);
    setError(null);
    try {
      await Promise.all(shelves.filter((d) => d.online).map((d) => api("POST", `/api/shelf/${d.nodeId}/refresh`)));
      await new Promise((r) => setTimeout(r, 2500));
      await loadShelves();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLooking(false);
    }
  }

  // --- added apps ---
  const connectorById = (id: string | null) => (id ? (connectors ?? []).find((c) => c.id === id) : undefined);
  async function signIn(c: Connector) {
    setError(null);
    try {
      const r = await api<{ url?: string }>("POST", `/api/connectors/${c.id}/signin`, { origin: location.origin });
      if (r.url) {
        try {
          sessionStorage.setItem(CONNECTING, c.id);
        } catch {
          /* private window */
        }
        location.href = r.url;
      } else void loadConnectors();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  /** Add a catalog app by signing in: the hub makes the connector (for every agent), the browser goes to the sign-in page. */
  async function connectBySignIn(e: CatalogConnector) {
    setError(null);
    try {
      const r = await api<{ url?: string; connectors: Connector[] }>("POST", "/api/connectors/connect", { catalogIds: [e.id], origin: location.origin, ...who });
      const id = r.connectors[0]?.id ?? "";
      try {
        sessionStorage.setItem(CONNECTING, id);
      } catch {
        /* private window */
      }
      if (r.url) location.href = r.url;
      else (setSignInEntry(null), void loadConnectors().then(() => id && setDetail({ kind: "connector", id })));
    } catch (err) {
      setSignInEntry(null);
      setError((err as Error).message);
    }
  }
  async function act(p: Promise<unknown>) {
    setError(null);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
    await loadConnectors();
  }
  const afterSave = async (c?: Connector) => {
    const editedExisting = !!form?.existing;
    setForm(null);
    await loadConnectors();
    if (!c || editedExisting) return;
    setDetail({ kind: "connector", id: c.id });
    if (c.auth?.required && !c.auth.signedIn) setSignInFor(c.id);
  };
  const refreshSkills = async (focus?: string) => {
    const list = await loadSkills();
    if (focus) {
      const s = list.find((x) => x.id === focus);
      setDetail(s ? { kind: "skill", open: { skill: s } } : null);
    }
  };
  const removeConnector = (c: Connector) => {
    if (!confirm(`Remove ${c.name}? Agents will lose access to it.`)) return;
    setDetail(null);
    void act(api("DELETE", `/api/connectors/${c.id}`));
  };
  /** Start adding an app: its sign-in, or the form that asks for its key. */
  function connect(app: AppItem, installIndex: number) {
    if ("builtIn" in app && signInOptions[app.builtIn.id]?.signIn) setSignInEntry(app.builtIn);
    else if ("builtIn" in app) setForm({ entry: app.builtIn });
    else {
      const install = app.registry.installs[installIndex] ?? app.registry.installs[0];
      if (install) setForm({ entry: registryCatalog(app.registry, install) });
    }
  }
  /** "Add" on an app's row. Its page comes first when there is something to weigh there: several ways to connect, nobody vouching for it, or no way to add it from here. */
  const addApp = (a: AppItem) => {
    const o = "builtIn" in a ? signInOptions[a.builtIn.id] : undefined;
    const stuck = "builtIn" in a && !!o && !o.signIn && !o.key && !a.builtIn.fields.length;
    const weigh = "registry" in a && (a.registry.installs.length > 1 || trustLabel(a.registry).kind === "unverified");
    if (stuck || weigh) setDetail({ kind: "app", app: a });
    else connect(a, 0);
  };

  // --- mods ---
  // an unlisted mod (Code) stays out while it is on, and shows once it is off, so "Code is turned off" always has a way back
  const mods = FEATURE_KEYS.filter((k) => !UNLISTED_FEATURES.includes(k) || !features[k]);
  async function setMod(k: FeatureKey, on: boolean) {
    setError(null);
    try {
      await setFeatures({ [k]: on });
      setModOn(on ? k : null);
    } catch (e) {
      setError(`Couldn't save that: ${(e as Error).message}`);
    }
  }

  // --- the rows (Connect apps, round 8): a 42 px tile, the name, one line, and Connect / ✓ Connected ---
  const lineTile = (icon: ReactNode) => <LineTile>{icon}</LineTile>;
  const connectorWords = (c: Connector) => {
    // an app hub (Composio) with nothing picked inside it yet says so, with Pick apps at the right
    if (noAppsPicked(c) && c.enabled && !needsSignIn(c)) return "No apps picked yet";
    const app = appFor(c);
    if (app) return app.description || app.category || "App";
    return c.catalogId?.startsWith("device:") ? `From ${harnessName(c.catalogId.split(":")[2])}` : "Your own app";
  };
  /** What an added app's row says at its right: ✓ Connected, Sign in again, or Off. */
  const connectedState = (c: Connector) =>
    needsSignIn(c) ? (
      <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[13px] text-muted">
        <NeedDot />
        Sign in again
      </span>
    ) : !c.enabled ? (
      <span className="shrink-0 pr-1 text-[13px] text-muted">Off</span>
    ) : noAppsPicked(c) ? null : (
      <Done word="Connected" />
    );
  /** Pick apps for an app hub with nothing picked inside it: a link of its own, so it sits outside the row's open button. */
  const pickApps = (c: Connector) => (c.enabled && !needsSignIn(c) && noAppsPicked(c) ? <PickApps connector={c} onBack={() => void loadConnectors()} /> : undefined);
  const addedApps: RowDef[] = [...(connectors ?? [])]
    // a sign-in that lapsed comes first
    .sort((a, b) => Number(needsSignIn(b)) - Number(needsSignIn(a)))
    .filter((c) => hit("added", c.name, c.url, c.command, connectorWords(c), "app"))
    .map((c) => ({ key: `c:${c.id}`, tile: <AppTile name={c.name} size={42} />, name: c.name, desc: connectorWords(c), status: connectedState(c), action: pickApps(c), onOpen: () => setDetail({ kind: "connector", id: c.id }) }));
  const addedRows: RowDef[] = [
    ...addedApps,
    ...(skills ?? [])
      .filter((s) => hit("added", s.name, s.description, skillOrigin(s), "skill"))
      .map((s) => ({ key: `k:${s.id}`, tile: lineTile(skillTile(s, 20)), name: s.name, desc: s.description || skillOrigin(s), status: <Done word="Added" />, onOpen: () => setDetail({ kind: "skill", open: { skill: s }, icon: skillTile(s, 26) }) })),
  ];

  const foundRows: RowDef[] = canEdit
    ? pending
        .filter((p) => hit("found", p.item.name, p.item.description, harnessName(p.item.harness), p.device.nodeName, p.item.kind === "skill" ? "skill" : "app"))
        .map((p) => {
          const i = p.item;
          const verb = i.kind === "mcp" && !readyAsIs(i) ? "Set up" : "Bring in";
          return {
            key: foundKey(p),
            tile: i.kind === "mcp" ? <AppTile name={i.name} size={42} /> : lineTile(skillIcon(i.name, 20)),
            name: i.kind === "skill" ? skillTitle(i.name) : i.name,
            desc: `${i.description ? `${i.description} · ` : ""}${harnessName(i.harness)} on ${p.device.nodeName}${p.device.online ? "" : " · offline"}`,
            action: (
              <GoPill onClick={() => bringIn(p)} disabled={adding === foundKey(p) || !!bringing} aria-label={`${verb} ${i.name}`}>
                {verb}
              </GoPill>
            ),
            onOpen: () => setDetail({ kind: "found", device: p.device, item: i }),
          };
        })
    : [];

  const recommended = (a: AppItem) => "builtIn" in a && !!a.builtIn.recommended;
  const appRow = (a: AppItem, why?: string): RowDef => {
    const have = haveConnector(a);
    const unverified = "registry" in a && trustLabel(a.registry).kind === "unverified";
    return {
      key: a.key,
      tile: <AppTile name={a.name} category={a.category} size={42} entry={"registry" in a ? a.registry : null} />,
      name: a.name,
      ...(recommended(a) ? { mark: "Recommended" } : {}),
      // nobody has confirmed who runs it: the row says so, quietly
      desc: why ?? (("builtIn" in a && a.builtIn.recommended) || [unverified ? "Not verified" : "", a.description || a.category || `By ${a.who}`].filter(Boolean).join(" · ")),
      topics: appTopics(a),
      ...(have
        ? { status: connectedState(have), action: pickApps(have), onOpen: () => setDetail({ kind: "connector", id: have.id }) }
        : "builtIn" in a && comingSoon(a.builtIn)
          ? { status: <span className="shrink-0 pr-1 text-[13px] text-muted">Coming soon</span>, onOpen: () => setDetail({ kind: "app", app: a }) }
          : {
              action: canEdit && (
                <GoPill onClick={() => addApp(a)} aria-label={`Connect ${a.name}`}>
                  Connect
                </GoPill>
              ),
              onOpen: () => setDetail({ kind: "app", app: a }),
            }),
    };
  };
  // the always-recommended one (Composio), then the well-known ones, then the rest
  const orderedApps = searching ? apps : [...apps.filter(recommended), ...popular, ...apps.filter((a) => !popular.includes(a) && !recommended(a))];
  const appRows: RowDef[] = orderedApps.map((a) => appRow(a));

  // --- Recommended: Composio first, then what the agent picked from what the person told it (PR 163) ---
  const picks = useAgentPicks();
  const picker = picks?.agentId ? agents.find((a) => a.id === picks.agentId) : undefined;
  const pickedApps = (picks?.apps ?? [])
    .filter((p) => !p.recommended)
    .map((p) => {
      const c = CONNECTOR_CATALOG.find((x) => x.id === p.id);
      return c ? { item: builtInItem(c), why: p.why } : null;
    })
    .filter((x): x is { item: AppItem; why: string } => !!x);
  const recRows: RowDef[] = [...apps.filter(recommended).map((a) => appRow(a)), ...pickedApps.map((p) => appRow(p.item, p.why))];
  const recKeys = new Set(recRows.map((r) => r.key));

  const freeSkills = skillItems.filter((s) => hit("skills", s.name, s.description, s.who));
  const skillRows: RowDef[] = (searching ? freeSkills : takeTurns(freeSkills)).map((s) => {
    const linkOnly = "store" in s && !s.store.license.open;
    const have = !!installedSkill(s);
    return {
      key: s.key,
      tile: lineTile(s.icon),
      name: s.name,
      desc: s.description || `From ${s.who}`,
      status: have ? <Done word="Added" /> : undefined,
      action:
        canEdit &&
        !have &&
        (linkOnly ? (
          <GoPill onClick={() => openSkill(s)} aria-label={`View ${s.name}`}>
            View
          </GoPill>
        ) : (
          <GoPill onClick={() => void addSkill("library" in s ? { catalogId: s.library.id } : { storeId: s.store.id }, s.key)} disabled={adding === s.key} aria-label={`Add ${s.name}`}>
            Add
          </GoPill>
        )),
      onOpen: () => openSkill(s),
    };
  });

  const modRow = (k: FeatureKey): RowDef => {
    const I = MOD_ICON[k];
    return {
      key: `m:${k}`,
      tile: lineTile(<I size={20} strokeWidth={1.7} />),
      name: FEATURE_INFO[k].name,
      desc: `A mod: ${MOD_WORDS[k].toLowerCase()}`,
      ...(features[k]
        ? { status: <Done word="On" /> }
        : {
            action: canEdit && (
              <GoPill onClick={() => void setMod(k, true)} disabled={!isOwner} title={isOwner ? undefined : "Only owners can change mods"} aria-label={`Add ${FEATURE_INFO[k].name}`}>
                Add
              </GoPill>
            ),
          }),
      onOpen: () => setDetail({ kind: "mod", mod: k }),
    };
  };
  // mods change the whole app, not one agent
  const modRows: RowDef[] = forA ? [] : mods.filter((k) => hit("mods", FEATURE_INFO[k].name, FEATURE_INFO[k].description, MOD_WORDS[k], "mod")).map(modRow);
  const macName = thisComputer();
  // This Mac: what the harnesses on your computers already have, and the Apple mod (Messages, Calendar, Reminders)
  const macRows: RowDef[] = [...foundRows, ...(canEdit && !forA && macName === "This Mac" && mods.includes("apple") && hit("found", FEATURE_INFO.apple.name, MOD_WORDS.apple, "mac") ? [modRow("apple")] : [])];

  const readyCount = pending.filter((p) => p.item.kind === "skill" || readyAsIs(p.item)).length;
  const canLook = shelves.some((d) => d.online);
  const macHead = (
    <>
      {(readyCount > 1 || !!bringing) && (
        <TextBtn className="-my-2 py-2 text-[13px]" onClick={() => void bringAllIn()} disabled={!!bringing}>
          {bringing ? `Bringing in ${bringing}` : "Bring all in"}
        </TextBtn>
      )}
      {canLook && (
        <TextBtn className="-my-2 py-2 text-[13px]" onClick={() => void lookAgain()} disabled={looking}>
          {looking ? "Looking" : "Look again"}
        </TextBtn>
      )}
    </>
  );
  const appsFoot = market.error && (
    <p className="col-span-full flex flex-wrap items-center gap-2 px-3 py-2 text-[13px] text-bad">
      {market.error}
      <TextBtn className="underline" onClick={() => setRetry((n) => n + 1)}>
        Try again
      </TextBtn>
    </p>
  );
  const skillsFoot = store?.errors.map((e) => (
    <p key={e} className="col-span-full px-3 py-1 text-[13px] text-muted">
      {e}
    </p>
  ));
  const appsSec = (rows: RowDef[], limit?: number): Sec => ({ id: "apps", title: "Apps", rows, loading: market.entries === null, limit, foot: appsFoot });
  const skillsSec = (limit?: number): Sec => ({ id: "skills", title: "Skills", rows: skillRows, loading: store === null, limit, foot: skillsFoot });
  // the Mac desktop app: what agents may use on this Mac, each with Allow (the chip is hidden elsewhere)
  const onMac = canEdit && !forA && isDesktopMac();
  const thisMac = useThisMacRows(onMac && section === "devices" && !q.trim());
  const macNote = onMac && <p className="col-span-full px-3 pt-2 text-[13px] leading-[18px] text-muted">Let your agents use these on this Mac. Nothing is shared until you click Allow.</p>;
  const macSec: Sec = { id: "found", title: macName, rows: macRows, head: macHead, empty: canEdit ? "Nothing new" : undefined };
  const thisMacSec: Sec = { id: "found", title: macName, rows: [...thisMac, ...macRows], head: macHead, foot: macNote || undefined, empty: canEdit ? "Nothing new" : undefined };
  const modsSec: Sec = { id: "mods", title: "Mods", rows: modRows, empty: forA ? "Mods change the whole app; add them for every agent." : undefined };
  const connectedSec: Sec = { id: "added", title: "Connected", rows: addedRows, loading: !loaded, empty: "Nothing connected yet" };
  // --- Agents and Teams: the templates, for every agent (not when adding to one agent, nor for guests) ---
  const templatesHere = canEdit && !forA;
  const agentList = templatesHere ? AGENT_TEMPLATES.filter((t) => !whole && (!searching || agentHit(words, t))) : [];
  // the person's own saved teams first, marked "yours"
  const teamList = templatesHere ? [...teamTemplates.all.filter((t) => teamTemplates.own.has(t.id)), ...teamTemplates.all.filter((t) => !teamTemplates.own.has(t.id))].filter((t) => !whole && (!searching || teamHit(words, t))) : [];
  const startAgent = (id: AgentTypeId) => {
    setAgentFrom(id);
    api<NodeInfo[]>("GET", "/api/nodes").then(setNodes, () => setNodes([]));
  };
  /** Use this team: the team builder with it loaded, drawn by the app itself so it sits over everything (the pop-up closes first). */
  const startTeam = (t: TeamTemplate) => {
    setTeamOpen(null);
    const open = () => useStore.setState({ channelBrowser: { sectionId: null, create: true, template: t } });
    if (!inPopup) return open();
    // the browser closes when the address changes: open it once the pop-up's address is gone
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      window.removeEventListener("hashchange", later);
      open();
    };
    const later = () => setTimeout(run, 0);
    window.addEventListener("hashchange", later);
    setTimeout(run, 400);
    inPopup.close();
  };
  const deleteTeam = (t: TeamTemplate) => {
    if (!confirm(`Delete ${t.name}? Teams already made from it stay.`)) return;
    teamTemplates.remove(t.id).catch((e) => setError((e as Error).message));
  };
  /** Agents (two to a line) and Teams (three), each with "Show all" on All. */
  const agentsSec = (limit?: number): Sec => ({
    id: "agents",
    title: "Agents",
    rows: [],
    head: limit && agentList.length > limit ? <ShowAll onClick={() => pickChip("agents")} /> : undefined,
    cards: agentList.length > 0 && <AgentCards list={agentList.slice(0, limit ?? agentList.length)} canEdit={canEdit} onUse={(t) => startAgent(t.id)} />,
  });
  const teamsSec = (limit?: number): Sec => ({
    id: "teams",
    title: "Teams",
    rows: [],
    head: limit && teamList.length > limit ? <ShowAll onClick={() => pickChip("teams")} /> : undefined,
    cards: teamList.length > 0 && <TeamCards list={teamList.slice(0, limit ?? teamList.length)} own={teamTemplates.own} canEdit={canEdit} onOpen={setTeamOpen} onDelete={deleteTeam} />,
  });
  // what shows: Connected; a search (one section by name, or Results over everything); a chip
  const chip: string = topic ?? (section === "mods" ? "mods" : section === "installed" ? "installed" : section);
  const sections: Sec[] = (() => {
    if (chip === "installed" && !searching) return [connectedSec];
    if (whole) return [({ added: connectedSec, found: macSec, apps: appsSec(appRows), skills: skillsSec(), mods: modsSec } as Record<AddSection, Sec>)[whole]];
    if (searching) {
      // apps someone added themselves (or brought in from a harness) aren't in the catalog: they show too
      const own = addedApps.filter((r) => !appFor(connectorById(r.key.slice(2))!));
      return [agentsSec(), teamsSec(), { id: "results", title: "Results", rows: [...macRows, ...appRows, ...own, ...skillRows, ...modRows], loading: market.entries === null || store === null }];
    }
    switch (chip) {
      case "apps":
        return [appsSec(appRows)];
      case "skills":
        return [skillsSec()];
      case "agents":
        return [agentsSec()];
      case "teams":
        return [teamsSec()];
      case "devices":
        return [onMac ? thisMacSec : macSec];
      case "mods":
        return [modsSec];
      case "all":
        return [
          // Agents and Teams near the top, before the apps (board 15): four agents, three teams
          agentsSec(4),
          teamsSec(3),
          { id: "recommended", title: "Recommended", note: picker && pickedApps.length ? `${picker.name} picked these from what you told it` : undefined, rows: recRows },
          macSec,
          appsSec(appRows.filter((r) => !recKeys.has(r.key)), 10),
          skillsSec(6),
        ];
      default: {
        const label = [...MAIN_CHIPS, ...MORE_CHIPS].find(([k]) => k === chip)?.[1] ?? "Apps";
        return [{ id: chip, title: label, rows: appRows.filter((r) => r.topics?.includes(chip as Topic)), loading: market.entries === null, empty: "Nothing here yet. Ask your agent to find one.", foot: appsFoot }];
      }
    }
  })();
  // a section shows when it has rows, is loading, or has something to say when empty (only when it is the one picked)
  const shownSections = sections.filter((s) => !!s.cards || s.rows.length > 0 || (s.loading && s.id !== "added") || (sections.length === 1 && (s.empty || s.foot)));
  const stillLoading = sections.some((s) => s.loading);
  const connectedCount = (connectors?.length ?? 0) + (skills?.length ?? 0);
  const stackLogos = connectedLogos(connectors ?? []);

  const row = (r: RowDef) => <ConnectRow key={r.key} tile={r.tile} name={r.name} mark={r.mark} desc={r.desc} status={r.status} action={r.action || undefined} onOpen={r.onOpen} />;
  const own = (icon: ReactNode, name: string, onOpen: () => void) => <ConnectRow tile={lineTile(icon)} name={name} onOpen={onOpen} />;
  const toSection = (id: MarketSection) => go({ view: "marketplace", section: id === "all" ? null : id, ...(forA ? { forAgent: forA.id } : {}) });
  const pickChip = (k: string) => {
    auto.current = false;
    setQ("");
    if (TOPICS.has(k)) {
      if (section !== "all") {
        nextTopic.current = k as Topic;
        toSection("all");
      } else setTopic(k as Topic);
      return;
    }
    setTopic(null);
    if (k !== section) toSection(k as MarketSection);
  };
  // another chip starts its list at the top (an address that names a section scrolls to it instead)
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target || chip !== section) listRef.current?.scrollTo({ top: 0 });
  }, [chip]); // eslint-disable-line react-hooks/exhaustive-deps
  const moreOn = MORE_CHIPS.find(([k]) => k === chip && !searching);
  const close = inPopup?.close ?? onBack;
  const closeBtn = close && (
    <button type="button" onClick={close} aria-label="Close" title="Close (Esc)" className="grid size-[34px] shrink-0 place-items-center rounded-full text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40">
      <X size={16} strokeWidth={2} />
    </button>
  );

  const list = (
    <>
      <div className="flex shrink-0 items-center gap-3 pl-[30px] pr-[22px] pt-6 max-md:pl-5 max-md:pr-3 max-md:pt-[max(1rem,env(safe-area-inset-top))]">
        <h1 className="min-w-0 flex-1 truncate text-[21px] font-semibold leading-7">Marketplace</h1>
        <button
          type="button"
          aria-pressed={chip === "installed" && !searching}
          onClick={() => (setQ(""), setTopic(null), toSection(section === "installed" ? "all" : "installed"))}
          className={cx("flex h-[30px] shrink-0 items-center gap-2 rounded-[9px] px-1.5 text-[13.5px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40", chip === "installed" && !searching ? "text-ink" : "text-muted")}
        >
          {/* phones keep the title whole: the logos show on wider screens */}
          <LogoStack logos={stackLogos} className="max-sm:hidden" />
          {connectedCount} connected
          <ChevronRight size={12} strokeWidth={2.2} aria-hidden />
        </button>
        {closeBtn}
      </div>
      {forA && (
        <div className="flex shrink-0 items-center gap-2 px-[30px] pt-2 text-[13px] text-muted max-md:px-5">
          <span className="min-w-0 flex-1 truncate">
            Adding to <span className="font-medium text-ink">{forA.name}</span>
          </span>
          <a href={href({ view: "agents", agentId: forA.id, tab: "apps" })} className="shrink-0 font-medium text-ink hover:underline">
            Done
          </a>
          <a href={href({ view: "marketplace", section: section === "mods" ? null : section })} className="shrink-0 hover:text-ink hover:underline">
            For every agent
          </a>
        </div>
      )}
      <div className="shrink-0 px-[30px] pt-4 max-md:px-5">
        <label className="r11-float-search flex h-10 items-center gap-[9px] rounded-[12px] bg-hover px-[13px] text-muted">
          <Search size={16} strokeWidth={1.8} aria-hidden className="shrink-0" />
          <input type="search" value={q} onChange={(e) => ((auto.current = false), setQ(e.target.value))} placeholder={templatesHere ? "Search apps, skills, agents and teams" : "Search apps and skills"} aria-label="Search the Marketplace" className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-muted md:text-[14.5px]" />
        </label>
        <nav aria-label="Filter" className="-mx-[30px] mt-3.5 flex gap-[7px] overflow-x-auto px-[30px] pb-1 [scrollbar-width:none] max-md:-mx-5 max-md:px-5">
          {MAIN_CHIPS.filter(([k]) => (k !== "agents" && k !== "teams") || templatesHere)
            .filter(([k]) => k !== "mods" || !forA)
            .map(([k, label]) => (
              <FilterChip key={k} on={!searching && chip === k} onClick={() => pickChip(k)}>
                {label}
              </FilterChip>
            ))}
          <Menu
            items={MORE_CHIPS.filter(([k]) => k !== "devices" || (canEdit && isDesktopMac())).map(([k, label]) => ({ label: k === "devices" ? macName : label, onSelect: () => pickChip(k) }))}
            trigger={(open, t) => (
              <FilterChip on={!!moreOn} onClick={t} aria-expanded={open} aria-haspopup="menu">
                {moreOn ? (moreOn[0] === "devices" ? macName : moreOn[1]) : "More"}
                <ChevronDown size={12} strokeWidth={2.2} aria-hidden />
              </FilterChip>
            )}
          />
        </nav>
      </div>
      {error && <p className="shrink-0 px-[30px] pt-2 text-[13px] text-bad max-md:px-5">{error}</p>}
      {signedIn && signedIn !== "ok" && <p className="shrink-0 px-[30px] pt-2 text-[13px] text-bad max-md:px-5">Sign-in didn't finish: {signedIn}</p>}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[max(1.5rem,env(safe-area-inset-bottom))] max-md:px-2 md:pb-24" onWheel={stopAuto} onTouchMove={stopAuto}>
        {shownSections.map((s) => {
          const open = expanded.includes(s.id) || !s.limit;
          const n = open ? s.rows.length : Math.min(s.rows.length, s.limit!);
          return (
            <section key={s.id} id={`add-${s.id}`} aria-label={s.title} className="scroll-mt-2">
              <div className="mx-3 mb-1.5 mt-[22px] flex items-baseline gap-2">
                <h2 className="text-[15px] font-semibold">{s.title}</h2>
                {s.note && <span className="min-w-0 truncate text-[13px] text-muted">{s.note}</span>}
                <span className="flex-1" />
                {s.head}
              </div>
              {s.cards ? (
                <div className="pt-1">{s.cards}</div>
              ) : (
                <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
                  {s.rows.slice(0, n).map(row)}
                  {s.foot}
                </div>
              )}
              {s.loading && !s.rows.length && <Loader />}
              {!s.loading && !s.rows.length && s.empty && !searching && <p className="px-3 py-2 text-[13px] text-muted">{s.empty}</p>}
              {s.rows.length > n && (
                <TextBtn className="mx-3 flex h-10 items-center text-left text-[13px]" onClick={() => setExpanded([...expanded, s.id])}>
                  Show all {s.rows.length}
                </TextBtn>
              )}
            </section>
          );
        })}
        {searching && !shownSections.some((s) => s.rows.length || s.cards) && !stillLoading && <p className="py-[60px] text-center text-[14px] text-muted">Nothing matches. Ask your agent to find it.</p>}
        {canEdit && !searching && (chip === "all" || chip === "apps" || chip === "skills") && (
          <section aria-label="Make or bring your own" className="mx-3 mt-4 border-t border-[var(--pop-line)]">
            <button type="button" aria-expanded={making} onClick={() => setMaking(!making)} className="flex h-[52px] w-full items-center text-left text-[14px] text-muted outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/40">
              <span className="flex-1">Make or bring your own</span>
              <ChevronRight size={14} aria-hidden className={cx(making && "rotate-90")} />
            </button>
            {making && (
              <div className="-mx-3 grid grid-cols-1 gap-x-4 md:grid-cols-2">
                {own(<Wand2 size={20} strokeWidth={1.7} />, "Create a skill", () => setEditing("new"))}
                {own(<Plug size={20} strokeWidth={1.7} />, "Add your own app", () => setForm({}))}
                {own(<Download size={20} strokeWidth={1.7} />, "Bring a skill in", () => setSharing("import"))}
                {!!skills?.length && own(<Share2 size={20} strokeWidth={1.7} />, "Share a skill", () => setSharing("pick"))}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );

  // an open item replaces the list
  const page = (() => {
    if (!detail) return appKey && routed ? (market.entries === null || !featured.length ? <Loader /> : <p className="text-[14px] text-muted">This app isn't here anymore.</p>) : null;
    if (detail.kind === "app" || detail.kind === "connector") {
      const have = detail.kind === "app" ? haveConnector(detail.app) : connectorById(detail.id);
      const app = detail.kind === "app" ? detail.app : have ? appFor(have) : null;
      if (!app && !have) return connectors === null ? <Loader /> : <p className="text-[14px] text-muted">This app isn't here anymore.</p>;
      const builtIn = app && "builtIn" in app ? app.builtIn : null;
      const option = builtIn ? signInOptions[builtIn.id] : undefined;
      // a key instead of the sign-in: before it's added, the same app set up with its key; after, a second copy that uses the key
      const useKey = !builtIn || !option?.key ? undefined : !have ? () => setForm({ entry: builtIn }) : builtIn.signIn && have.url === builtIn.signIn.url ? () => setForm({ entry: { ...builtIn, name: `${builtIn.name} key` } }) : undefined;
      return (
        <AppPage
          key={have?.id ?? app?.key}
          app={app}
          have={have}
          agents={agents}
          canEdit={canEdit}
          signIn={option}
          onAdd={(i) => app && connect(app, i)}
          onUseKey={useKey}
          onChanged={() => void loadConnectors()}
          onSignIn={(c) => void signIn(c)}
          onSignOut={(c) => void act(api("POST", `/api/connectors/${c.id}/signout`))}
          onEdit={(c) => setForm({ existing: c, entry: CONNECTOR_CATALOG.find((x) => x.id === c.catalogId) })}
          onToggle={(c) => void act(api("PATCH", `/api/connectors/${c.id}`, { enabled: !c.enabled }))}
          onRemove={removeConnector}
        />
      );
    }
    if (detail.kind === "store") return <StoreSkillDetail s={detail.skill} icon={detail.icon} canEdit={canEdit} onAdd={() => void addSkill({ storeId: detail.skill.id }, `s:${detail.skill.id}`, true)} />;
    if (detail.kind === "mod") return <ModPage mod={detail.mod} on={!!features[detail.mod]} isOwner={isOwner} onAdd={() => void setMod(detail.mod, true)} onRemove={() => void setMod(detail.mod, false)} />;
    if (detail.kind === "found") return <FoundPage found={detail} canEdit={canEdit} busy={adding === foundKey(detail)} onBring={() => bringIn(detail, true)} />;
    return (
      <SkillDetail
        open={detail.open}
        icon={detail.icon}
        agents={agents}
        canEdit={canEdit}
        onInstall={(e) => void addSkill({ catalogId: e.id }, `w:${e.id}`, true)}
        onEdit={(s) => setEditing(s)}
        onChanged={(id) => void refreshSkills(id)}
        onGone={() => setDetail(null)}
        onShare={(s) => setSharing(s)}
      />
    );
  })();

  const signInC = connectorById(signInFor);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {detail || (routed && appKey) ? (
        <>
          <div className="flex shrink-0 items-center gap-3 px-[22px] pt-5 max-md:px-4 max-md:pt-[max(1rem,env(safe-area-inset-top))]">
            <button type="button" className="grid size-[34px] place-items-center rounded-full text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Back to Marketplace" onClick={() => setDetail(null)}>
              <ChevronLeft size={20} aria-hidden />
            </button>
            <span className="flex-1" />
            {closeBtn}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]" onWheel={stopAuto} onTouchMove={stopAuto}>
            <div className="mx-auto w-full max-w-[592px] space-y-4 px-4 pt-2">
              {error && <p className="px-1 text-[13px] text-bad">{error}</p>}
              {page}
            </div>
          </div>
        </>
      ) : (
        list
      )}

      {form && (
        <ConnectorForm
          entry={form.entry}
          existing={form.existing}
          presetEnv={form.presetEnv}
          presetAgents={forA && !form.existing ? [forA.id] : undefined}
          title={form.title}
          agents={agents}
          taken={(connectors ?? []).filter((c) => c.id !== form.existing?.id).map((c) => c.name.toLowerCase())}
          onClose={() => setForm(null)}
          onSaved={(c) => void afterSave(c)}
        />
      )}
      {signInC && <ConnectSignIn connector={signInC} onClose={() => setSignInFor(null)} onSignIn={() => void signIn(signInC)} />}
      {signInEntry && (
        <ConnectSignIn
          connector={signInEntry}
          onClose={() => setSignInEntry(null)}
          onSignIn={() => void connectBySignIn(signInEntry)}
          onUseKey={signInOptions[signInEntry.id]?.key ? () => (setSignInEntry(null), setForm({ entry: signInEntry })) : undefined}
        />
      )}
      {sharing === "pick" && (
        <Dlg title="Share a skill" onClose={() => setSharing(null)}>
          <Panel className="max-h-80 overflow-y-auto">
            {(skills ?? []).map((s) => (
              <Item key={s.id} icon={<Tile size={36}>{skillTile(s, 17)}</Tile>} title={s.name} onClick={() => setSharing(s)} />
            ))}
          </Panel>
        </Dlg>
      )}
      {sharing && sharing !== "pick" && (
        <SkillShare
          skill={sharing === "import" ? null : sharing}
          agents={agents}
          canEdit={canEdit}
          onClose={() => setSharing(null)}
          onBrought={async (s) => {
            setSharing(null);
            await refreshSkills(s.id);
          }}
          onDevices={() => (setSharing(null), go({ view: "marketplace", section: "devices" }))}
        />
      )}
      {editing && (
        <SkillEditor
          skill={editing === "new" ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onShare={(s) => setSharing(s)}
          onSaved={async (s) => {
            setEditing(null);
            await refreshSkills(s.id);
          }}
        />
      )}
      {agentFrom && (
        <Suspense fallback={null}>
          <CreateAgent nodes={nodes} template={agentFrom} onClose={() => setAgentFrom(null)} />
        </Suspense>
      )}
      {teamOpen && <TeamSheet template={teamOpen} canEdit={canEdit} onClose={() => setTeamOpen(null)} onUse={() => startTeam(teamOpen)} />}
      {modOn && (
        <div role="status" className={`m-toast glass fixed bottom-6 right-6 ${LAYER.toast} flex w-[320px] items-center gap-2.5 rounded-[18px] py-3 pl-4 pr-3 max-md:inset-x-[18px] max-md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:right-auto max-md:w-auto`}>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">{FEATURE_INFO[modOn].name} on</span>
            <span className="block truncate text-[13px] text-muted">{modWhere(modOn)}</span>
          </span>
          {MOD_ROWS[modOn].some((r) => r.to) && (
            <Button
              variant="primary"
              onClick={() => {
                go(MOD_ROWS[modOn].find((r) => r.to)!.to!);
                setModOn(null);
              }}
            >
              Open
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A mod's page: what it is; Add while it is off; once on, the rows that lead to its own settings, and Remove. */
function ModPage({ mod, on, isOwner, onAdd, onRemove }: { mod: FeatureKey; on: boolean; isOwner: boolean; onAdd: () => void; onRemove: () => void }) {
  const [more, setMore] = useState(false);
  const I = MOD_ICON[mod];
  return (
    <div className="space-y-4">
      <ItemHead
        tile={
          <Tile size={56}>
            <I size={26} strokeWidth={1.7} />
          </Tile>
        }
        name={FEATURE_INFO[mod].name}
        line={`Mod · ${MOD_WORDS[mod]}`}
      >
        {!on && isOwner && (
          <Button variant="primary" onClick={onAdd}>
            Add
          </Button>
        )}
      </ItemHead>
      {!isOwner && <p className="px-1 text-[13px] text-muted">Only owners can change mods.</p>}
      <Rows>
        {on && MOD_ROWS[mod].map((r) => <FactRow key={r.label} label={r.label} value={r.value} href={r.to ? href(r.to) : undefined} />)}
        <FactRow label="More" onClick={() => setMore(!more)} open={more} />
      </Rows>
      {more && <p className="px-1 text-[14px] leading-[22px] text-muted">{FEATURE_INFO[mod].description}</p>}
      {on && isOwner && (
        <div className="pt-3">
          <RemoveBtn onClick={onRemove}>Remove</RemoveBtn>
        </div>
      )}
    </div>
  );
}

/** Something a harness on one of your computers already has: what it is, where it was found, and Bring in. */
function FoundPage({ found, canEdit, busy, onBring }: { found: Pending; canEdit: boolean; busy: boolean; onBring: () => void }) {
  const { device, item } = found;
  const app = item.kind === "mcp";
  return (
    <div className="space-y-4">
      <ItemHead tile={app ? <AppTile name={item.name} size={56} /> : <Tile size={56}>{skillIcon(item.name, 26)}</Tile>} name={app ? item.name : skillTitle(item.name)} line={`${app ? "App" : "Skill"} · in ${harnessName(item.harness)} on ${device.nodeName}`}>
        {canEdit && (
          <Button variant="primary" onClick={onBring} disabled={busy}>
            {app && !readyAsIs(item) ? "Set up" : "Bring in"}
          </Button>
        )}
      </ItemHead>
      <Rows>
        {item.description && <FactRow label="Does" value={item.description} wrap />}
        <FactRow label="Found at" value={item.path} wrap />
      </Rows>
    </div>
  );
}
